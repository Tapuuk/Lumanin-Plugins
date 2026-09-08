/**
 * tmux sessions and windows, straight from the running server.
 *
 * Listing is `tmux list-sessions` / `list-windows` with a tab-separated
 * format string; attaching opens a terminal window running `tmux attach`.
 * No network, no dependencies.
 */
import {
  Action,
  ActionPanel,
  Color,
  Form,
  Icon,
  List,
  Toast,
  clearSearchBar,
  closeMainWindow,
  confirmAlert,
  getPreferenceValues,
  showToast,
  useExec,
  useNavigation
} from 'lumanin'
import { useState } from 'react'
import { execFile, spawn } from 'node:child_process'
import { promisify } from 'node:util'

const run = promisify(execFile)

const CATEGORIES = [
  { id: 'sessions', title: 'Sessions' },
  { id: 'windows', title: 'Windows' }
] as const

interface Preferences {
  tmuxBinary?: string
  terminal?: string
}

interface Session {
  /** tmux session id ($N) - the stable id of a row and every -t target. */
  id: string
  name: string
  windows: number
  attached: boolean
  /** Epoch milliseconds, parsed once so a row does not do arithmetic to render. */
  created: number
}

interface Window {
  /** tmux window id (@N) - the stable id of a row and every -t target. */
  id: string
  sessionId: string
  session: string
  index: string
  /** session:index, for display only. */
  label: string
  name: string
  active: boolean
}

const tmuxBinary = (): string => getPreferenceValues<Preferences>().tmuxBinary?.trim() || 'tmux'

const SESSION_FORMAT = '#{session_id}\t#{session_name}\t#{session_windows}\t#{session_attached}\t#{session_created}'
const WINDOW_FORMAT =
  '#{session_id}\t#{window_id}\t#{session_name}\t#{window_index}\t#{window_active}\t#{window_name}'

/**
 * Both parsers run inside `useExec`, so the cache on disk holds the rows rather
 * than tmux's raw output. No server running is a normal state, not an error
 * card; a missing binary or any other failure is thrown so the hook's `error`
 * is set and the view can say what happened instead of claiming an empty list.
 */
type Outcome = { stdout: string; stderr: string; error?: Error; exitCode: number | null }

/** tmux 3.7 says "error connecting to <socket> (No such file or directory)"; older ones "no server running". */
const NO_SERVER = /no server running|error connecting to .*No such file or directory/i

function failed(outcome: Outcome, what: string): boolean {
  // Rethrown untouched: wrapping it would lose `code === 'ENOENT'`.
  if (outcome.error) throw outcome.error
  if (outcome.exitCode === 0) return false
  if (NO_SERVER.test(outcome.stderr)) return true
  throw new Error(outcome.stderr.trim() || what + ' exited with code ' + String(outcome.exitCode))
}

function parseSessions(outcome: Outcome): Session[] {
  if (failed(outcome, 'tmux list-sessions')) return []
  const sessions: Session[] = []
  for (const line of outcome.stdout.split('\n')) {
    if (line.trim() === '') continue
    const [id, name, windows, attached, created] = line.split('\t')
    sessions.push({
      id,
      name,
      windows: Number(windows),
      attached: attached !== '0',
      created: Number(created) * 1000
    })
  }
  return sessions
}

function parseWindows(outcome: Outcome): Window[] {
  if (failed(outcome, 'tmux list-windows')) return []
  const windows: Window[] = []
  for (const line of outcome.stdout.split('\n')) {
    if (line.trim() === '') continue
    // #{window_name} is last and unsplit: a program can put a tab in a
    // window title (directly, or via an escape sequence), which would
    // otherwise shift the fixed fields after it.
    const fields = line.split('\t')
    const [sessionId, id, session, index, active] = fields
    const name = fields.slice(5).join('\t')
    windows.push({
      id,
      sessionId,
      session,
      index,
      label: session + ':' + index,
      name,
      active: active === '1'
    })
  }
  return windows
}

