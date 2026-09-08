/**
 * Recent VS Code folders and workspaces, straight off this machine.
 *
 * Sources, both local: each flavor's storage.json (every workspace the editor
 * has associated with a profile, plus the windows open at last exit), and its
 * state.vscdb recently-opened list when the sqlite3 CLI is around to read it.
 * No network, no dependencies.
 */
import {
  Action,
  ActionPanel,
  Icon,
  List,
  Toast,
  closeMainWindow,
  environment,
  getPreferenceValues,
  showToast,
  useCachedPromise
} from 'lumanin'
import { useMemo, useRef, useState } from 'react'
import { execFile, spawn } from 'node:child_process'
import { promisify } from 'node:util'
import { chmod, copyFile, mkdir, readdir, readFile, stat, unlink } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join, posix } from 'node:path'
import { fileURLToPath } from 'node:url'

const run = promisify(execFile)

const CATEGORIES = [
  { id: 'folders', title: 'Folders' },
  { id: 'workspaces', title: 'Workspaces' }
] as const

interface Flavor {
  name: string
  /** Probed in order; the first holding a storage.json is the flavor's config dir. */
  configDirs: string[]
  /** The shared recently-opened database, probed before the legacy one under the config dir. */
  sharedDbs: string[]
  /** argv prefix that launches this editor. */
  launch: string[]
}

const home = homedir()
const configHome = process.env.XDG_CONFIG_HOME ?? join(home, '.config')
const sharedDb = (base: string, folder: string): string => join(base, folder, 'sharedStorage', 'state.vscdb')

const FLAVORS: Flavor[] = [
  {
    name: 'Code',
    configDirs: [join(configHome, 'Code')],
    sharedDbs: [sharedDb(home, '.vscode-shared')],
    launch: ['code']
  },
  {
    name: 'Code - OSS',
    configDirs: [join(configHome, 'Code - OSS')],
    sharedDbs: [sharedDb(home, '.vscode-oss-shared')],
    launch: ['code']
  },
  {
    name: 'VSCodium',
    configDirs: [join(configHome, 'VSCodium')],
    sharedDbs: [sharedDb(home, '.vscode-oss-shared')],
    launch: ['codium']
  },
  {
    name: 'Code - Insiders',
    configDirs: [join(configHome, 'Code - Insiders')],
    sharedDbs: [sharedDb(home, '.vscode-insiders-shared')],
    launch: ['code-insiders']
  },
  {
    name: 'Cursor',
    configDirs: [join(configHome, 'Cursor')],
    sharedDbs: [sharedDb(home, '.cursor-shared')],
    launch: ['cursor']
  },
  {
    name: 'Code (Flatpak)',
    configDirs: [join(home, '.var', 'app', 'com.visualstudio.code', 'config', 'Code')],
    sharedDbs: [sharedDb(home, '.vscode-shared')],
    launch: ['flatpak', 'run', 'com.visualstudio.code']
  },
  {
    name: 'VSCodium (Flatpak)',
    configDirs: [join(home, '.var', 'app', 'com.vscodium.codium', 'config', 'VSCodium')],
    sharedDbs: [sharedDb(home, '.vscode-oss-shared')],
    launch: ['flatpak', 'run', 'com.vscodium.codium']
  },
  {
    name: 'Code (Snap)',
    configDirs: [join(home, 'snap', 'code', 'current', '.config', 'Code')],
    sharedDbs: [sharedDb(join(home, 'snap', 'code', 'current'), '.vscode-shared'), sharedDb(home, '.vscode-shared')],
    launch: ['/snap/bin/code']
  }
]

interface Entry {
  /** The stored URI - the stable id of a row. */
  uri: string
  /** Absolute path for a local entry, null for a remote one. */
  path: string | null
  /** For example `ssh-remote+devbox`; only remote entries carry one. */
  remoteAuthority?: string
  kind: 'folder' | 'workspace'
  flavor: Flavor
  /** Position in the recently-opened list; missing entries sort after. */
  recency: number
  /** What the row shows, worked out once at load rather than on every render. */
  title: string
  subtitle: string
}

interface StoredUri {
  uri: string
  remoteAuthority?: string
}

function launchFor(flavor: Flavor): string[] {
  const preferred = getPreferenceValues<{ codeBinary?: string }>().codeBinary?.trim()
  return preferred ? preferred.split(/\s+/) : flavor.launch
}

