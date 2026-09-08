/**
 * Reading Valve's two on-disk formats.
 *
 * Steam writes everything it knows in KeyValues, in two encodings: the text one
 * (`appmanifest_*.acf`, `libraryfolders.vdf`, `localconfig.vdf`) and a binary
 * one (`appcache/appinfo.vdf`). Both parsers live here, both are hand-written,
 * and neither pulls in a package - that is the whole point of this plugin.
 *
 * Neither parser is allowed to throw on a file it does not understand. These
 * are caches Valve rewrites whenever it likes; a format bump must degrade the
 * list, never break the command.
 */

export type VdfNode = { [key: string]: string | VdfNode }

/**
 * Text KeyValues.
 *
 * Quoted keys and values, `{}` for nesting, `//` comments. Unquoted tokens are
 * legal in the format at large but Steam does not emit them in the files we
 * read, so anything that is not a quote or a brace is skipped as whitespace.
 */
export function parseTextVdf(text: string): VdfNode {
  const root: VdfNode = {}
  const stack: VdfNode[] = [root]
  let pendingKey: string | null = null
  let i = 0

  while (i < text.length) {
    const ch = text[i]

    if (ch === '"') {
      const [value, next] = readQuoted(text, i)
      i = next
      if (pendingKey === null) pendingKey = value
      else {
        stack[stack.length - 1]![pendingKey] = value
        pendingKey = null
      }
      continue
    }

    if (ch === '{') {
      const child: VdfNode = {}
      // A `{` with no key before it cannot be addressed later, so it is parsed
      // for its braces and dropped rather than treated as a syntax error.
      if (pendingKey !== null) {
        stack[stack.length - 1]![pendingKey] = child
        pendingKey = null
      }
      stack.push(child)
      i += 1
      continue
    }

    if (ch === '}') {
      if (stack.length > 1) stack.pop()
      i += 1
      continue
    }

    if (ch === '/' && text[i + 1] === '/') {
      const newline = text.indexOf('\n', i)
      i = newline === -1 ? text.length : newline + 1
      continue
    }

    i += 1
  }

  return root
}

/** Read one `"…"` token, honouring `\"` and `\\`. Returns the value and the index after it. */
function readQuoted(text: string, start: number): [string, number] {
  let out = ''
  let i = start + 1
  while (i < text.length) {
    const ch = text[i]!
    if (ch === '\\' && i + 1 < text.length) {
      const escaped = text[i + 1]!
      out += escaped === 'n' ? '\n' : escaped === 't' ? '\t' : escaped
      i += 2
      continue
    }
    if (ch === '"') return [out, i + 1]
    out += ch
    i += 1
  }
  return [out, i]
}

/**
 * Walk a path, comparing keys case-insensitively.
 *
 * Valve's own casing drifts between files and client versions - `Software`
 * under one key and `software` under the next - so an exact lookup silently
 * returns nothing on a machine where the casing happens to differ. Every read
 * in this plugin goes through here.
 */
export function dig(node: VdfNode | undefined, ...path: string[]): VdfNode | undefined {
  let current = node
  for (const segment of path) {
    if (current === undefined) return undefined
    const found = keyOf(current, segment)
    const next = found === undefined ? undefined : current[found]
    current = typeof next === 'object' ? next : undefined
  }
  return current
}

/** A leaf value, case-insensitively, or `undefined` if it is missing or a subtree. */
export function leaf(node: VdfNode | undefined, key: string): string | undefined {
  if (node === undefined) return undefined
  const found = keyOf(node, key)
  const value = found === undefined ? undefined : node[found]
  return typeof value === 'string' ? value : undefined
}

/**
 * The key as this node happens to spell it.
 *
 * The spelling we were given is tried first and is nearly always the one on
 * disk; only when it misses is the node scanned. Neither branch builds a key
 * array, which matters because `localconfig.vdf` alone is thousands of nodes
 * and every field of every one of them comes through here.
 */
function keyOf(node: VdfNode, key: string): string | undefined {
  if (Object.hasOwn(node, key)) return key
  const wanted = key.toLowerCase()
  for (const candidate in node) {
    if (candidate.length === wanted.length && candidate.toLowerCase() === wanted) return candidate
  }
  return undefined
}

export function num(node: VdfNode | undefined, key: string): number {
  const value = leaf(node, key)
  if (value === undefined) return 0
  const parsed = Number.parseInt(value, 10)
  return Number.isFinite(parsed) ? parsed : 0
}

export interface AppInfoEntry {
  readonly name: string
  /** Valve's `common.type`, lowercased: `game`, `tool`, `dlc`, `config`, `demo`, … */
  readonly type: string
}

/** Binary KeyValues value tags. `END` closes the current subtree. */
const enum Tag {
  Nested = 0,
  String = 1,
  Int32 = 2,
  Float32 = 3,
  Pointer = 4,
  WString = 5,
  Color = 6,
  UInt64 = 7,
  End = 8,
  Int64 = 10
}

