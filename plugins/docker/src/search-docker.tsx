/**
 * Docker containers, through the docker CLI.
 *
 * `docker ps --format '{{json .}}'` prints one JSON object per container; the
 * same CLI starts and stops them, and logs and shells open in a terminal
 * window. Works with podman via the executable preference. No network of our
 * own, no dependencies.
 */
import {
  Action,
  ActionPanel,
  Color,
  Icon,
  List,
  Toast,
  closeMainWindow,
  confirmAlert,
  getPreferenceValues,
  showToast,
  useExec
} from 'lumanin'
import { useMemo, useState } from 'react'
import { execFile, spawn } from 'node:child_process'
import { promisify } from 'node:util'

const run = promisify(execFile)

const CATEGORIES = [
  { id: 'running', title: 'Running' },
  { id: 'all', title: 'All Containers' }
] as const

interface Preferences {
  dockerBinary?: string
  terminal?: string
}

interface Container {
  /** The container id docker prints - the stable id of a row. */
  id: string
  name: string
  image: string
  state: string
  status: string
  ports: string
}

const dockerBinary = (): string => getPreferenceValues<Preferences>().dockerBinary?.trim() || 'docker'

const firstLine = (text: string): string => text.split('\n')[0]

/**
 * docker prints Ports as a string; podman emits an array of objects, which
 * String() would render as `[object Object]`. Format the host:container pairs
 * when they are there, otherwise leave the subtitle empty.
 */
function portsOf(value: unknown): string {
  if (typeof value === 'string') return value
  if (!Array.isArray(value)) return ''
  return value
    .map((entry) => {
      if (entry === null || typeof entry !== 'object') return ''
      const port = entry as Record<string, unknown>
      if (typeof port.host_port !== 'number' || typeof port.container_port !== 'number') return ''
      const proto = typeof port.protocol === 'string' ? '/' + port.protocol : ''
      return `${port.host_port}->${port.container_port}${proto}`
    })
    .filter((part) => part !== '')
    .join(', ')
}