function parseEntry(stored: StoredUri, flavor: Flavor, recency: number): Entry | null {
  const { uri, remoteAuthority } = stored
  let path: string | null = null
  let uriPath: string
  try {
    if (uri.startsWith('file://')) {
      path = fileURLToPath(uri)
      uriPath = path
    } else if (uri.startsWith('vscode-remote://')) {
      uriPath = decodeURIComponent(new URL(uri).pathname)
    } else {
      return null
    }
  } catch {
    return null
  }
  const kind = uriPath.endsWith('.code-workspace') ? 'workspace' : 'folder'
  const shown = kind === 'workspace' ? uriPath : dirname(uriPath)
  return {
    uri,
    path,
    remoteAuthority,
    kind,
    flavor,
    recency,
    title: posix.basename(uriPath).replace(/\.code-workspace$/, ''),
    subtitle: path !== null && shown.startsWith(home) ? '~' + shown.slice(home.length) : shown
  }
}

function collectUris(storage: Record<string, unknown>): StoredUri[] {
  const uris: StoredUri[] = []
  const assoc = (storage.profileAssociations as { workspaces?: Record<string, unknown> })?.workspaces
  if (assoc) for (const uri of Object.keys(assoc)) uris.push({ uri })
  const windows = storage.windowsState as
    | {
        openedWindows?: {
          folder?: string
          workspaceIdentifier?: { configURIPath?: string }
          remoteAuthority?: string
        }[]
      }
    | undefined
  for (const win of windows?.openedWindows ?? []) {
    if (win.folder) uris.push({ uri: win.folder, remoteAuthority: win.remoteAuthority })
    if (win.workspaceIdentifier?.configURIPath) {
      uris.push({ uri: win.workspaceIdentifier.configURIPath, remoteAuthority: win.remoteAuthority })
    }
  }
  const backup = storage.backupWorkspaces as
    | {
        folders?: { folderUri?: string; remoteAuthority?: string }[]
        workspaces?: { configURIPath?: string; remoteAuthority?: string }[]
      }
    | undefined
  for (const f of backup?.folders ?? []) {
    if (f.folderUri) uris.push({ uri: f.folderUri, remoteAuthority: f.remoteAuthority })
  }
  for (const w of backup?.workspaces ?? []) {
    if (w.configURIPath) uris.push({ uri: w.configURIPath, remoteAuthority: w.remoteAuthority })
  }
  return uris
}

const DB_SIDECAR_SUFFIXES = ['-journal', '-wal', '-shm']

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

let dbCopySequence = 0

const RECENT_QUERY = "SELECT value FROM ItemTable WHERE key='history.recentlyOpenedPathsList'"

/** A copy this old belongs to a run that died before its finally block. */
const STALE_COPY_MS = 60_000

async function sqlite3Json(target: string): Promise<string> {
  const { stdout } = await run('sqlite3', ['-readonly', '-json', target, RECENT_QUERY], {
    timeout: 5_000,
    maxBuffer: 10 * 1024 * 1024
  })
  return stdout
}

/** Reads the recently-opened list from a private 0600 copy of `db`, never the file the editor holds open. */
async function queryCopy(db: string): Promise<string> {
  const copy = join(environment.supportPath, `state-${Date.now()}-${process.pid}-${++dbCopySequence}.db`)
  const copiedFiles: string[] = []
  try {
    await copyFile(db, copy)
    await chmod(copy, 0o600)
    copiedFiles.push(copy)
    for (const suffix of DB_SIDECAR_SUFFIXES) {
      if (await copySidecarIfPresent(db + suffix, copy + suffix)) copiedFiles.push(copy + suffix)
    }
    return await sqlite3Json(copy)
  } finally {
    for (const file of copiedFiles) await unlink(file).catch(() => {})
  }
}

/**
 * The recently-opened list out of one database.
 *
 * `immutable=1` reads the live file without taking a lock or writing anything
 * beside it, which is the whole of what the copy was for and costs nothing. The
 * copy stays as the fallback: a torn database, or a sqlite3 too old for URI
 * filenames, still answers that way.
 */
