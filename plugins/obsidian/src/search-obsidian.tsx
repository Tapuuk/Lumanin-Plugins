/**
 * Obsidian's vaults and their notes, read straight off the disk.
 *
 * The vault registry is Obsidian's own ~/.config/obsidian/obsidian.json; notes
 * are the .md files inside each vault. Opening goes through the obsidian://
 * URL scheme the app registers, so Obsidian lands on the exact note. No
 * network, no dependencies.
 */
import {
  Action,
  ActionPanel,
  Cache,
  Form,
  Icon,
  List,
  Toast,
  clearSearchBar,
  open,
  showToast,
  useNavigation,
  usePromise
} from 'lumanin'
import { useMemo, useRef, useState } from 'react'
import { readFile, readdir, realpath, stat, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { basename, join, relative, resolve } from 'node:path'

const CATEGORIES = [
  { id: 'notes', title: 'Notes' },
  { id: 'vaults', title: 'Vaults' }
] as const

interface Vault {
  /** Obsidian's own id for the vault, the key in obsidian.json. */
  id: string
  /** Absolute path of the vault directory - the stable id of a row. */
  path: string
  name: string
}

interface Note {
  /** Absolute path of the .md file - the stable id of a row. */
  path: string
  name: string
  /** The vault's path, which is what caps the remembered copy per vault. */
  vault: string
  mtimeMs: number
  /** Rendered once here rather than per row: vault name, then the folder inside it. */
  subtitle: string
  url: string
}

interface Library {
  vaults: Vault[]
  notes: Note[]
}

const MAX_NOTES_PER_VAULT = 2000
/** Directories walked at once. A vault on a spinning disk is slow; a vault of ten thousand folders is a file-handle problem. */
const WALK_CONCURRENCY = 16
/** Obsidian's own vaults are shallow; a deeper tree is someone's source checkout mounted inside one. */
const MAX_DEPTH = 8
/** Never a note folder, and never skipped by the dotfile rule that already handles .git and .obsidian. */
const SKIPPED_DIRECTORIES: ReadonlySet<string> = new Set(['node_modules'])
/** What survives the command closing, per vault. The whole list would not fit the hook cache's budget. */
const REMEMBERED_NOTES_PER_VAULT = 500

const configHome = process.env.XDG_CONFIG_HOME ?? join(homedir(), '.config')

async function loadVaults(): Promise<Vault[]> {
  let raw: string
  try {
    raw = await readFile(join(configHome, 'obsidian', 'obsidian.json'), 'utf8')
  } catch {
    return []
  }
  let parsed: { vaults?: Record<string, { path?: string }> }
  try {
    parsed = JSON.parse(raw)
  } catch {
    return []
  }
  const seen = new Set<string>()
  const vaults: Vault[] = []
  for (const [id, entry] of Object.entries(parsed.vaults ?? {})) {
    if (typeof entry.path === 'string' && entry.path !== '') {
      const path = resolve(entry.path)
      if (seen.has(path)) continue
      seen.add(path)
      vaults.push({ id, path, name: basename(path) })
    }
  }
  return vaults.sort((a, b) => a.name.localeCompare(b.name))
}

/**
 * Obsidian's "Excluded files" setting: vault-relative path prefixes, or a
 * regular expression written between slashes, matched against the relative
 * path with forward slashes. A prefix matches the path itself or a path under
 * it, never a name that merely starts with the same characters (`Temp` does
 * not hide `Templates/`). Directories arrive with a trailing `/`, so
 * `startsWith(prefix + '/')` is what prunes a subtree.
 */
async function ignoreFilters(vault: Vault): Promise<(rel: string) => boolean> {
  let entries: unknown
  try {
    entries = (JSON.parse(await readFile(join(vault.path, '.obsidian', 'app.json'), 'utf8')) as { userIgnoreFilters?: unknown })
      .userIgnoreFilters
  } catch {
    return () => false
  }
  if (!Array.isArray(entries)) return () => false
  const prefixes: string[] = []
  const patterns: RegExp[] = []
  for (const entry of entries) {
    if (typeof entry !== 'string' || entry === '') continue
    if (entry.length > 2 && entry.startsWith('/') && entry.endsWith('/')) {
      try {
        patterns.push(new RegExp(entry.slice(1, -1)))
      } catch {
        // an expression Obsidian would reject too
      }
    } else {
      // Obsidian writes folder entries with and without a trailing slash; an
      // entry that is only slashes would be an empty prefix that hides the vault.
      const prefix = entry.replace(/\/+$/, '')
      if (prefix !== '') prefixes.push(prefix)
    }
  }
  return (rel) =>
    prefixes.some((prefix) => rel === prefix || rel.startsWith(prefix + '/')) ||
    patterns.some((pattern) => pattern.test(rel))
}

interface Walk {
  vault: Vault
  ignored: (rel: string) => boolean
  /** Real paths already walked, so a symlinked folder is listed once and a loop ends. */
  visited: Set<string>
  found: Note[]
  signal: AbortSignal | undefined
}

/** One directory: its notes into `walk.found`, its subdirectories back to the caller. */
async function visitDirectory(walk: Walk, dir: string): Promise<string[]> {
  if (walk.signal?.aborted === true) return []
  let entries
  try {
    const real = await realpath(dir)
    if (walk.visited.has(real)) return []
    walk.visited.add(real)
    entries = await readdir(dir, { withFileTypes: true })
  } catch {
    return []
  }
  const folder = relative(walk.vault.path, dir)
  const subtitle = folder === '' ? walk.vault.name : walk.vault.name + ' / ' + folder
  // Real entries first, so a note reached through a symlink is listed under its real folder.
  entries.sort((a, b) => Number(a.isSymbolicLink()) - Number(b.isSymbolicLink()))
  const subdirectories: string[] = []
  await Promise.all(
    entries.map(async (entry) => {
      if (entry.name.startsWith('.')) return
      const path = join(dir, entry.name)
      const rel = folder === '' ? entry.name : folder + '/' + entry.name
      let isDirectory = entry.isDirectory()
      let isFile = entry.isFile()
      if (entry.isSymbolicLink()) {
        const target = await stat(path).catch(() => null)
        isDirectory = target?.isDirectory() ?? false
        isFile = target?.isFile() ?? false
      }
      if (isDirectory) {
        if (SKIPPED_DIRECTORIES.has(entry.name) || walk.ignored(rel + '/')) return
        subdirectories.push(path)
      } else if (isFile && entry.name.endsWith('.md')) {
        if (walk.ignored(rel)) return
        const mtimeMs = (await stat(path).catch(() => null))?.mtimeMs ?? 0
        const name = entry.name.slice(0, -3)
        walk.found.push({ path, name, vault: walk.vault.path, mtimeMs, subtitle, url: openNoteUrl(path) })
      }
    })
  )
  return subdirectories
}

/**
 * A vault, level by level, a bounded number of directories at a time.
 *
 * The budget is checked between levels rather than only at the end: a vault
 * with a source tree inside it has tens of thousands of files, and all but the
 * newest 2000 of them are read only to be thrown away.
 */
async function walkNotes(walk: Walk): Promise<void> {
  let level = [walk.vault.path]
  for (let depth = 0; depth <= MAX_DEPTH && level.length > 0; depth += 1) {
    const next: string[] = []
    for (let start = 0; start < level.length; start += WALK_CONCURRENCY) {
      const batch = level.slice(start, start + WALK_CONCURRENCY)
      for (const found of await Promise.all(batch.map(async (dir) => await visitDirectory(walk, dir)))) {
        next.push(...found)
      }
    }
    if (walk.found.length >= MAX_NOTES_PER_VAULT || walk.signal?.aborted === true) return
    level = next
  }
}

async function loadAll(signal?: AbortSignal): Promise<Library> {
  const vaults = await loadVaults()
  const perVault = await Promise.all(
    vaults.map(async (vault) => {
      const walk: Walk = { vault, ignored: await ignoreFilters(vault), visited: new Set(), found: [], signal }
      await walkNotes(walk)
      // Cut after sorting so the cap keeps the newest notes, not the first ones readdir happened to return.
      walk.found.sort((a, b) => b.mtimeMs - a.mtimeMs)
      return walk.found.slice(0, MAX_NOTES_PER_VAULT)
    })
  )
  // Keyed by path: a vault reached through two symlinks is one set of notes, not two rows each.
  const notes = new Map<string, Note>()
  for (const found of perVault) for (const note of found) notes.set(note.path, note)
  return { vaults, notes: [...notes.values()] }
}

/**
 * The last library, so a launch paints rows before the walk finishes.
 *
 * Written by hand rather than through `useCachedPromise` because what is
 * remembered is not what is shown: the list holds every note up to the vault
 * cap, while the cache holds the most recently modified few hundred per vault,
 * which is what keeps it inside the hook cache's budget.
 */
const library = new Cache({ namespace: 'library' })
const LIBRARY_KEY = 'library'

function readLibrary(): Library | undefined {
  const raw = library.get(LIBRARY_KEY)
  if (raw === undefined) return undefined
  try {
    return JSON.parse(raw) as Library
  } catch {
    return undefined
  }
}

function writeLibrary(data: Library): void {
  const kept: Note[] = []
  const counts = new Map<string, number>()
  // The notes arrive newest first per vault, so the first ones seen are the ones worth keeping.
  for (const note of data.notes) {
    const count = counts.get(note.vault) ?? 0
    if (count >= REMEMBERED_NOTES_PER_VAULT) continue
    counts.set(note.vault, count + 1)
    kept.push(note)
  }
  try {
    library.set(LIBRARY_KEY, JSON.stringify({ vaults: data.vaults, notes: kept }))
  } catch {
    // A library that will not serialise is not a reason to fail the load that produced it.
  }
}

const openNoteUrl = (path: string): string => 'obsidian://open?path=' + encodeURIComponent(path)
const openVaultUrl = (vault: Vault): string => 'obsidian://open?vault=' + encodeURIComponent(vault.id)

function CreateNoteForm(props: { vaults: Vault[]; onDone: () => void }): React.JSX.Element {
  const { pop } = useNavigation()
  const [nameError, setNameError] = useState<string | undefined>()

  return (
    <Form
      actions={
        <ActionPanel>
          <Action.SubmitForm
            title="Create Note"
            icon={Icon.Plus}
            onSubmit={async (values: { vault: string; name: string; content: string }) => {
              if (typeof values.vault !== 'string' || values.vault === '') {
                setNameError('No vault to create the note in')
                return
              }
              const name = values.name.trim().replace(/\.md$/, '')
              if (name === '' || name.includes('/')) {
                setNameError('A note needs a name without slashes')
                return
              }
              const path = join(values.vault, name + '.md')
              try {
                await writeFile(path, values.content, { flag: 'wx' })
              } catch (error) {
                const code = (error as NodeJS.ErrnoException).code
                setNameError(code === 'EEXIST' ? 'That note already exists' : 'Could not write the note')
                return
              }
              await showToast({ style: Toast.Style.Success, title: 'Note created', message: name })
              pop()
              props.onDone()
              await open(openNoteUrl(path))
            }}
          />
        </ActionPanel>
      }
    >
      <Form.Dropdown id="vault" title="Vault" defaultValue={props.vaults[0]?.path}>
        {props.vaults.map((vault) => (
          <Form.Dropdown.Item key={vault.path} value={vault.path} title={vault.name} />
        ))}
      </Form.Dropdown>
      <Form.TextField
        autoFocus
        id="name"
        title="Name"
        placeholder="Meeting notes"
        error={nameError}
        onChange={() => setNameError(undefined)}
      />
      <Form.TextArea id="content" title="Content" placeholder="# Heading" defaultValue="" />
    </Form>
  )
}

export default function SearchObsidian(props: {
  launchContext?: { category?: unknown }
}): React.JSX.Element {
  const requested = props.launchContext?.category
  const [category, setCategory] = useState(
    typeof requested === 'string' && CATEGORIES.some((entry) => entry.id === requested)
      ? requested
      : 'notes'
  )
  const { push } = useNavigation()
  const abortable = useRef<AbortController | null>(null)
  const remembered = useRef<Library | undefined>(undefined)
  remembered.current ??= readLibrary()
  const { isLoading, data, revalidate } = usePromise(async () => await loadAll(abortable.current?.signal), [], {
    abortable,
    ...(remembered.current === undefined ? {} : { initialData: remembered.current }),
    onData: writeLibrary
  })
  const vaults = data?.vaults ?? []
  const notes = data?.notes ?? []

  const createNote = useMemo(
    () =>
      vaults.length === 0 ? null : (
        <Action
          title="Create Note"
          icon={Icon.Plus}
          shortcut={{ modifiers: ['cmd'], key: 'n' }}
          onAction={() => {
            push(<CreateNoteForm vaults={vaults} onDone={revalidate} />)
            void clearSearchBar()
          }}
        />
      ),
    [vaults, push, revalidate]
  )

  const noteRows = useMemo(
    () =>
      notes.map((note) => (
        <List.Item
          key={note.path}
          id={note.path}
          title={note.name}
          subtitle={note.subtitle}
          icon="system:text-markdown,text-x-generic"
          actions={
            <ActionPanel>
              <ActionPanel.Section>
                <Action.Open title="Open in Obsidian" target={note.url} icon={Icon.Document} />
              </ActionPanel.Section>
              <ActionPanel.Section>
                {createNote}
                <Action.CopyToClipboard
                  title="Copy Path"
                  content={note.path}
                  shortcut={{ modifiers: ['cmd'], key: 'c' }}
                />
              </ActionPanel.Section>
            </ActionPanel>
          }
        />
      )),
    [notes, createNote]
  )

  const vaultRows = useMemo(
    () =>
      vaults.map((vault) => (
        <List.Item
          key={vault.path}
          id={vault.path}
          title={vault.name}
          subtitle={vault.path}
          icon="system:folder"
          actions={
            <ActionPanel>
              <ActionPanel.Section>
                <Action.Open title="Open Vault in Obsidian" target={openVaultUrl(vault)} icon={Icon.Window} />
              </ActionPanel.Section>
              <ActionPanel.Section>
                {createNote}
                <Action.CopyToClipboard
                  title="Copy Path"
                  content={vault.path}
                  shortcut={{ modifiers: ['cmd'], key: 'c' }}
                />
              </ActionPanel.Section>
            </ActionPanel>
          }
        />
      )),
    [vaults, createNote]
  )

  return (
    <List
      isLoading={isLoading}
      searchBarPlaceholder="Search notes and vaults"
      searchBarAccessory={
        <List.Dropdown tooltip="Category" value={category} onChange={setCategory}>
          {CATEGORIES.map((cat) => (
            <List.Dropdown.Item key={cat.id} value={cat.id} title={cat.title} />
          ))}
        </List.Dropdown>
      }
    >
      {category === 'notes' ? noteRows : vaultRows}
      <List.EmptyView
        icon={Icon.Document}
        title={category === 'notes' ? 'No notes found' : 'No vaults found'}
        description="Open Obsidian once and create a vault; it will show up here."
      />
    </List>
  )
}
