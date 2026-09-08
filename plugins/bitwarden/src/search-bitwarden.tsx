/**
 * Your Bitwarden vault, through the bw CLI.
 *
 * Everything comes from `bw list items` against the vault you unlocked; the
 * session token preference is handed to bw in the BW_SESSION environment
 * variable and never leaves the machine. Nothing from the vault is written to
 * disk. A copied secret is cleared from the clipboard after 30 seconds,
 * unless you copied something else in the meantime. No network of our own,
 * no dependencies.
 */
import {
  Action,
  ActionPanel,
  Clipboard,
  Icon,
  List,
  Toast,
  getPreferenceValues,
  showToast,
  usePromise
} from 'lumanin'
import { useMemo, useRef, useState } from 'react'
import { execFile, spawn } from 'node:child_process'
import { statSync } from 'node:fs'
import { join } from 'node:path'
import { promisify } from 'node:util'

const run = promisify(execFile)

// A large vault easily outgrows execFile's 1 MB default buffer.
const MAX_BUFFER = 10 * 1024 * 1024

const CATEGORIES = [
  { id: 'logins', title: 'Logins' },
  { id: 'cards', title: 'Cards' },
  { id: 'notes', title: 'Secure Notes' }
] as const

interface Preferences {
  bwBinary?: string
  sessionToken?: string
}

/** bw item types: 1 login, 2 secure note, 3 card, 4 identity. */
const TYPE_OF_CATEGORY: Record<string, number> = { logins: 1, cards: 3, notes: 2 }

interface Item {
  id: string
  name: string
  type: number
  login?: { username?: string; password?: string; totp?: string }
  card?: { brand?: string; number?: string }
  notes?: string
}

const bwBinary = (): string => getPreferenceValues<Preferences>().bwBinary?.trim() || 'bw'

/** The session token goes to bw as BW_SESSION, never on argv. */
function sessionEnv(): NodeJS.ProcessEnv {
  const session = getPreferenceValues<Preferences>().sessionToken?.trim()
  return session ? { ...process.env, BW_SESSION: session } : { ...process.env }
}

async function loadItems(signal: AbortSignal | undefined): Promise<Item[]> {
  let stdout: string
  try {
    ;({ stdout } = await run(bwBinary(), ['list', 'items', '--nointeraction'], {
      env: sessionEnv(),
      maxBuffer: MAX_BUFFER,
      timeout: 30_000,
      ...(signal === undefined ? {} : { signal })
    }))
  } catch (error) {
    if ((error as Error)?.name === 'AbortError') throw error
    throw new Error(said(error))
  }
  return (JSON.parse(stdout) as Item[]).filter((item) => typeof item.id === 'string')
}

/** What bw printed to stderr, or the error's own message when it printed nothing. */
function said(error: unknown): string {
  const stderr = (error as { stderr?: string }).stderr?.trim()
  return stderr || String((error as Error)?.message ?? error)
}

const CLEAR_AFTER_MS = 30000

function onPath(names: readonly string[]): string | null {
  const path = process.env['PATH'] ?? ''
  for (const name of names) {
    for (const directory of path.split(':')) {
      if (directory.length === 0) continue
      const candidate = join(directory, name)
      try {
        if (statSync(candidate).isFile()) return candidate
      } catch {
        continue
      }
    }
  }
  return null
}

let clearToolProbe: 'wl' | 'x' | null | undefined

/**
 * The tool the clear script will use, decided the way the script decides it.
 * Probed once per worker: it is a PATH walk of synchronous stats, and it sits
 * on the copy path.
 */
function clearTool(): 'wl' | 'x' | null {
  if (clearToolProbe !== undefined) return clearToolProbe
  if (process.env['WAYLAND_DISPLAY'] && onPath(['wl-paste']) !== null && onPath(['wl-copy']) !== null)
    clearToolProbe = 'wl'
  else clearToolProbe = onPath(['xclip']) !== null ? 'x' : null
  return clearToolProbe
}

/**
 * Clear the clipboard 30 s from now even if this worker is long gone: the
 * session closing must not leave a password behind. A detached shell gets the
 * secret on stdin (never argv, argv is world-readable), sleeps, and clears
 * only if the clipboard still holds that exact value. The tool is chosen by
 * the session type, not by what happens to be installed, and a failing
 * wl-paste falls through to xclip.
 */
function scheduleClear(value: string): void {
  const script =
    'v=$(cat); sleep 30; tool=; ' +
    'if [ -n "$WAYLAND_DISPLAY" ] && command -v wl-paste >/dev/null 2>&1; then ' +
    'if cur=$(wl-paste 2>/dev/null); then tool=wl; fi; fi; ' +
    'if [ -z "$tool" ] && command -v xclip >/dev/null 2>&1; then ' +
    'cur=$(xclip -selection clipboard -o 2>/dev/null || true); tool=x; fi; ' +
    '[ -n "$tool" ] || exit 0; ' +
    '[ "$cur" = "$v" ] || exit 0; ' +
    'if [ "$tool" = wl ]; then wl-copy --clear 2>/dev/null; else printf "" | xclip -selection clipboard 2>/dev/null; fi'
  try {
    const child = spawn('sh', ['-c', script], { detached: true, stdio: ['pipe', 'ignore', 'ignore'] })
    child.stdin?.end(value)
    child.unref()
  } catch {
    // No shell to hand off to; the in-worker timer below is the fallback.
  }
}

