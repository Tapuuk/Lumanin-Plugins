/**
 * Your Godot projects, as a list.
 *
 * Everything here comes off this machine: Godot's own project-manager list at
 * `$XDG_DATA_HOME/godot/projects.cfg`, and each project's `project.godot` for
 * its name, engine version and renderer. No network, no dependencies.
 *
 * The category contract: the manifest declares `projects` and `favorites`, the
 * dropdown switches between them, a launch from a pinned category arrives in
 * `launchContext.category`, and every item's `id` is the project path — so a
 * single project can be pinned from `lumanin config` and bound to a key.
 */
import {
  Action,
  ActionPanel,
  Color,
  Detail,
  Icon,
  List,
  Toast,
  getPreferenceValues,
  showHUD,
  showToast,
  usePromise,
  useNavigation
} from 'lumanin'
import { useMemo, useRef, useState, type ComponentProps } from 'react'
import { spawn } from 'node:child_process'
import { readFile, readdir, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

/** The accessory type as the component takes it: `List` here is a value, not a namespace. */
type Accessory = NonNullable<ComponentProps<typeof List.Item>['accessories']>[number]

const CATEGORIES = [
  { id: 'projects', title: 'All Projects' },
  { id: 'favorites', title: 'Favorites' }
] as const

interface Preferences {
  godotBinary?: string
  extraProjectsDir?: string
}

interface Project {
  /** Absolute path to the project directory — the stable id of a row. */
  path: string
  name: string
  description: string
  favorite: boolean
  /** false when the directory no longer holds a project.godot. */
  exists: boolean
  /** First entry of config/features, e.g. "4.7". */
  engine: string
  /** "Forward Plus" | "Mobile" | "GL Compatibility", when the project pins one. */
  renderer: string
  /** The remaining feature tags, e.g. "C#", "Double Precision". */
  features: string[]
  mainScene: string
  autoloads: [string, string][]
  /** mtime of project.godot: the editor rewrites it on edit, never on run. */
  touched: number
  /** The project's own icon as a data URI, when config/icon points at a real file. */
  icon?: string
  /** The row's path, with $HOME written back as `~`. */
  subtitle: string
  /** The row's tags: "missing", or the features, renderer and engine. */
  accessories: Accessory[]
  /** What the row draws: the project's icon, or the glyph standing in for it. */
  listIcon: string
}

const home = homedir()

const TOUCHED_FORMAT = new Intl.DateTimeFormat(undefined, {
  year: 'numeric',
  month: 'numeric',
  day: 'numeric',
  hour: 'numeric',
  minute: 'numeric',
  second: 'numeric'
})

const dataHome = process.env.XDG_DATA_HOME ?? join(homedir(), '.local', 'share')
const configHome = process.env.XDG_CONFIG_HOME ?? join(homedir(), '.config')

/** The preference may carry its own arguments: `flatpak run org.godotengine.Godot`. */
function godotBinary(): string[] {
  const preferred = getPreferenceValues<Preferences>().godotBinary?.trim()
  return preferred ? preferred.split(/\s+/) : ['godot']
}

/** The `.cfg`/`.godot` files are INI: `[section]` then single-line `key=value`. */
function parseIni(text: string): Map<string, Map<string, string>> {
  const sections = new Map<string, Map<string, string>>()
  let current = new Map<string, string>()
  sections.set('', current)

  for (const raw of text.split('\n')) {
    const line = raw.trim()
    if (line === '' || line.startsWith(';') || line.startsWith('#')) continue

    if (line.startsWith('[') && line.endsWith(']')) {
      current = new Map()
      sections.set(line.slice(1, -1), current)
      continue
    }
    // Only plain single-line assignments; a multi-line value's continuation
    // lines simply do not match and are skipped.
    const eq = line.indexOf('=')
    if (eq <= 0) continue
    const key = line.slice(0, eq).trim()
    if (!/^[A-Za-z_][\w/.-]*$/.test(key)) continue
    current.set(key, line.slice(eq + 1).trim())
  }
  return sections
}

const SHORT_ESCAPES: Record<string, string> = { n: '\n', t: '\t', r: '\r', b: '\b', f: '\f' }

/** A quoted Godot string: outer quotes off, `\"` `\\` `\n` `\t` `\r` `\b` `\f` `\uXXXX` `\UXXXXXX` decoded. */
function unescapeString(value: string | undefined): string {
  if (value === undefined) return ''
  return value
    .replace(/^"(.*)"$/s, '$1')
    .replace(/\\(?:u([0-9A-Fa-f]{4})|U([0-9A-Fa-f]{6})|(.))/gs, (_, u4, u6, char) => {
      if (u4 !== undefined || u6 !== undefined) return String.fromCodePoint(parseInt(u4 ?? u6, 16))
      return SHORT_ESCAPES[char] ?? char
    })
}

/** `PackedStringArray("4.7", "Mobile")` → `["4.7", "Mobile"]`. */
function packedStrings(value: string | undefined): string[] {
  if (value === undefined) return []
  return [...value.matchAll(/"([^"]*)"/g)].map((match) => match[1])
}

const RENDERERS = new Set(['Forward Plus', 'Mobile', 'GL Compatibility'])

async function mtimeOf(path: string): Promise<number> {
  try {
    return (await stat(path)).mtimeMs
  } catch {
    return 0
  }
}

/** How big a project icon may be before inlining it costs more than a glyph. */
const MAX_ICON_BYTES = 16 * 1024

/**
 * A project's own icon, as a `data:` URI.
 *
 * Every Godot project names one in `config/icon` — `res://icon.svg` on a fresh
 * project, whatever the author replaced it with later — and it is the thing
 * that tells two projects apart at a glance. The renderer is only handed URLs,
 * never filesystem paths, so the file has to be inlined; the default is about a
 * kilobyte of SVG, and anything past 16 KB is left to the glyph rather than
 * pushed through a render patch on every keystroke. The size is settled by a
 * `stat` first: an oversized icon is then never read at all.
 */
async function readIcon(dir: string, source: string): Promise<string | undefined> {
  // A `uid://` icon resolves only through the binary `.godot/uid_cache.bin`.
  if (source.startsWith('uid://')) return undefined
  const relative = source.replace(/^res:\/\//, '')
  // Anything not under the project (an absolute path, a `..` escape, a
  // `user://` icon) is not this project's face to draw.
  if (relative === '' || relative.startsWith('/') || relative.split('/').includes('..')) {
    return undefined
  }

  const types: Record<string, string> = {
    svg: 'image/svg+xml',
    png: 'image/png',
    jpg: 'image/jpeg',
    jpeg: 'image/jpeg',
    webp: 'image/webp'
  }
  const type = types[relative.split('.').pop()?.toLowerCase() ?? '']
  if (type === undefined) return undefined

  try {
    const file = join(dir, relative)
    const size = (await stat(file)).size
    if (size === 0 || size > MAX_ICON_BYTES) return undefined
    const bytes = await readFile(file)
    return `data:${type};base64,${bytes.toString('base64')}`
  } catch {
    // An icon the project names but does not ship.
    return undefined
  }
}

/** Everything a row needs beyond the parsed project, worked out once per load. */
type ProjectData = Omit<Project, 'subtitle' | 'accessories' | 'listIcon'>

function accessories(project: ProjectData): Accessory[] {
  if (!project.exists) return [{ tag: { value: 'missing', color: Color.Red } }]

  const tags = [...project.features]
  if (project.renderer) tags.push(project.renderer)
  if (project.engine) tags.push(project.engine)

  return tags.map((tag) => ({ tag: { value: tag, color: Color.SecondaryText } }))
}

/**
 * `$HOME` as `~`, prefix-anchored: a path that merely contains the home string
 * further in (`/mnt/backup/home/me/x`) is returned unchanged.
 */
export function tilde(path: string, home: string): string {
  return path === home ? '~' : path.startsWith(home + '/') ? '~' + path.slice(home.length) : path
}

/**
 * The row's own fields, computed here rather than while rendering.
 *
 * The list is re-rendered on every keystroke the launcher filters, so the tags,
 * the `~` substitution (`tilde`) and the icon choice are settled once, on load.
 */
function decorate(project: ProjectData): Project {
  return {
    ...project,
    subtitle: tilde(project.path, home),
    accessories: accessories(project),
    listIcon: !project.exists
      ? Icon.Warning
      : (project.icon ?? (project.favorite ? Icon.StarCircle : Icon.Code))
  }
}

async function readProject(
  dir: string,
  favorite: boolean,
  signal?: AbortSignal
): Promise<Project> {
  const fallback: ProjectData = {
    path: dir,
    name: dir.split('/').filter(Boolean).pop() ?? dir,
    description: '',
    favorite,
    exists: false,
    engine: '',
    renderer: '',
    features: [],
    mainScene: '',
    autoloads: [],
    touched: 0
  }

  signal?.throwIfAborted()

  let text: string
  try {
    text = await readFile(join(dir, 'project.godot'), 'utf8')
  } catch {
    return decorate(fallback)
  }

  const ini = parseIni(text)
  const application = ini.get('application') ?? new Map<string, string>()
  const [listedEngine = '', ...rest] = packedStrings(application.get('config/features'))
  // Godot 3 wrote no features; its config_version is what identifies it.
  const engine = listedEngine || (ini.get('')?.get('config_version') === '4' ? '3.x' : '')

  const [touched, icon] = await Promise.all([
    mtimeOf(join(dir, 'project.godot')),
    readIcon(dir, unescapeString(application.get('config/icon')))
  ])

  return decorate({
    ...fallback,
    exists: true,
    name: unescapeString(application.get('config/name')) || fallback.name,
    description: unescapeString(application.get('config/description')),
    engine,
    renderer: rest.find((feature) => RENDERERS.has(feature)) ?? '',
    features: rest.filter((feature) => !RENDERERS.has(feature)),
    mainScene: unescapeString(application.get('run/main_scene')),
    autoloads: [...(ini.get('autoload') ?? new Map<string, string>())].map(
      ([name, value]) => [name, unescapeString(value).replace(/^\*/, '')] as [string, string]
    ),
    touched,
    ...(icon === undefined ? {} : { icon })
  })
}

/** Godot's own list: section headers are project directories. */
async function listedProjects(): Promise<Map<string, boolean>> {
  const found = new Map<string, boolean>()
  let text: string
  try {
    text = await readFile(join(dataHome, 'godot', 'projects.cfg'), 'utf8')
  } catch {
    return found
  }
  for (const [section, keys] of parseIni(text)) {
    if (section.startsWith('/')) found.set(section, keys.get('favorite') === 'true')
  }
  return found
}

/** Directories that never hold a project and are expensive to walk into. */
const SKIP_DIRS = new Set(['node_modules', '.git', 'target', 'build', 'dist', '.venv'])

/** The optional preference: any project.godot at most two levels down. */
async function scannedProjects(root: string, signal?: AbortSignal): Promise<string[]> {
  const found: string[] = []
  const walk = async (dir: string, depth: number): Promise<void> => {
    if (signal?.aborted) return
    let entries
    try {
      entries = await readdir(dir, { withFileTypes: true })
    } catch {
      return
    }
    if (entries.some((entry) => entry.isFile() && entry.name === 'project.godot')) {
      found.push(dir)
      return
    }
    if (depth === 0) return
    for (const entry of entries) {
      if (entry.name.startsWith('.') || SKIP_DIRS.has(entry.name)) continue
      const entryPath = join(dir, entry.name)
      if (entry.isDirectory()) {
        await walk(entryPath, depth - 1)
      } else if (entry.isSymbolicLink()) {
        const followed = await stat(entryPath).catch(() => null)
        if (followed?.isDirectory()) await walk(entryPath, depth - 1)
      }
    }
  }
  await walk(root, 2)
  return found
}

/** Godot's own "Autoscan Project Path" editor setting, from the newest 4.x settings file. */
async function autoscanDir(): Promise<string | null> {
  const godotConfig = join(configHome, 'godot')
  let names: string[]
  try {
    names = await readdir(godotConfig)
  } catch {
    return null
  }
  // Each minor version keeps its own file; the highest is the editor in use.
  const minorOf = (name: string): number =>
    Number(/^editor_settings-4\.(\d+)\.tres$/.exec(name)?.[1] ?? NaN)
  const newest = names
    .filter((name) => !Number.isNaN(minorOf(name)))
    .sort((a, b) => minorOf(b) - minorOf(a))[0]
  if (newest === undefined) return null

  let text: string
  try {
    text = await readFile(join(godotConfig, newest), 'utf8')
  } catch {
    return null
  }
  const value = unescapeString(
    parseIni(text).get('resource')?.get('filesystem/directories/autoscan_project_path')
  ).trim()
  return value === '' ? null : value
}

async function loadProjects(signal?: AbortSignal): Promise<Project[]> {
  const extra = getPreferenceValues<Preferences>().extraProjectsDir?.trim()
  const [listed, autoscan] = await Promise.all([listedProjects(), autoscanDir()])
  signal?.throwIfAborted()

  const roots = [autoscan, extra].filter((root): root is string => Boolean(root))
  for (const dirs of await Promise.all(roots.map((root) => scannedProjects(root, signal)))) {
    for (const dir of dirs) {
      if (!listed.has(dir)) listed.set(dir, false)
    }
  }
  signal?.throwIfAborted()

  const projects = await Promise.all(
    [...listed].map(([dir, favorite]) => readProject(dir, favorite, signal))
  )

  return projects.sort((a, b) => b.touched - a.touched || a.name.localeCompare(b.name))
}

/** `godot --path <dir> [-e]`, detached so it outlives this worker. */
async function launch(project: Project, mode: 'edit' | 'run'): Promise<void> {
  const [program = 'godot', ...prefix] = godotBinary()
  const args = mode === 'edit' ? ['--path', project.path, '-e'] : ['--path', project.path]

  // The list was loaded once; a project that vanished since is reported, not
  // celebrated. The detached child cannot tell us, so the path is checked here.
  try {
    await stat(join(project.path, 'project.godot'))
  } catch {
    await showToast({
      style: Toast.Style.Failure,
      title: `${project.name} is no longer there`,
      message: project.path
    })
    return
  }

  try {
    await new Promise<void>((resolve, reject) => {
      const child = spawn(program, [...prefix, ...args], { detached: true, stdio: 'ignore' })
      child.once('spawn', () => {
        child.unref()
        resolve()
      })
      child.once('error', reject)
    })
  } catch (error) {
    await showToast({
      style: Toast.Style.Failure,
      title: `Could not start ${program}`,
      message: error instanceof Error ? error.message : String(error)
    })
    return
  }

  // `showHUD` hides the panel, and hiding it ends this session — so it goes
  // last, after the child is detached and safely on its own.
  await showHUD(mode === 'edit' ? `Opening ${project.name} in Godot` : `Running ${project.name}`)
}

function ProjectDetail({ project }: { project: Project }) {
  const autoloads = project.autoloads.length
    ? project.autoloads.map(([name, path]) => `- \`${name}\` - ${path}`).join('\n')
    : '_None._'

  const markdown = [
    `# ${project.name}`,
    project.description || '',
    '## Autoloads',
    autoloads
  ]
    .filter(Boolean)
    .join('\n\n')

  return (
    <Detail
      markdown={markdown}
      navigationTitle={project.name}
      metadata={
        <Detail.Metadata>
          <Detail.Metadata.Label title="Path" text={project.path} />
          <Detail.Metadata.Label title="Engine" text={project.engine || 'unknown'} />
          {project.renderer !== '' && (
            <Detail.Metadata.Label title="Renderer" text={project.renderer} />
          )}
          {project.features.length > 0 && (
            <Detail.Metadata.TagList title="Features">
              {project.features.map((feature) => (
                <Detail.Metadata.TagList.Item key={feature} text={feature} />
              ))}
            </Detail.Metadata.TagList>
          )}
          <Detail.Metadata.Label title="Main Scene" text={project.mainScene || 'not set'} />
          {project.touched > 0 && (
            <Detail.Metadata.Label title="Last Touched" text={TOUCHED_FORMAT.format(project.touched)} />
          )}
        </Detail.Metadata>
      }
      actions={
        <ActionPanel>
          <Action
            title="Open in Editor"
            icon={Icon.Pencil}
            onAction={() => launch(project, 'edit')}
          />
          <Action title="Run Project" icon={Icon.Play} onAction={() => launch(project, 'run')} />
          <Action.CopyToClipboard title="Copy Path" content={project.path} />
        </ActionPanel>
      }
    />
  )
}

export default function Command(props: { launchContext?: { category?: string } }) {
  // A launch from a pinned category (or a hotkey) says where to start; the
  // dropdown owns it from there.
  const requested = props.launchContext?.category
  const [category, setCategory] = useState(
    typeof requested === 'string' && CATEGORIES.some((entry) => entry.id === requested)
      ? requested
      : 'projects'
  )
  const abortable = useRef<AbortController | null>(null)
  const { data, error, isLoading } = usePromise(
    () => loadProjects(abortable.current?.signal),
    [],
    { abortable }
  )
  const projects = useMemo(
    () => (data ?? []).filter((project) => category !== 'favorites' || project.favorite),
    [data, category]
  )
  const { push } = useNavigation()

  return (
    <List
      isLoading={isLoading}
      searchBarPlaceholder="Filter Godot projects"
      searchBarAccessory={
        <List.Dropdown tooltip="Category" value={category} onChange={setCategory}>
          {CATEGORIES.map((entry) => (
            <List.Dropdown.Item key={entry.id} title={entry.title} value={entry.id} />
          ))}
        </List.Dropdown>
      }
    >
      {error !== undefined && (
        <List.EmptyView
          icon={Icon.Warning}
          title="Could not read your project list"
          description={error.message}
        />
      )}
      {error === undefined && !isLoading && projects.length === 0 && (
        <List.EmptyView
          icon={category === 'favorites' ? Icon.StarCircle : Icon.Folder}
          title={category === 'favorites' ? 'No favorite projects' : 'No Godot projects found'}
          description={
            category === 'favorites'
              ? 'Star a project in Godot’s project manager and it shows up here.'
              : 'Open a project once in Godot’s project manager, or set “Also Scan Folder” in lumanin plugins.'
          }
        />
      )}
      {projects.map((project) => (
        <List.Item
          key={project.path}
          id={project.path}
          title={project.name}
          subtitle={project.subtitle}
          icon={project.listIcon}
          accessories={project.accessories}
          actions={
            // Two panels side by side: the action order is the keyboard layout,
            // and a missing project's Enter must not pretend to start an editor.
            project.exists ? (
              <ActionPanel>
                <Action
                  title="Open in Editor"
                  icon={Icon.Pencil}
                  onAction={() => launch(project, 'edit')}
                />
                <Action
                  title="Run Project"
                  icon={Icon.Play}
                  shortcut={{ modifiers: ['cmd'], key: 'r' }}
                  onAction={() => launch(project, 'run')}
                />
                <Action
                  title="Project Details"
                  icon={Icon.Document}
                  shortcut={{ modifiers: ['cmd'], key: 'i' }}
                  onAction={() => push(<ProjectDetail project={project} />)}
                />
                <ActionPanel.Section>
                  <Action.Open title="Open Folder" target={project.path} icon={Icon.Folder} />
                  <Action.CopyToClipboard title="Copy Path" content={project.path} />
                </ActionPanel.Section>
              </ActionPanel>
            ) : (
              <ActionPanel>
                <ActionPanel.Section>
                  <Action.CopyToClipboard title="Copy Path" content={project.path} />
                  <Action.Open
                    title="Open Containing Folder"
                    target={dirname(project.path)}
                    icon={Icon.Folder}
                  />
                </ActionPanel.Section>
                <ActionPanel.Section>
                  <Action
                    title="Project Details"
                    icon={Icon.Document}
                    shortcut={{ modifiers: ['cmd'], key: 'i' }}
                    onAction={() => push(<ProjectDetail project={project} />)}
                  />
                </ActionPanel.Section>
              </ActionPanel>
            )
          }
        />
      ))}
    </List>
  )
}