async function queryRecent(db: string): Promise<StoredUri[]> {
  let stdout: string
  try {
    stdout = await sqlite3Json(`file:${db}?immutable=1`)
  } catch {
    stdout = await queryCopy(db)
  }
  const rows = JSON.parse(stdout.trim() || '[]') as { value?: string }[]
  const parsed = JSON.parse(rows[0]?.value ?? '{}') as {
    entries?: { folderUri?: string; workspace?: { configPath?: string }; remoteAuthority?: string }[]
  }
  const uris: StoredUri[] = []
  for (const entry of parsed.entries ?? []) {
    if (entry.folderUri) uris.push({ uri: entry.folderUri, remoteAuthority: entry.remoteAuthority })
    if (entry.workspace?.configPath) {
      uris.push({ uri: entry.workspace.configPath, remoteAuthority: entry.remoteAuthority })
    }
  }
  return uris
}

/** Copies left behind by a run that was killed mid-query. Best effort, never awaited. */
async function sweepStaleCopies(): Promise<void> {
  const cutoff = Date.now() - STALE_COPY_MS
  const names = await readdir(environment.supportPath).catch(() => [])
  for (const name of names) {
    if (!name.startsWith('state-') || !name.includes('.db')) continue
    const file = join(environment.supportPath, name)
    const info = await stat(file).catch(() => null)
    if (info && info.mtimeMs < cutoff) await unlink(file).catch(() => {})
  }
}

/** The ordered recently-opened list, read with the sqlite3 CLI when present. */
async function recentUris(flavor: Flavor, configDir: string): Promise<StoredUri[]> {
  // Since VS Code 1.118 the list lives in the shared database; the one under
  // the config dir is where older versions kept it.
  const candidates = [...flavor.sharedDbs, join(configDir, 'User', 'globalStorage', 'state.vscdb')]
  for (const db of candidates) {
    try {
      await stat(db)
    } catch {
      continue
    }
    for (const source of [db, db + '.backup']) {
      try {
        return await queryRecent(source)
      } catch {
        // Locked, torn, or sqlite3 missing; try the backup, then give up ordering.
      }
    }
    return []
  }
  return []
}

function aborted(signal: AbortSignal | undefined): boolean {
  return signal?.aborted === true
}

function abortError(): Error {
  const error = new Error('The load was superseded')
  error.name = 'AbortError'
  return error
}

/** One flavor's entries, in the order they should be considered; `found` says whether it is installed at all. */
async function loadFlavor(
  flavor: Flavor,
  signal: AbortSignal | undefined
): Promise<{ found: boolean; entries: Entry[] }> {
  let storage: Record<string, unknown> | null = null
  let configDir = ''
  for (const dir of flavor.configDirs) {
    try {
      storage = JSON.parse(await readFile(join(dir, 'User', 'globalStorage', 'storage.json'), 'utf8'))
      configDir = dir
      break
    } catch {
      // Not installed here.
    }
  }
  if (storage === null) return { found: false, entries: [] }
  if (aborted(signal)) return { found: true, entries: [] }

  const recent = await recentUris(flavor, configDir)
  const rank = new Map<string, number>()
  recent.forEach((stored, index) => {
    if (!rank.has(stored.uri)) rank.set(stored.uri, index)
  })

  const entries: Entry[] = []
  const seen = new Set<string>()
  for (const stored of [...recent, ...collectUris(storage)]) {
    if (seen.has(stored.uri)) continue
    seen.add(stored.uri)
    const entry = parseEntry(stored, flavor, rank.get(stored.uri) ?? Number.MAX_SAFE_INTEGER)
    if (entry) entries.push(entry)
  }
  return { found: true, entries }
}

/** How many paths are stat'd at once - enough to keep the disk busy, few enough to stay polite. */
const STAT_BATCH = 32

/** `null` means no editor configuration directory exists at all, as opposed to one with nothing recent. */
async function loadEntries(signal?: AbortSignal): Promise<Entry[] | null> {
  await mkdir(environment.supportPath, { recursive: true })
  void sweepStaleCopies()

  // The flavors share nothing, so they are read at once and merged in FLAVORS
  // order afterwards: the result must not depend on which editor answered first.
  const perFlavor = await Promise.all(FLAVORS.map((flavor) => loadFlavor(flavor, signal)))
  if (aborted(signal)) throw abortError()
  if (!perFlavor.some((flavor) => flavor.found)) return null

  const byUri = new Map<string, Entry>()
  for (const found of perFlavor) {
    for (const entry of found.entries) {
      if (!byUri.has(entry.uri)) byUri.set(entry.uri, entry)
    }
  }

  const candidates = [...byUri.values()]
  const entries: Entry[] = []
  for (let start = 0; start < candidates.length; start += STAT_BATCH) {
    if (aborted(signal)) throw abortError()
    const batch = candidates.slice(start, start + STAT_BATCH)
    const alive = await Promise.all(
      batch.map(async (entry) => {
        if (entry.path === null) return true
        // Deleted since the editor last saw it; a row that cannot open is noise.
        return await stat(entry.path).then(
          () => true,
          () => false
        )
      })
    )
    batch.forEach((entry, index) => {
      if (alive[index]) entries.push(entry)
    })
  }
  entries.sort((a, b) => a.recency - b.recency || a.title.localeCompare(b.title))
  return entries
}