/** Copy a secret and clear it after 30 s - unless the clipboard moved on. */
async function copySecret(label: string, value: string | undefined): Promise<void> {
  if (value === undefined || value === '') {
    await showToast({ style: Toast.Style.Failure, title: 'This item has no ' + label })
    return
  }
  const tool = clearTool()
  await Clipboard.copy(value, { concealed: true })
  scheduleClear(value)
  void showToast({
    style: Toast.Style.Success,
    title: 'Copied ' + label,
    message:
      tool !== null
        ? 'Clears in 30 seconds'
        : 'Not cleared automatically. Install ' + (process.env['WAYLAND_DISPLAY'] ? 'wl-clipboard' : 'xclip')
  })
  setTimeout(() => {
    void (async () => {
      const current = await Clipboard.readText().catch(() => undefined)
      if (current === value) await Clipboard.clear()
    })()
  }, CLEAR_AFTER_MS)
}

async function copyTotp(item: Item): Promise<void> {
  try {
    const { stdout } = await run(bwBinary(), ['get', 'totp', item.id, '--nointeraction'], {
      env: sessionEnv(),
      maxBuffer: MAX_BUFFER,
      timeout: 15_000
    })
    await copySecret('one-time code', stdout.trim())
  } catch (error) {
    await showToast({
      style: Toast.Style.Failure,
      title: 'Could not get one-time code for ' + item.name,
      message: said(error)
    })
  }
}

async function syncVault(revalidate: () => void): Promise<void> {
  const toast = await showToast({ style: Toast.Style.Animated, title: 'Syncing vault' })
  try {
    await run(bwBinary(), ['sync', '--nointeraction'], {
      env: sessionEnv(),
      maxBuffer: MAX_BUFFER,
      timeout: 60_000
    })
    toast.style = Toast.Style.Success
    toast.title = 'Vault synced'
  } catch (error) {
    toast.style = Toast.Style.Failure
    toast.title = 'Sync failed'
    toast.message = said(error)
  }
  revalidate()
}

export default function SearchBitwarden(props: {
  launchContext?: { category?: unknown }
}): React.JSX.Element {
  const requested = props.launchContext?.category
  const [category, setCategory] = useState(
    typeof requested === 'string' && CATEGORIES.some((entry) => entry.id === requested)
      ? requested
      : 'logins'
  )
  const abortable = useRef<AbortController | null>(null)
  const { isLoading, data, error, revalidate } = usePromise(
    () => loadItems(abortable.current?.signal),
    [],
    { abortable }
  )
  const syncAction = useMemo(
    () => (
      <ActionPanel.Section>
        <Action
          title="Sync Vault"
          icon={Icon.ArrowClockwise}
          shortcut={{ modifiers: ['cmd'], key: 'r' }}
          onAction={() => void syncVault(revalidate)}
        />
      </ActionPanel.Section>
    ),
    [revalidate]
  )

  const wanted = TYPE_OF_CATEGORY[category] ?? 1
  const rows = useMemo(() => (data ?? []).filter((item) => item.type === wanted), [data, wanted])

  return (
    <List
      isLoading={isLoading}
      searchBarPlaceholder="Search your vault"
      searchBarAccessory={
        <List.Dropdown tooltip="Category" value={category} onChange={setCategory}>
          {CATEGORIES.map((cat) => (
            <List.Dropdown.Item key={cat.id} value={cat.id} title={cat.title} />
          ))}
        </List.Dropdown>
      }
    >
      {rows.map((item) => (
        <List.Item
          key={item.id}
          id={item.id}
          title={item.name}
          subtitle={
            item.type === 1 ? (item.login?.username ?? '') : item.type === 3 ? (item.card?.brand ?? '') : ''
          }
          icon={item.type === 1 ? Icon.Key : item.type === 3 ? Icon.CreditCard : Icon.Document}
          actions={
            <ActionPanel>
              {item.type === 1 ? (
                <>
                  <ActionPanel.Section>
                    <Action
                      title="Copy Password"
                      icon={Icon.Key}
                      onAction={() => void copySecret('password', item.login?.password)}
                    />
                    <Action
                      title="Copy Username"
                      icon={Icon.Person}
                      onAction={() => void copySecret('username', item.login?.username)}
                    />
                  </ActionPanel.Section>
                  <ActionPanel.Section>
                    <Action
                      title="Copy One-Time Code"
                      icon={Icon.Clock}
                      shortcut={{ modifiers: ['cmd'], key: 't' }}
                      onAction={() => void copyTotp(item)}
                    />
                  </ActionPanel.Section>
                </>
              ) : item.type === 3 ? (
                <ActionPanel.Section>
                  <Action
                    title="Copy Card Number"
                    icon={Icon.CreditCard}
                    onAction={() => void copySecret('card number', item.card?.number)}
                  />
                </ActionPanel.Section>
              ) : (
                <ActionPanel.Section>
                  <Action
                    title="Copy Note"
                    icon={Icon.Document}
                    onAction={() => void copySecret('note', item.notes)}
                  />
                </ActionPanel.Section>
              )}
              {syncAction}
            </ActionPanel>
          }
        />
      ))}
      <List.EmptyView
        icon={Icon.Lock}
        title={error ? 'bw did not answer' : 'Nothing here'}
        description={
          error
            ? said(error) +
              ' Unlock with bw unlock --raw and paste the token into the Session Token preference in lumanin plugins.'
            : 'No items of this kind in your vault. Press Ctrl+R to sync.'
        }
        actions={<ActionPanel>{syncAction}</ActionPanel>}
      />
    </List>
  )
}
