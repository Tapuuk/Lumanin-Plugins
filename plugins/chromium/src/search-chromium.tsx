/**
 * Chromium bookmarks and history, read from the profile on disk.
 *
 * Bookmarks are the profile's Bookmarks JSON. History is a SQLite file the
 * running browser keeps locked, so it is read in place with the sqlite3 CLI's
 * immutable mode, which ignores the lock; when that read fails the file is
 * copied into the plugin's own support directory and read there. Favicons
 * come from each site itself; nothing else leaves the machine.
 */
import {
  Action,
  ActionPanel,
  Icon,
  List,
  Toast,
  closeMainWindow,
  environment,
  getFavicon,
  getPreferenceValues,
  showToast,
  usePromise
} from 'lumanin'
import { useMemo, useRef, useState } from 'react'
import { execFile, spawn } from 'node:child_process'
import { promisify } from 'node:util'
import { chmod, copyFile, mkdir, readFile, readdir, stat, unlink } from 'node:fs/promises'
import { homedir } from 'node:os'
import { basename, dirname, join } from 'node:path'

const run = promisify(execFile)

const CATEGORIES = [
  { id: 'bookmarks', title: 'Bookmarks' },
  { id: 'history', title: 'History' }
] as const

const HISTORY_LIMIT = 1500

interface Row {
  /** The page URL - the stable id of a row. */
  url: string
  title: string
  /** Bookmark folder path, or visit count for history rows. */
  subtitle: string
  /** Whether the URL parses as http(s) - decided once at load, not per render. */
  openable: boolean
}

const SQLITE_TIMEOUT_MS = 15_000
const SQLITE_MAX_BUFFER = 10 * 1024 * 1024

const rowOf = (url: string, title: string, subtitle: string): Row => ({
  url,
  title,
  subtitle,
  openable: httpUrl(url) !== undefined
})

interface Preferences {
  profileDir?: string
  browserCommand?: string
}

const expandHome = (path: string): string =>
  path === '~' || path.startsWith('~/') ? join(homedir(), path.slice(1)) : path

const FALLBACK_PROFILE = '~/.config/chromium/Default'

/** Profile roots, one per Chromium-family browser, in the order they are probed. */
const PROFILE_ROOTS = [
  '~/.config/chromium',
  '~/.config/google-chrome',
  '~/.config/google-chrome-beta',
  '~/.config/BraveSoftware/Brave-Browser',
  '~/.config/microsoft-edge',
  '~/.config/vivaldi',
  '~/.var/app/org.chromium.Chromium/config/chromium'
]

let detectedProfile: Promise<string> | null = null

async function resolveProfileDir(): Promise<string> {
  const pref = getPreferenceValues<Preferences>().profileDir?.trim()
  if (pref) return expandHome(pref)
  detectedProfile ??= Promise.all(
    PROFILE_ROOTS.map((root) => {
      const profile = join(expandHome(root), 'Default')
      return stat(join(profile, 'History')).then(() => profile, () => null)
    })
  ).then((found) => found.find((profile) => profile !== null) ?? expandHome(FALLBACK_PROFILE))
  return detectedProfile
}

function httpUrl(href: string | undefined): string | undefined {
  if (href === undefined) return undefined
  try {
    const parsed = new URL(href)
    return parsed.protocol === 'http:' || parsed.protocol === 'https:' ? href : undefined
  } catch {
    return undefined
  }
}

// The Flatpak root also ends in `/chromium`, so it is matched before the bare one.
const BROWSER_BY_ROOT: [suffix: string, command: string[]][] = [
  ['.var/app/org.chromium.Chromium/config/chromium', ['flatpak', 'run', 'org.chromium.Chromium']],
  ['chromium', ['chromium']],
  ['google-chrome', ['google-chrome']],
  ['google-chrome-beta', ['google-chrome-beta']],
  ['google-chrome-unstable', ['google-chrome-unstable']],
  ['BraveSoftware/Brave-Browser', ['brave']],
  ['microsoft-edge', ['microsoft-edge']],
  ['vivaldi', ['vivaldi']]
]

/** The browser that owns `profile`: the preference when set, else mapped from the profile root. */
function browserCommand(profile: string): string[] {
  const pref = getPreferenceValues<Preferences>().browserCommand?.trim()
  if (pref) return pref.split(/\s+/)
  const root = dirname(profile)
  for (const [suffix, command] of BROWSER_BY_ROOT) {
    if (root.endsWith('/' + suffix)) return command
  }
  return ['chromium']
}