function openInTerminal(argv: string[]): void {
  const pref = getPreferenceValues<Preferences>().terminal?.trim()
  const command = pref || process.env.TERMINAL || 'xdg-terminal-exec'
  const parts = command.split(/\s+/)
  const program = parts[0]
  const base = program.split('/').pop() ?? program
  let args: string[]
  if (base === 'xdg-terminal-exec') args = [...parts.slice(1), ...argv]
  else if (base === 'gnome-terminal') args = [...parts.slice(1), '--', ...argv]
  else if (base === 'xfce4-terminal' || base === 'mate-terminal' || base === 'terminator')
    args = [...parts.slice(1), '-x', ...argv]
  else if (base === 'wezterm') args = [...parts.slice(1), 'start', '--', ...argv]
  else args = [...parts.slice(1), '-e', ...argv]
  // A daemon started inside tmux passes TMUX on, and attach then refuses to nest.
  const env = { ...process.env }
  delete env.TMUX
  const child = spawn(program, args, { detached: true, stdio: 'ignore', env })
  child.on('error', () => {
    void showToast({
      style: Toast.Style.Failure,
      title: 'Could not open ' + program,
      message: 'Set Terminal Command in lumanin plugins'
    })
  })
  child.once('spawn', () => void closeMainWindow())
  child.unref()
}

async function killSession(session: Session, revalidate: () => void): Promise<void> {
  const confirmed = await confirmAlert({
    title: 'Kill session ' + session.name + '?',
    message: 'Every process running inside it ends. This cannot be undone.'
  })
  if (!confirmed) return
  try {
    await run(tmuxBinary(), ['kill-session', '-t', session.id], { timeout: 5_000 })
    await showToast({ style: Toast.Style.Success, title: 'Killed ' + session.name })
  } catch (error) {
    await showToast({
      style: Toast.Style.Failure,
      title: 'Could not kill ' + session.name,
      message: String((error as Error).message ?? error)
    })
  }
  revalidate()
}

function NewSessionForm(props: { onDone: () => void }): React.JSX.Element {
  const { pop } = useNavigation()
  const [nameError, setNameError] = useState<string | undefined>()

  return (
    <Form
      actions={
        <ActionPanel>
          <Action.SubmitForm
            title="Create Session"
            icon={Icon.Plus}
            onSubmit={async (values: { name: string; attach: boolean }) => {
              const name = values.name.trim()
              if (name === '' || name.includes('#(') || name.includes('#{')) {
                setNameError('A session name cannot contain #( or #{')
                return
              }
              let id: string
              try {
                const { stdout } = await run(
                  tmuxBinary(),
                  ['new-session', '-d', '-P', '-F', '#{session_id}', '-s', name],
                  { timeout: 5_000 }
                )
                id = stdout.trim()
              } catch (error) {
                setNameError(String((error as Error).message ?? error))
                return
              }
              await showToast({ style: Toast.Style.Success, title: 'Created ' + name })
              pop()
              props.onDone()
              if (values.attach) openInTerminal([tmuxBinary(), 'attach', '-t', id])
            }}
          />
        </ActionPanel>
      }
    >
      <Form.TextField
        autoFocus
        id="name"
        title="Name"
        placeholder="work"
        error={nameError}
        onChange={() => setNameError(undefined)}
      />
      <Form.Checkbox id="attach" label="Attach in a terminal right away" defaultValue={true} />
    </Form>
  )
}

