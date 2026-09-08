/**
 * The hosts your ssh config already knows, as a list.
 *
 * Reads ~/.ssh/config (or the file the preference points at), follows Include
 * directives a few levels deep, and skips wildcard patterns - a row is something
 * you can actually connect to. No network, no dependencies.
 */
import {
  Action,
  ActionPanel,
  Icon,
  List,
  Toast,
  closeMainWindow,
  getPreferenceValues,
  showToast,
  usePromise
} from 'lumanin'
import { useMemo, useState } from 'react'
import { spawn } from 'node:child_process'
import { readFile, readdir } from 'node:fs/promises'
import { homedir } from 'node:os'
import { basename, dirname, isAbsolute, join } from 'node:path'

const CATEGORIES = [{ id: 'hosts', title: 'Hosts' }] as const

interface Preferences {
  configPath?: string
  terminal?: string
}

interface Host {
  /** The alias after `Host` - the stable id of a row, and what ssh is given. */
  alias: string
  hostname: string
  user: string
  port: string
  /** The ssh argv this row connects with; `command` is the same line quoted for a shell. */
  argv: string[]
  command: string
  /** What the row shows, and the shorter spelling the copy action hands over. */
  destination: string
  target: string
}

/** One `Host` block in source order; resolution walks these first-match-wins, as ssh does. */
interface Block {
  /** Patterns of the block an `Include` was seen in; `['*']` at top level. */
  guard: string[]
  patterns: string[]
  hostname: string
  user: string
  port: string
}

/**
 * Compiled once per distinct pattern: resolution asks every block about every
 * alias, so a config of fifty hosts is thousands of these and each one was a
 * fresh RegExp.
 */
const compiled = new Map<string, RegExp>()

const patternRegExp = (pattern: string): RegExp => {
  let expression = compiled.get(pattern)
  if (expression === undefined) {
    expression = new RegExp(
      '^' + pattern.split('').map((ch) => (ch === '*' ? '.*' : ch === '?' ? '.' : ch.replace(/[.+^${}()|[\]\\]/g, '\\$&'))).join('') + '$'
    )
    compiled.set(pattern, expression)
  }
  return expression
}

const matchesPattern = (alias: string, pattern: string): boolean => patternRegExp(pattern).test(alias)

/**
 * ssh_config semantics: a `!` pattern that matches the alias vetoes the whole
 * block, whatever else in its list matched — `Host * !vps` applies to
 * everything except `vps`.
 */
const blockApplies = (alias: string, patterns: string[]): boolean => {
  let matched = false
  for (const pattern of patterns) {
    if (pattern.startsWith('!')) {
      if (matchesPattern(alias, pattern.slice(1))) return false
    } else if (matchesPattern(alias, pattern)) matched = true
  }
  return matched
}

const expandHome = (path: string): string =>
  path === '~' || path.startsWith('~/') ? join(homedir(), path.slice(1)) : path

const defaultConfigPath = (): string => join(homedir(), '.ssh/config')

/**
 * `-F` makes ssh ignore `/etc/ssh/ssh_config`, so it is passed only when the
 * preference points somewhere other than the default; the default file is read
 * anyway, together with the system-wide one, exactly as from a shell.
 */
function sshArgs(alias: string, pref: string): string[] {
  const file = pref ? expandHome(pref) : ''
  const explicit = file !== '' && file !== defaultConfigPath()
  return ['ssh', ...(explicit ? ['-F', file] : []), '--', alias]
}