/** Spawn detached so a running browser outlives this worker, toast on failure. */
async function openInBrowser(profile: string, url: string): Promise<void> {
  const [command, ...args] = browserCommand(profile)
  try {
    await new Promise<void>((resolve, reject) => {
      const child = spawn(command, [...args, '--profile-directory=' + basename(profile), url], {
        detached: true,
        stdio: 'ignore'
      })
      child.once('spawn', () => {
        child.unref()
        resolve()
      })
      child.once('error', reject)
    })
  } catch (error) {
    await showToast({
      style: Toast.Style.Failure,
      title: 'Could not open ' + command,
      message: error instanceof Error ? error.message : String(error)
    })
    return
  }
  await closeMainWindow()
}

interface BookmarkNode {
  type?: string
  name?: string
  url?: string
  children?: BookmarkNode[]
}

function walkBookmarks(node: BookmarkNode, folder: string, rows: Row[], seen: Set<string>): void {
  if (node.type === 'url' && typeof node.url === 'string') {
    if (!seen.has(node.url)) {
      seen.add(node.url)
      rows.push(rowOf(node.url, node.name ?? node.url, folder))
    }
    return
  }
  const path = folder === '' ? (node.name ?? '') : folder + ' / ' + (node.name ?? '')
  for (const child of node.children ?? []) walkBookmarks(child, path, rows, seen)
}

async function loadBookmarks(profile: string): Promise<Row[]> {
  let raw: string
  try {
    raw = await readFile(join(profile, 'Bookmarks'), 'utf8')
  } catch (err) {
    // The browser writes this file on the first bookmark, so a fresh profile has none.
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return []
    throw err
  }
  const parsed = JSON.parse(raw) as { roots?: Record<string, BookmarkNode> }
  const rows: Row[] = []
  const seen = new Set<string>()
  for (const root of Object.values(parsed.roots ?? {})) walkBookmarks(root, '', rows, seen)
  return rows
}

/** sqlite3 CLI not found; the empty-state should name it rather than blame the profile. */
class Sqlite3MissingError extends Error {}

const HISTORY_SIDECAR_SUFFIXES = ['-journal', '-wal', '-shm']

/** Copies `from` to `to` if it exists, chmods it 0600, and reports whether it copied anything. */
async function copySidecarIfPresent(from: string, to: string): Promise<boolean> {
  try {
    await copyFile(from, to)
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return false
    throw err
  }
  await chmod(to, 0o600)
  return true
}

const STALE_COPY_AGE_MS = 60_000

// A worker terminated mid-load (Escape during the copy) never reaches the
// finally below, so each load also sweeps copies older than any load can be.
async function removeStaleCopies(dir: string): Promise<void> {
  const names = await readdir(dir).catch(() => [] as string[])
  const cutoff = Date.now() - STALE_COPY_AGE_MS
  await Promise.all(
    names
      .filter((name) => /^history-.*\.db(-journal|-wal|-shm)?$/.test(name))
      .map(async (name) => {
        const file = join(dir, name)
        const info = await stat(file).catch(() => undefined)
        if (info !== undefined && info.mtimeMs < cutoff) await unlink(file).catch(() => {})
      })
  )
}

const HISTORY_QUERY = `SELECT url, title, visit_count FROM urls
       WHERE hidden = 0 ORDER BY last_visit_time DESC LIMIT ${HISTORY_LIMIT}`

async function queryHistory(file: string, signal: AbortSignal | undefined): Promise<Row[]> {
  const { stdout } = await run('sqlite3', ['-readonly', '-json', file, HISTORY_QUERY], {
    timeout: SQLITE_TIMEOUT_MS,
    maxBuffer: SQLITE_MAX_BUFFER,
    ...(signal === undefined ? {} : { signal })
  }).catch((err) => {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') throw new Sqlite3MissingError(err.message)
    throw err
  })
  const parsed = JSON.parse(stdout.trim() || '[]') as { url: string; title: string; visit_count: number }[]
  const seen = new Set<string>()
  return parsed
    .filter((row) => (seen.has(row.url) ? false : (seen.add(row.url), true)))
    .map((row) =>
      rowOf(
        row.url,
        row.title === '' ? row.url : row.title,
        row.visit_count === 1 ? '1 visit' : String(row.visit_count) + ' visits'
      )
    )
}

// Disambiguates two loadHistory() calls that land in the same worker in the
// same millisecond - two rapid category toggles do exactly that.
let historyCopySequence = 0