export default function SearchTmux(props: {
  launchContext?: { category?: unknown }
}): React.JSX.Element {
  const requested = props.launchContext?.category
  const [category, setCategory] = useState(
    typeof requested === 'string' && CATEGORIES.some((entry) => entry.id === requested)
      ? requested
      : 'sessions'
  )
  const { push } = useNavigation()
  // Two calls rather than one function running them in turn: they are
  // independent, so they run at once, and each caches its own parsed rows.
  const sessionList = useExec(tmuxBinary(), ['list-sessions', '-F', SESSION_FORMAT], {
    parseOutput: parseSessions,
    timeout: 5_000
  })
  const windowList = useExec(tmuxBinary(), ['list-windows', '-a', '-F', WINDOW_FORMAT], {
    parseOutput: parseWindows,
    timeout: 5_000,
    execute: category === 'windows'
  })
  const isLoading = sessionList.isLoading || windowList.isLoading
  const error = sessionList.error ?? (category === 'windows' ? windowList.error : undefined)
  const missing = (error as NodeJS.ErrnoException | undefined)?.code === 'ENOENT'
  const errorTitle = missing ? tmuxBinary() + ' is not installed or not on PATH' : 'tmux did not answer'
  const errorDescription = error ? String(error.message ?? error).split('\n')[0] : ''
  const sessions = Array.isArray(sessionList.data) ? sessionList.data : []
  const windows = Array.isArray(windowList.data) ? windowList.data : []
  const revalidate = (): void => {
    void sessionList.revalidate().catch(() => undefined)
    if (category === 'windows') void windowList.revalidate().catch(() => undefined)
  }

  const newSession = (
    <Action
      title="New Session"
      icon={Icon.Plus}
      shortcut={{ modifiers: ['cmd'], key: 'n' }}
      onAction={() => {
        push(<NewSessionForm onDone={revalidate} />)
        void clearSearchBar()
      }}
    />
  )

  return (
    <List
      isLoading={isLoading}
      searchBarPlaceholder="Search tmux sessions"
      searchBarAccessory={
        <List.Dropdown tooltip="Category" value={category} onChange={setCategory}>
          {CATEGORIES.map((cat) => (
            <List.Dropdown.Item key={cat.id} value={cat.id} title={cat.title} />
          ))}
        </List.Dropdown>
      }
    >
      {category === 'sessions'
        ? sessions.map((session) => (
            <List.Item
              key={session.id}
              id={session.id}
              title={session.name}
              subtitle={session.windows === 1 ? '1 window' : String(session.windows) + ' windows'}
              icon="system:utilities-terminal"
              accessories={[
                ...(session.attached ? [{ tag: { value: 'attached', color: Color.Green } }] : []),
                { date: new Date(session.created) }
              ]}
              actions={
                <ActionPanel>
                  <ActionPanel.Section>
                    <Action
                      title="Attach in Terminal"
                      icon={Icon.Terminal}
                      onAction={() => openInTerminal([tmuxBinary(), 'attach', '-t', session.id])}
                    />
                  </ActionPanel.Section>
                  <ActionPanel.Section>
                    {newSession}
                    <Action
                      title="Kill Session"
                      icon={Icon.Trash}
                      shortcut={{ modifiers: ['cmd'], key: 'x' }}
                      onAction={() => void killSession(session, revalidate)}
                    />
                    <Action.CopyToClipboard
                      title="Copy Session Name"
                      content={session.name}
                      shortcut={{ modifiers: ['cmd'], key: 'c' }}
                    />
                  </ActionPanel.Section>
                </ActionPanel>
              }
            />
          ))
        : windows.map((window) => (
            <List.Item
              key={window.id}
              id={window.id}
              title={window.name}
              subtitle={window.label}
              keywords={[window.session, window.index, window.label]}
              icon="system:utilities-terminal"
              accessories={window.active ? [{ tag: { value: 'active', color: Color.Green } }] : []}
              actions={
                <ActionPanel>
                  <ActionPanel.Section>
                    <Action
                      title="Attach to Window"
                      icon={Icon.Terminal}
                      onAction={() =>
                        openInTerminal([
                          tmuxBinary(),
                          'attach',
                          '-t',
                          window.sessionId,
                          ';',
                          'select-window',
                          '-t',
                          window.id
                        ])
                      }
                    />
                  </ActionPanel.Section>
                  <ActionPanel.Section>{newSession}</ActionPanel.Section>
                </ActionPanel>
              }
            />
          ))}
      <List.EmptyView
        icon={Icon.Terminal}
        title={error ? errorTitle : 'No tmux sessions'}
        description={
          error ? errorDescription : 'Press Ctrl+N to create one, or run tmux new -s work in a terminal.'
        }
        // No offer to create a session through a binary that just failed.
        actions={
          error ? undefined : (
            <ActionPanel>
              <ActionPanel.Section>{newSession}</ActionPanel.Section>
            </ActionPanel>
          )
        }
      />
    </List>
  )
}