function openEntry(entry: Entry, newWindow: boolean): void {
  const launch = launchFor(entry.flavor)
  const target =
    entry.path !== null ? [entry.path] : [entry.kind === 'workspace' ? '--file-uri' : '--folder-uri', entry.uri]
  const args = [...launch.slice(1), ...(newWindow ? ['--new-window'] : []), ...target]
  const child = spawn(launch[0], args, { detached: true, stdio: 'ignore' })
  child.on('error', () => {
    void showToast({
      style: Toast.Style.Failure,
      title: 'Could not run ' + launch[0],
      message: 'Set VS Code Executable in lumanin plugins'
    })
  })
  child.once('spawn', () => void closeMainWindow())
  child.unref()
}

export default function SearchVsCode(props: {
  launchContext?: { category?: unknown }
}): React.JSX.Element {
  const requested = props.launchContext?.category
  const [category, setCategory] = useState(
    typeof requested === 'string' && CATEGORIES.some((entry) => entry.id === requested)
      ? requested
      : 'folders'
  )
  const abortable = useRef<AbortController | null>(null)
  const { isLoading, data, error } = useCachedPromise(() => loadEntries(abortable.current?.signal), [], {
    abortable
  })

  // An older cached value is a plain array; `null` is "no installation found".
  const entries = useMemo(
    () =>
      (Array.isArray(data) ? data : []).filter((entry) =>
        category === 'workspaces' ? entry.kind === 'workspace' : entry.kind === 'folder'
      ),
    [data, category]
  )

  const rows = useMemo(
    () =>
      entries.map((entry) => (
        <List.Item
          key={entry.uri}
          id={entry.uri}
          title={entry.title}
          subtitle={entry.subtitle}
          icon={entry.kind === 'workspace' ? 'system:application-x-executable,text-x-generic' : 'system:folder'}
          accessories={
            entry.remoteAuthority
              ? [{ text: entry.flavor.name }, { text: entry.remoteAuthority }]
              : [{ text: entry.flavor.name }]
          }
          actions={
            <ActionPanel>
              <ActionPanel.Section>
                <Action title="Open in VS Code" icon={Icon.Window} onAction={() => openEntry(entry, false)} />
                <Action
                  title="Open in New Window"
                  icon={Icon.PlusSquare}
                  onAction={() => openEntry(entry, true)}
                />
              </ActionPanel.Section>
              <ActionPanel.Section>
                <Action.CopyToClipboard
                  title="Copy Path"
                  content={entry.path ?? entry.uri}
                  shortcut={{ modifiers: ['cmd'], key: 'c' }}
                />
              </ActionPanel.Section>
            </ActionPanel>
          }
        />
      )),
    [entries]
  )

  return (
    <List
      isLoading={isLoading}
      searchBarPlaceholder="Search recent folders and workspaces"
      searchBarAccessory={
        <List.Dropdown tooltip="Category" value={category} onChange={setCategory}>
          {CATEGORIES.map((cat) => (
            <List.Dropdown.Item key={cat.id} value={cat.id} title={cat.title} />
          ))}
        </List.Dropdown>
      }
    >
      {rows}
      {error !== undefined && (
        <List.EmptyView
          icon={Icon.Warning}
          title="Could not read the editor's files"
          description={String(error.message ?? error).split('\n')[0]}
        />
      )}
      {error === undefined && data === null && (
        <List.EmptyView
          icon={Icon.Warning}
          title="No VS Code installation found"
          description={'Looked in ' + FLAVORS.map((flavor) => flavor.configDirs.join(', ')).join(', ') + '.'}
        />
      )}
      {error === undefined && data !== null && (
        <List.EmptyView
          icon={Icon.MagnifyingGlass}
          title="No recent entries"
          description="Open a folder in VS Code once and it will show up here."
        />
      )}
    </List>
  )
}