async function loadHistory(profile: string, signal: AbortSignal | undefined): Promise<Row[]> {
  const live = join(profile, 'History')
  // `immutable=1` reads the file in place without taking the lock the running
  // browser holds, which skips copying a database that is routinely tens of
  // megabytes. A write landing mid-read can make that fail, and then the copy
  // below is the answer.
  try {
    return await queryHistory('file:' + live + '?immutable=1', signal)
  } catch (error) {
    if (error instanceof Sqlite3MissingError || signal?.aborted) throw error
  }
  // A private, uniquely-named copy is always readable and never shared between
  // two concurrent loads. The sidecars (whichever journaling mode is active)
  // come along so a mid-write snapshot is not torn.
  await mkdir(environment.supportPath, { recursive: true })
  void removeStaleCopies(environment.supportPath)
  const stamp = `history-${Date.now()}-${process.pid}-${++historyCopySequence}.db`
  const copy = join(environment.supportPath, stamp)
  const copiedFiles: string[] = []
  try {
    await copyFile(live, copy)
    await chmod(copy, 0o600)
    copiedFiles.push(copy)
    const sidecars = await Promise.all(
      HISTORY_SIDECAR_SUFFIXES.map(async (suffix) => {
        const sidecar = copy + suffix
        return (await copySidecarIfPresent(live + suffix, sidecar)) ? sidecar : null
      })
    )
    for (const sidecar of sidecars) if (sidecar !== null) copiedFiles.push(sidecar)
    if (signal?.aborted) throw new Error('aborted')
    return await queryHistory(copy, signal)
  } finally {
    await Promise.all(copiedFiles.map((file) => unlink(file).catch(() => {})))
  }
}

interface Loaded {
  category: string
  profile: string
  rows: Row[]
}

async function loadRows(category: string, signal: AbortSignal | undefined): Promise<Loaded> {
  const profile = await resolveProfileDir()
  const rows = category === 'history' ? await loadHistory(profile, signal) : await loadBookmarks(profile)
  return { category, profile, rows }
}

export default function SearchChromium(props: {
  launchContext?: { category?: unknown }
}): React.JSX.Element {
  const requested = props.launchContext?.category
  const [category, setCategory] = useState(
    typeof requested === 'string' && CATEGORIES.some((entry) => entry.id === requested)
      ? requested
      : 'bookmarks'
  )
  const abortable = useRef<AbortController | null>(null)
  // One answer per category for the life of this view, so toggling back does
  // not re-read the profile; history is not written anywhere by this.
  const loaded = useRef(new Map<string, Loaded>())
  const { isLoading, data, error } = usePromise(
    async (wanted: string) => {
      const known = loaded.current.get(wanted)
      if (known !== undefined) return known
      const result = await loadRows(wanted, abortable.current?.signal)
      loaded.current.set(wanted, result)
      return result
    },
    [category],
    { abortable }
  )
  const profile = data?.profile ?? ''
  // Previous data is kept while the next category loads; showing it under the
  // new dropdown label would be wrong, so only rows of the chosen category render.
  const rows = useMemo(
    () => (data !== undefined && data.category === category ? data.rows : []),
    [data, category]
  )

  return (
    <List
      isLoading={isLoading}
      searchBarPlaceholder="Search bookmarks and history"
      searchBarAccessory={
        <List.Dropdown tooltip="Category" value={category} onChange={setCategory}>
          {CATEGORIES.map((cat) => (
            <List.Dropdown.Item key={cat.id} value={cat.id} title={cat.title} />
          ))}
        </List.Dropdown>
      }
    >
      {rows.map((row) => (
        <List.Item
          key={row.url}
          id={row.url}
          title={row.title}
          subtitle={row.subtitle}
          icon={row.openable ? getFavicon(row.url, { fallback: Icon.Globe }) : Icon.Globe}
          actions={
            <ActionPanel>
              <ActionPanel.Section>
                {row.openable && (
                  <Action
                    title="Open in Browser"
                    icon={Icon.Globe}
                    onAction={() => void openInBrowser(profile, row.url)}
                  />
                )}
              </ActionPanel.Section>
              <ActionPanel.Section>
                <Action.CopyToClipboard
                  title="Copy URL"
                  content={row.url}
                  shortcut={{ modifiers: ['cmd'], key: 'c' }}
                />
              </ActionPanel.Section>
            </ActionPanel>
          }
        />
      ))}
      <List.EmptyView
        icon={Icon.Globe}
        title={
          error instanceof Sqlite3MissingError
            ? 'sqlite3 is not installed'
            : error
              ? 'Could not read the profile'
              : 'Nothing here'
        }
        description={
          error instanceof Sqlite3MissingError
            ? 'History needs the sqlite3 CLI. Install the sqlite package with your package manager.'
            : error
              ? 'Check the Profile Directory preference in lumanin plugins; it should hold Bookmarks and History files.'
              : category === 'bookmarks'
                ? 'No bookmarks in this profile yet.'
                : 'No history in this profile yet.'
        }
      />
    </List>
  )
}