function parseContainers(stdout: string | undefined): Container[] {
  const containers: Container[] = []
  for (const line of (stdout ?? '').split('\n')) {
    if (line.trim() === '') continue
    try {
      const row = JSON.parse(line) as Record<string, unknown>
      const id = row.Id ?? row.ID
      const names = Array.isArray(row.Names) ? row.Names[0] : row.Names
      const name = names ?? id
      containers.push({
        id: id != null ? String(id) : '',
        name: name != null ? String(name) : '',
        image: row.Image != null ? String(row.Image) : '',
        state: row.State != null ? String(row.State) : '',
        status: row.Status != null ? String(row.Status) : '',
        ports: portsOf(row.Ports)
      })
    } catch {
      // A non-JSON line is docker chatting on stdout; skip it.
    }
  }
  return containers.filter((c) => c.id !== '')
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
  const child = spawn(program, args, { detached: true, stdio: 'ignore' })
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

async function startContainer(container: Container, revalidate: () => void): Promise<void> {
  try {
    await run(dockerBinary(), ['start', container.id], { timeout: 15_000 })
    await showToast({ style: Toast.Style.Success, title: 'Started ' + container.name })
  } catch (error) {
    await showToast({
      style: Toast.Style.Failure,
      title: 'Could not start ' + container.name,
      message: String((error as Error).message ?? error)
    })
  }
  revalidate()
}

async function unpauseContainer(container: Container, revalidate: () => void): Promise<void> {
  try {
    await run(dockerBinary(), ['unpause', container.id], { timeout: 15_000 })
    await showToast({ style: Toast.Style.Success, title: 'Unpaused ' + container.name })
  } catch (error) {
    await showToast({
      style: Toast.Style.Failure,
      title: 'Could not unpause ' + container.name,
      message: String((error as Error).message ?? error)
    })
  }
  revalidate()
}

async function stopContainer(container: Container, revalidate: () => void): Promise<void> {
  const confirmed = await confirmAlert({
    title: 'Stop ' + container.name + '?',
    message: 'The container keeps its data and can be started again.'
  })
  if (!confirmed) return
  const toast = await showToast({ style: Toast.Style.Animated, title: 'Stopping ' + container.name })
  try {
    await run(dockerBinary(), ['stop', container.id], { timeout: 15_000 })
    toast.style = Toast.Style.Success
    toast.title = 'Stopped ' + container.name
  } catch (error) {
    toast.style = Toast.Style.Failure
    toast.title = 'Could not stop ' + container.name
    toast.message = String((error as Error).message ?? error)
  }
  revalidate()
}

/**
 * A terminal running `sh` in an image without one closes before it is seen,
 * so probe for the shell first. The probe fails three ways, and each gets its
 * own title: the timeout killed it (the container did not answer), docker
 * refused because the container is not running (it stopped since the list was
 * drawn), or the image really has no shell.
 */
async function shellInto(container: Container): Promise<void> {
  try {
    await run(dockerBinary(), ['exec', container.id, 'sh', '-c', 'exit 0'], { timeout: 5000 })
  } catch (error) {
    const said = firstLine(String((error as Error).message ?? error))
    const stderr = String((error as { stderr?: string }).stderr ?? '')
    const title =
      (error as { killed?: boolean }).killed === true
        ? container.name + ' did not answer'
        : /is not running|not running|is paused/i.test(stderr + said)
          ? container.name + ' is not running'
          : 'No shell in ' + container.name
    await showToast({ style: Toast.Style.Failure, title, message: said })
    return
  }
  openInTerminal([dockerBinary(), 'exec', '-it', container.id, 'sh'])
}

export default function SearchDocker(props: {
  launchContext?: { category?: unknown }
}): React.JSX.Element {
  const requested = props.launchContext?.category
  const [category, setCategory] = useState(
    typeof requested === 'string' && CATEGORIES.some((entry) => entry.id === requested)
      ? requested
      : 'running'
  )
  const args = category === 'all' ? ['ps', '-a', '--format', '{{json .}}'] : ['ps', '--format', '{{json .}}']
  const { isLoading, data, error, revalidate } = useExec(dockerBinary(), args, { timeout: 30_000 })
  const containers = useMemo(() => parseContainers(data), [data])
  const missing = (error as NodeJS.ErrnoException | undefined)?.code === 'ENOENT'
  const errorTitle = missing ? dockerBinary() + ' is not installed or not on PATH' : 'Docker did not answer'
  const errorDescription = (message: string): string =>
    missing
      ? firstLine(message)
      : firstLine(message) + '\nIs the docker daemon running, and is your user in the docker group?'

  const rows = useMemo(
    () =>
      containers.map((container) => {
        const paused = container.state === 'paused'
        const running = container.state === 'running' || container.state === 'restarting'
        return (
          <List.Item
            key={container.id}
            id={container.id}
            title={container.name}
            subtitle={container.image + (container.ports ? '  ' + container.ports : '')}
            icon="system:docker,utilities-terminal"
            accessories={[
              running
                ? { tag: { value: container.status, color: Color.Green } }
                : { tag: { value: container.status } }
            ]}
            actions={
              <ActionPanel>
                <ActionPanel.Section>
                  {paused ? (
                    <Action
                      title="Unpause Container"
                      icon={Icon.Play}
                      onAction={() => void unpauseContainer(container, revalidate)}
                    />
                  ) : running ? (
                    <Action
                      title="Stop Container"
                      icon={Icon.Stop}
                      onAction={() => void stopContainer(container, revalidate)}
                    />
                  ) : (
                    <Action
                      title="Start Container"
                      icon={Icon.Play}
                      onAction={() => void startContainer(container, revalidate)}
                    />
                  )}
                </ActionPanel.Section>
                <ActionPanel.Section>
                  {/* Logs in every state, but honest about which kind: following a
                      container that is not running would wait for nothing. A bounded
                      read is what reading why it died needs; a terminal emulator
                      that closes when its command exits will close when the log ends. */}
                  {running ? (
                    <Action
                      title="Follow Logs in Terminal"
                      icon={Icon.Terminal}
                      shortcut={{ modifiers: ['cmd'], key: 'l' }}
                      onAction={() => openInTerminal([dockerBinary(), 'logs', '-f', container.id])}
                    />
                  ) : (
                    <Action
                      title="Show Logs in Terminal"
                      icon={Icon.Terminal}
                      shortcut={{ modifiers: ['cmd'], key: 'l' }}
                      onAction={() => openInTerminal([dockerBinary(), 'logs', '--tail', '500', container.id])}
                    />
                  )}
                  {/* `docker exec` cannot enter a created, exited, dead or paused
                      container, so the action is offered only where it can work. */}
                  {running && (
                    <Action
                      title="Shell into Container"
                      icon={Icon.Code}
                      shortcut={{ modifiers: ['cmd'], key: 's' }}
                      onAction={() => void shellInto(container)}
                    />
                  )}
                  <Action.CopyToClipboard
                    title="Copy Container Id"
                    content={container.id}
                    shortcut={{ modifiers: ['cmd'], key: 'c' }}
                  />
                </ActionPanel.Section>
              </ActionPanel>
            }
          />
        )
      }),
    [containers, revalidate]
  )

  return (
    <List
      isLoading={isLoading}
      searchBarPlaceholder="Search containers"
      searchBarAccessory={
        <List.Dropdown tooltip="Category" value={category} onChange={setCategory}>
          {CATEGORIES.map((cat) => (
            <List.Dropdown.Item key={cat.id} value={cat.id} title={cat.title} />
          ))}
        </List.Dropdown>
      }
    >
      {rows}
      <List.EmptyView
        icon={Icon.Box}
        title={error ? errorTitle : 'No containers'}
        description={
          error
            ? errorDescription(String(error.message ?? error))
            : category === 'running'
              ? 'Nothing is running; switch the dropdown to All Containers for stopped ones.'
              : 'docker ps -a found nothing on this machine.'
        }
      />
    </List>
  )
}