const shellQuote = (argv: string[]): string =>
  argv
    .map((arg) => (/^[A-Za-z0-9_@%+=:,./-]+$/.test(arg) ? arg : "'" + arg.replace(/'/g, "'\\''") + "'"))
    .join(' ')

/**
 * One ssh_config line: keyword lower-cased, values with their quotes removed,
 * an unquoted `#` tail dropped. Null for blank and comment lines.
 */
function tokenize(raw: string): { key: string; values: string[] } | null {
  const line = raw.trim()
  if (line === '' || line.startsWith('#')) return null
  let quoted = false
  let end = line.length
  for (let i = 0; i < line.length; i++) {
    if (line[i] === '"') quoted = !quoted
    else if (line[i] === '#' && !quoted) {
      end = i
      break
    }
  }
  const head = line.slice(0, end).match(/^([^\s=]+)\s*=?\s*(.*)$/)
  if (!head) return null
  const values: string[] = []
  let token = ''
  let started = false
  quoted = false
  for (const ch of head[2]) {
    if (ch === '"') {
      quoted = !quoted
      started = true
    } else if (/\s/.test(ch) && !quoted) {
      if (started) values.push(token)
      token = ''
      started = false
    } else {
      token += ch
      started = true
    }
  }
  if (started) values.push(token)
  return { key: head[1].toLowerCase(), values }
}

/**
 * The files one `Include` names, in the order ssh would read them.
 *
 * A directive is usually a directory of small files, so they are read at once
 * rather than one round trip after another. Parsing them stays in order: an
 * included file continues the block it was included from, and first value wins.
 */
async function readIncluded(values: string[]): Promise<string[]> {
  const groups = await Promise.all(
    values.map(async (item) => {
      const expanded = expandHome(item)
      const target = isAbsolute(expanded) ? expanded : join(homedir(), '.ssh', expanded)
      const name = basename(target)
      if (!/[*?]/.test(name)) return [target]
      try {
        return (await readdir(dirname(target)))
          .filter((entry) => matchesPattern(entry, name))
          .sort((a, b) => a.localeCompare(b))
          .map((entry) => join(dirname(target), entry))
      } catch {
        return []
      }
    })
  )
  return groups.flat()
}

/** ssh config: `Key value` lines, `Host` starts a block, `Include` pulls in more files. */
async function parseConfig(
  path: string,
  depth: number,
  blocks: Block[],
  guard: string[],
  current: Block | null = null
): Promise<Block | null> {
  let text: string
  try {
    text = await readFile(path, 'utf8')
  } catch {
    // An unreadable file closes nothing: the block the parent had open stays open.
    return current
  }
  return await parseLines(text, depth, blocks, guard, current)
}

/**
 * Returns the block still open when the text ends. ssh_config is textual
 * inclusion: an included file's lines behave as if pasted in place, so a
 * `Host` opened inside a fragment stays open in the file that included it.
 */
async function parseLines(
  text: string,
  depth: number,
  blocks: Block[],
  guard: string[],
  current: Block | null
): Promise<Block | null> {
  const open = (patterns: string[]): Block => {
    const block = { guard, patterns, hostname: '', user: '', port: '' }
    blocks.push(block)
    return block
  }
  for (const raw of text.split('\n')) {
    const parsed = tokenize(raw)
    if (!parsed) continue
    const { key, values } = parsed
    const value = values.join(' ')

    if (key === 'include' && depth < 3) {
      // An included file continues the block it was included from, so its own Host lines inherit that block's guard.
      // Each fragment continues where the previous one stopped, and the last one's open block continues here.
      const nested = current ? current.patterns : guard
      const paths = await readIncluded(values)
      const texts = await Promise.all(paths.map(async (path) => await readFile(path, 'utf8').catch(() => null)))
      for (const included of texts) {
        if (included === null) continue
        current = await parseLines(included, depth + 1, blocks, nested, current)
      }
      continue
    }
    if (key === 'host') {
      current = open(values)
      continue
    }
    if (key === 'match') {
      // Only what can be decided from the alias alone; every other criterion needs a live connection.
      const criterion = values[0]?.toLowerCase()
      if (criterion === 'all' && values.length === 1) current = open(['*'])
      else if (criterion === 'host' && values.length === 2) current = open(values[1].split(','))
      else current = null
      continue
    }
    if (current === null) continue
    if (key === 'hostname' && current.hostname === '') current.hostname = value
    if (key === 'user' && current.user === '') current.user = value
    if (key === 'port' && current.port === '') current.port = value
  }
  return current
}

async function loadHosts(): Promise<Host[]> {
  // Read once here, not per row: a preference lookup crosses to the host process.
  const pref = getPreferenceValues<Preferences>().configPath?.trim() ?? ''
  const blocks: Block[] = []
  // The returned cursor is unused: at the top level there is nothing to continue into.
  await parseConfig(expandHome(pref || '~/.ssh/config'), 0, blocks, ['*'])
  // A row is a concrete alias; wildcard patterns only contribute values below.
  const aliases: string[] = []
  const seen = new Set<string>()
  for (const block of blocks)
    for (const pattern of block.patterns)
      if (!/[*?!]/.test(pattern) && !seen.has(pattern)) {
        seen.add(pattern)
        aliases.push(pattern)
      }
  // ssh semantics: walk blocks in file order, first obtained value wins per option.
  const hosts = aliases.map((alias) => {
    let hostname = ''
    let user = ''
    let port = ''
    for (const block of blocks) {
      if (!blockApplies(alias, block.guard) || !blockApplies(alias, block.patterns)) continue
      if (hostname === '') hostname = block.hostname
      if (user === '') user = block.user
      if (port === '') port = block.port
    }
    const argv = sshArgs(alias, pref)
    const target = (user ? user + '@' : '') + (hostname || alias)
    return {
      alias,
      hostname,
      user,
      port,
      argv,
      command: shellQuote(argv),
      destination: target + (port ? ':' + port : ''),
      target
    }
  })
  return hosts.sort((a, b) => a.alias.localeCompare(b.alias))
}

/** Open an argv in a new terminal window, honouring the preference, then $TERMINAL. */
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

export default function SearchSshHosts(props: {
  launchContext?: { category?: unknown }
}): React.JSX.Element {
  const requested = props.launchContext?.category
  const [category, setCategory] = useState(
    typeof requested === 'string' && CATEGORIES.some((entry) => entry.id === requested)
      ? requested
      : 'hosts'
  )
  const { isLoading, data } = usePromise(loadHosts, [])
  void category

  const rows = useMemo(
    () =>
      (data ?? []).map((host) => (
        <List.Item
          key={host.alias}
          id={host.alias}
          title={host.alias}
          subtitle={host.destination}
          keywords={[host.hostname, host.user, host.target].filter((part) => part !== '')}
          icon="system:network-server,utilities-terminal"
          actions={
            <ActionPanel>
              <ActionPanel.Section>
                <Action title="Connect in Terminal" icon={Icon.Terminal} onAction={() => openInTerminal(host.argv)} />
              </ActionPanel.Section>
              <ActionPanel.Section>
                <Action.CopyToClipboard
                  title="Copy Destination"
                  content={host.target}
                  shortcut={{ modifiers: ['cmd'], key: 'c' }}
                />
                <Action.CopyToClipboard
                  title="Copy SSH Command"
                  content={host.command}
                  shortcut={{ modifiers: ['cmd'], key: 's' }}
                />
              </ActionPanel.Section>
            </ActionPanel>
          }
        />
      )),
    [data]
  )

  return (
    <List
      isLoading={isLoading}
      searchBarPlaceholder="Search ssh hosts"
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
        icon={Icon.Terminal}
        title="No hosts found"
        description="Add Host blocks to ~/.ssh/config and they will show up here."
      />
    </List>
  )
}
