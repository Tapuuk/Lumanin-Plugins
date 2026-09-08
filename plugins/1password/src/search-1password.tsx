/**
 * Your 1Password vault, through the op CLI.
 *
 * Listing is `op item list`; a secret is fetched only when you copy it, with
 * `op item get`, and authorization stays the desktop app's business - op pops
 * its prompt, the plugin never sees your master password. A copied secret is
 * cleared from the clipboard after 30 seconds, unless you copied something
 * else in the meantime. No network of our own, no dependencies.
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
  { id: 'credit-cards', title: 'Credit Cards' },
  { id: 'identities', title: 'Identities' }
] as const

const OP_CATEGORY: Record<string, string> = {
  logins: 'LOGIN',
  'credit-cards': 'CREDIT_CARD',
  identities: 'IDENTITY'
}

interface Item {
  id: string
  title: string
  category: string
  additional_information?: string
  urls?: { primary?: boolean; href?: string }[]
}

interface Preferences {
  opBinary?: string
  account?: string
}

const opBinary = (): string => getPreferenceValues<Preferences>().opBinary?.trim() || 'op'

/** Append `--account` when one is set; a value that looks like a flag is refused. */
function opArgs(argv: string[]): string[] {
  const account = getPreferenceValues<Preferences>().account?.trim() ?? ''
  if (account === '') return argv
  if (account.startsWith('-')) {
    void showToast({ style: Toast.Style.Failure, title: 'Account looks like a flag', message: account })
    return argv
  }
  return [...argv, '--account', account]
}

/** What op said on stderr, or the exec error itself (a timeout has no stderr). */
function said(error: unknown): string {
  const stderr = (error as { stderr?: unknown })?.stderr
  if (typeof stderr === 'string' && stderr.trim() !== '') return stderr.trim()
  return String((error as { message?: unknown })?.message ?? error)
}

async function loadItems(signal: AbortSignal | undefined): Promise<Item[]> {
  const { stdout } = await run(opBinary(), opArgs(['item', 'list', '--format=json']), {
    maxBuffer: MAX_BUFFER,
    timeout: 60_000,
    ...(signal === undefined ? {} : { signal })
  })
  return (JSON.parse(stdout) as Item[]).filter((item) => typeof item.id === 'string')
}

/** A vault-supplied href is opened only when it parses as http or https. */
function httpUrl(href: string | undefined): string | undefined {
  if (href === undefined) return undefined
  try {
    const parsed = new URL(href)
    return parsed.protocol === 'http:' || parsed.protocol === 'https:' ? href : undefined
  } catch {
    return undefined
  }
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
async function copyConcealed(label: string, value: string): Promise<void> {
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

/** `op item get` for one field; undefined when op failed (the toast is already shown). */
async function getField(item: Item, label: string, argv: string[]): Promise<string | undefined> {
  try {
    const { stdout } = await run(opBinary(), opArgs(['item', 'get', item.id, ...argv]), {
      maxBuffer: MAX_BUFFER,
      timeout: 30_000
    })
    return stdout.trim()
  } catch (error) {
    await showToast({ style: Toast.Style.Failure, title: 'Could not get ' + label + ' for ' + item.title, message: said(error) })
    return undefined
  }
}

async function copyField(item: Item, field: 'password' | 'username'): Promise<void> {
  const value = await getField(item, field, ['--fields', field, '--reveal'])
  if (value === undefined) return
  if (value === '') {
    await showToast({ style: Toast.Style.Failure, title: 'No ' + field + ' on ' + item.title })
    return
  }
  await copyConcealed(field, value)
}

async function copyOtp(item: Item): Promise<void> {
  const value = await getField(item, 'one-time code', ['--otp'])
  if (value === undefined) return
  if (value === '') {
    await showToast({ style: Toast.Style.Failure, title: 'No one-time code on ' + item.title })
    return
  }
  await copyConcealed('one-time code', value)
}

export default function Search1Password(props: {
  launchContext?: { category?: unknown }
}): React.JSX.Element {
  const requested = props.launchContext?.category
  const [category, setCategory] = useState(
    typeof requested === 'string' && CATEGORIES.some((entry) => entry.id === requested)
      ? requested
      : 'logins'
  )
  const abortable = useRef<AbortController | null>(null)
  const { isLoading, data, error } = usePromise(() => loadItems(abortable.current?.signal), [], {
    abortable
  })

  const wanted = OP_CATEGORY[category] ?? 'LOGIN'
  const rows = useMemo(
    () =>
      (data ?? [])
        .filter((item) => item.category === wanted)
        .map((item) => ({
          item,
          url: httpUrl(item.urls?.find((u) => u.primary)?.href ?? item.urls?.[0]?.href)
        })),
    [data, wanted]
  )

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
      {rows.map(({ item, url }) => {
        return (
          <List.Item
            key={item.id}
            id={item.id}
            title={item.title}
            subtitle={item.additional_information ?? ''}
            icon={
              item.category === 'LOGIN'
                ? Icon.Key
                : item.category === 'CREDIT_CARD'
                  ? Icon.CreditCard
                  : Icon.Person
            }
            actions={
              <ActionPanel>
                {item.category === 'LOGIN' ? (
                  <>
                    <ActionPanel.Section>
                      <Action
                        title="Copy Password"
                        icon={Icon.Key}
                        onAction={() => void copyField(item, 'password')}
                      />
                      <Action
                        title="Copy Username"
                        icon={Icon.Person}
                        onAction={() => void copyField(item, 'username')}
                      />
                    </ActionPanel.Section>
                    <ActionPanel.Section>
                      <Action
                        title="Copy One-Time Code"
                        icon={Icon.Clock}
                        shortcut={{ modifiers: ['cmd'], key: 't' }}
                        onAction={() => void copyOtp(item)}
                      />
                      {url !== undefined && (
                        <Action.OpenInBrowser
                          title="Open Website"
                          url={url}
                          shortcut={{ modifiers: ['cmd'], key: 'o' }}
                        />
                      )}
                    </ActionPanel.Section>
                  </>
                ) : (
                  <ActionPanel.Section>
                    <Action.CopyToClipboard title="Copy Item Title" content={item.title} />
                  </ActionPanel.Section>
                )}
              </ActionPanel>
            }
          />
        )
      })}
      <List.EmptyView
        icon={Icon.Lock}
        title={error ? 'op did not answer' : 'Nothing here'}
        description={
          error
            ? said(error) +
              ' Install the 1Password desktop app, turn on CLI integration under Settings, Developer, and approve the prompt op shows.' +
              ' With more than one account, set Account in lumanin plugins.'
            : 'No items of this kind in your vault.'
        }
      />
    </List>
  )
}