/**
 * `appcache/appinfo.vdf` - Steam's cache of what every app in your library *is*.
 *
 * This is the only local file that names apps you have not installed, and the
 * only one that says whether an app is a game or a runtime. Without it the
 * installed list is eight rows of which five are Proton and the Steam Linux
 * Runtimes, so it is worth the parser.
 *
 * Three container versions are in the wild and the differences are small:
 * v27 has no string table; v28 adds a second (binary) SHA-1 to each app
 * header; v29 moves every key into a table at the end of the file and stores
 * `uint32` indices into it. Anything newer is refused up front rather than
 * mis-parsed.
 *
 * Each app header carries its own byte length, which is what makes this safe:
 * an app whose body we cannot read is skipped and the scan resumes at the next
 * one, so a single unfamiliar value type costs one row instead of the file.
 */
export function parseAppInfo(buffer: Buffer): Map<number, AppInfoEntry> {
  const apps = new Map<number, AppInfoEntry>()
  if (buffer.length < 8) return apps

  const magic = buffer.readUInt32LE(0)
  const version = magic & 0xff
  if ((magic & 0xffffff00) !== 0x07564400 || version < 0x27 || version > 0x29) return apps

  const hasStringTable = version >= 0x29
  const hasBinarySha = version >= 0x28

  let strings: string[] = []
  let offset = 8

  if (hasStringTable) {
    const tableOffset = Number(buffer.readBigInt64LE(offset))
    offset += 8
    if (tableOffset <= 0 || tableOffset + 4 > buffer.length) return apps
    strings = readStringTable(buffer, tableOffset)
    if (strings.length === 0) return apps
  }

  // appid(4) + size(4) is the frame; everything below is inside one app.
  while (offset + 8 <= buffer.length) {
    const appid = buffer.readUInt32LE(offset)
    if (appid === 0) break
    const size = buffer.readUInt32LE(offset + 4)
    const body = offset + 8
    const nextApp = body + size
    if (size === 0 || nextApp > buffer.length) break

    // infoState(4) lastUpdated(4) picsToken(8) textSha1(20) changeNumber(4) [binarySha1(20)]
    const kvStart = body + 4 + 4 + 8 + 20 + 4 + (hasBinarySha ? 20 : 0)
    if (kvStart < nextApp) {
      const entry = readCommon(buffer, kvStart, nextApp, strings, hasStringTable)
      if (entry !== null) apps.set(appid, entry)
    }

    offset = nextApp
  }

  return apps
}

function readStringTable(buffer: Buffer, tableOffset: number): string[] {
  const count = buffer.readUInt32LE(tableOffset)
  // A plausibility bound: the table is one string per distinct key in the whole
  // file. A wild count means we mis-read the offset, and allocating on it would
  // be the parser's only way to hurt anything.
  if (count > 1_000_000) return []

  const strings: string[] = new Array<string>(count)
  let offset = tableOffset + 4
  for (let i = 0; i < count; i += 1) {
    const end = buffer.indexOf(0, offset)
    if (end === -1) return strings.slice(0, i)
    strings[i] = buffer.toString('utf8', offset, end)
    offset = end + 1
  }
  return strings
}

/**
 * Pull `appinfo.common.{name,type}` out of one app's binary KeyValues blob.
 *
 * Written as a scan rather than a tree build on purpose: this runs over ~1100
 * apps on every command launch, and the other 99% of each blob - depots,
 * launch configs, localised descriptions - would be allocated and thrown away.
 * Depth tracking is all that is needed to know which `name` is the right one.
 */
function readCommon(
  buffer: Buffer,
  start: number,
  limit: number,
  strings: readonly string[],
  indexedKeys: boolean
): AppInfoEntry | null {
  // The path we care about: root → "appinfo" → "common".
  const path: string[] = []
  let name: string | undefined
  let type: string | undefined
  let offset = start

  while (offset < limit) {
    const tag = buffer.readUInt8(offset)
    offset += 1

    if (tag === Tag.End) {
      if (path.length === 0) break
      path.pop()
      continue
    }

    let key: string
    if (indexedKeys) {
      if (offset + 4 > limit) return null
      const index = buffer.readUInt32LE(offset)
      offset += 4
      const resolved = strings[index]
      if (resolved === undefined) return null
      key = resolved
    } else {
      const end = buffer.indexOf(0, offset)
      if (end === -1 || end >= limit) return null
      key = buffer.toString('utf8', offset, end)
      offset = end + 1
    }

    if (tag === Tag.Nested) {
      path.push(key.toLowerCase())
      continue
    }

    // `common` sits at appinfo → common; nothing else in the blob is read.
    const inCommon = path.length === 2 && path[0] === 'appinfo' && path[1] === 'common'

    switch (tag) {
      case Tag.String:
      case Tag.WString: {
        const end = buffer.indexOf(0, offset)
        if (end === -1 || end > limit) return null
        if (inCommon && (key === 'name' || key === 'type')) {
          const value = buffer.toString('utf8', offset, end)
          if (key === 'name') name = value
          else type = value
        }
        offset = end + 1
        break
      }
      case Tag.Int32:
      case Tag.Float32:
      case Tag.Pointer:
      case Tag.Color:
        offset += 4
        break
      case Tag.UInt64:
      case Tag.Int64:
        offset += 8
        break
      default:
        // An unknown tag makes every following byte meaningless. Give up on
        // this app; the caller resumes at the next one from its recorded size.
        return null
    }

    if (name !== undefined && type !== undefined) break
  }

  if (name === undefined) return null
  return { name, type: (type ?? '').toLowerCase() }
}
