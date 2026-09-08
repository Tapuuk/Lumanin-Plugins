/**
 * Everything this plugin knows, read off this machine.
 *
 * Four files, no network:
 *   steamapps/libraryfolders.vdf      where the libraries are
 *   steamapps/appmanifest_<id>.acf    what is installed, and how big
 *   appcache/appinfo.vdf              names and whether an app is a game
 *   userdata/<id>/config/localconfig.vdf   playtime and last played
 *
 * Steam is happy to run with any of these missing or half-written, so every
 * read here is best-effort: a file that will not parse costs the column it
 * would have filled, never the list.
 */
import { Cache } from 'lumanin'
import { readFile, readdir, realpath, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { basename, join } from 'node:path'
import { dig, leaf, num, parseAppInfo, parseTextVdf, type AppInfoEntry, type VdfNode } from './vdf'

export interface SteamApp {
  readonly appid: number
  readonly name: string
  /** What the row is filed under. Games, demos, applications, videos and music are games; everything else is a tool. */
  readonly kind: 'games' | 'tools'
  /** Absolute path to the install directory, or `null` if it has gone missing. */
  readonly installPath: string | null
  readonly sizeOnDisk: number
  /** Unix seconds; 0 means never. */
  readonly lastPlayed: number
  readonly playtimeMinutes: number
  readonly playtime2WeeksMinutes: number
  /** `StateFlags` says the install is not complete - an update or repair is pending. */
  readonly updatePending: boolean
  readonly libraryPath: string
}

const GAME_TYPES: ReadonlySet<string> = new Set(['game', 'demo', 'application', 'video', 'music'])

/** What Steam installs on Linux without being asked; named so a missing `appinfo.vdf` still keeps them out of Games. */
const RUNTIME_NAME_PREFIXES: readonly string[] = [
  'Proton',
  'Steam Linux Runtime',
  'Steamworks Common Redistributables'
]

function kindOf(info: AppInfoEntry | undefined, name: string, typesKnown: boolean): 'games' | 'tools' {
  if (info !== undefined) return GAME_TYPES.has(info.type) ? 'games' : 'tools'
  if (typesKnown) return 'games'
  return RUNTIME_NAME_PREFIXES.some((prefix) => name.startsWith(prefix)) ? 'tools' : 'games'
}

export interface SteamLibrary {
  readonly root: string
  readonly apps: readonly SteamApp[]
  /**
   * True when `appinfo.vdf` could not be read. Without it nothing can be told
   * apart from a runtime, so the list shows everything and the view says why.
   */
  readonly typesUnavailable: boolean
}

/**
 * Where Steam keeps its data.
 *
 * `~/.steam/steam` is a symlink the client maintains and is the most reliable
 * answer when it exists; the rest cover a plain native install, an XDG-moved
 * one, and the Flatpak. Snap deliberately is not here - it puts the same tree
 * under its own `.local/share` inside the sandbox, which this process cannot
 * see anyway.
 */
async function findRoot(): Promise<string | null> {
  const home = homedir()
  const dataHome = process.env['XDG_DATA_HOME'] ?? join(home, '.local', 'share')
  const candidates = [
    join(home, '.steam', 'steam'),
    join(home, '.steam', 'root'),
    join(dataHome, 'Steam'),
    join(home, '.local', 'share', 'Steam'),
    join(home, '.var', 'app', 'com.valvesoftware.Steam', 'data', 'Steam'),
    join(home, '.steam', 'debian-installation')
  ]

  // All six are asked at once and the first that answers still wins: they are
  // six stats, and five of them miss on any given machine.
  const found = await Promise.all(
    candidates.map(async (candidate) => {
      try {
        const info = await stat(join(candidate, 'steamapps'))
        if (!info.isDirectory()) return null
      } catch {
        // Not this one.
        return null
      }
      return await realpath(candidate).catch(() => candidate)
    })
  )
  return found.find((path) => path !== null) ?? null
}

/**
 * Every library folder, including the root one. Games live on other drives all
 * the time.
 *
 * Deduplicated by *resolved* path, which is not fussiness: the root found above
 * is usually `~/.steam/steam`, a symlink, while `libraryfolders.vdf` records
 * the same directory as `~/.local/share/Steam`. Comparing the strings says
 * those are two libraries, and every installed game gets listed twice.
 */
async function libraryPaths(root: string): Promise<string[]> {
  const candidates: string[] = [root]

  try {
    const text = await readFile(join(root, 'steamapps', 'libraryfolders.vdf'), 'utf8')
    const folders = dig(parseTextVdf(text), 'libraryfolders')
    for (const [key, entry] of Object.entries(folders ?? {})) {
      if (typeof entry === 'string') {
        // The older flat shape: the path sits directly under a numeric key.
        if (/^\d+$/.test(key)) candidates.push(entry)
        continue
      }
      if (typeof entry !== 'object') continue
      const path = leaf(entry, 'path')
      if (path !== undefined) candidates.push(path)
    }
  } catch {
    // No library file - the root library is still there.
  }

  // One round of resolution for the lot; a library on an unmounted drive is
  // kept under its own name, and the manifest read is what quietly finds
  // nothing there.
  const keys = await Promise.all(
    candidates.map(async (path) => (path.length === 0 ? '' : await realpath(path).catch(() => path)))
  )

  const paths: string[] = []
  const seen = new Set<string>()
  for (const [index, path] of candidates.entries()) {
    const key = keys[index]!
    if (path.length === 0 || seen.has(key)) continue
    seen.add(key)
    paths.push(path)
  }
  return paths
}

/** `StateFlags` bit 4 (`StateFullyInstalled`); bit 2 (`StateUpdateRequired`) alone under-detects a queued update, since Steam sets both bits while it waits. */
const STATE_FULLY_INSTALLED = 4
const STATE_UPDATE_REQUIRED = 2

async function readManifests(libraryPath: string): Promise<Map<number, RawInstall>> {
  const installs = new Map<number, RawInstall>()
  const steamapps = join(libraryPath, 'steamapps')

  let entries: string[]
  try {
    entries = await readdir(steamapps)
  } catch {
    // A library folder recorded for a drive that is not mounted right now.
    return installs
  }

  // The manifests are read together and recorded in directory order, so a
  // library of two hundred games is one round of reads rather than two hundred.
  const parsed = await Promise.all(
    entries
      .filter((entry) => entry.startsWith('appmanifest_') && entry.endsWith('.acf'))
      .map(async (entry) => {
        try {
          const text = await readFile(join(steamapps, entry), 'utf8')
          const state = dig(parseTextVdf(text), 'AppState')
          if (state === undefined) return null
          const appid = num(state, 'appid')
          if (appid === 0) return null
          const installDir = leaf(state, 'installdir') ?? ''
          return {
            appid,
            name: leaf(state, 'name') ?? `App ${appid}`,
            installPath: installDir === '' ? null : join(steamapps, 'common', installDir),
            sizeOnDisk: num(state, 'SizeOnDisk'),
            lastPlayed: num(state, 'LastPlayed'),
            updatePending:
              (num(state, 'StateFlags') & STATE_UPDATE_REQUIRED) !== 0 ||
              (num(state, 'StateFlags') & STATE_FULLY_INSTALLED) === 0,
            libraryPath
          } satisfies RawInstall
        } catch {
          // A manifest Steam is mid-write on. It will be there next refresh.
          return null
        }
      })
  )

  for (const install of parsed) {
    if (install !== null) installs.set(install.appid, install)
  }

  return installs
}

interface RawInstall {
  readonly appid: number
  readonly name: string
  readonly installPath: string | null
  readonly sizeOnDisk: number
  readonly lastPlayed: number
  readonly updatePending: boolean
  readonly libraryPath: string
}

/**
 * The names and types, kept between launches.
 *
 * `appinfo.vdf` is several megabytes and Steam rewrites it only when it learns
 * something new, so reading and scanning it on every launch is the most
 * expensive thing this plugin used to do. The parsed pairs are stored under the
 * file's modification time and size: while those two are unchanged the file is
 * not opened at all, and when they change the stale entry is dropped rather
 * than kept alongside its replacement.
 */
const appinfoCache = new Cache({ namespace: 'appinfo' })

async function readAppTypes(root: string): Promise<Map<number, AppInfoEntry>> {
  const path = join(root, 'appcache', 'appinfo.vdf')

  let key: string
  try {
    const info = await stat(path)
    key = `${info.mtimeMs}:${info.size}`
  } catch {
    return new Map()
  }

  const stored = appinfoCache.get(key)
  if (stored !== undefined) {
    try {
      return new Map(JSON.parse(stored) as [number, AppInfoEntry][])
    } catch {
      // Written by an older version of this plugin; re-read below.
    }
  }

  let entries: Map<number, AppInfoEntry>
  try {
    entries = parseAppInfo(await readFile(path))
  } catch {
    return new Map()
  }

  try {
    appinfoCache.clear({ notifySubscribers: false })
    appinfoCache.set(key, JSON.stringify([...entries]))
  } catch {
    // A cache that will not take the entry costs a slow launch, nothing more.
  }
  return entries
}

interface PlayRecord {
  readonly lastPlayed: number
  readonly playtimeMinutes: number
  readonly playtime2WeeksMinutes: number
}

/**
 * Which `userdata/<accountid>` directory belongs to the person using the
 * machine now.
 *
 * `loginusers.vdf` holds 64-bit Steam IDs; the userdata directory is named
 * with the low 32 bits of one (`steamid - 76561197960265728`). With several
 * accounts on one machine the most recent `Timestamp` is the right one, which
 * is the same rule the client itself uses to preselect a login.
 */
async function findUserDataDir(root: string): Promise<string | null> {
  const userdata = join(root, 'userdata')

  let candidates: string[]
  try {
    candidates = (await readdir(userdata)).filter((entry) => /^\d+$/.test(entry) && entry !== '0')
  } catch {
    return null
  }
  if (candidates.length === 0) return null
  if (candidates.length === 1) return join(userdata, candidates[0]!)

  try {
    const text = await readFile(join(root, 'config', 'loginusers.vdf'), 'utf8')
    const users = dig(parseTextVdf(text), 'users')
    let best: { accountId: string; timestamp: number } | null = null
    for (const [steamId, entry] of Object.entries(users ?? {})) {
      if (typeof entry !== 'object') continue
      const accountId = String(BigInt(steamId) - 76561197960265728n)
      if (!candidates.includes(accountId)) continue
      const timestamp = leaf(entry, 'MostRecent') === '1' ? Number.MAX_SAFE_INTEGER : num(entry, 'Timestamp')
      if (best === null || timestamp > best.timestamp) best = { accountId, timestamp }
    }
    if (best !== null) return join(userdata, best.accountId)
  } catch {
    // Fall through to the newest directory.
  }

  // No usable login file: take whichever profile was written to last.
  const timestamps = await Promise.all(
    candidates.map(async (candidate) => {
      try {
        const info = await stat(join(userdata, candidate, 'config', 'localconfig.vdf'))
        return { candidate, mtime: info.mtimeMs }
      } catch {
        return { candidate, mtime: 0 }
      }
    })
  )
  timestamps.sort((a, b) => b.mtime - a.mtime)
  return join(userdata, timestamps[0]!.candidate)
}

async function readPlaytimes(root: string): Promise<Map<number, PlayRecord>> {
  const records = new Map<number, PlayRecord>()

  const userDir = await findUserDataDir(root)
  if (userDir === null) return records

  let apps: VdfNode | undefined
  try {
    const text = await readFile(join(userDir, 'config', 'localconfig.vdf'), 'utf8')
    apps = dig(parseTextVdf(text), 'UserLocalConfigStore', 'Software', 'Valve', 'Steam', 'apps')
  } catch {
    return records
  }

  for (const [key, entry] of Object.entries(apps ?? {})) {
    if (typeof entry !== 'object') continue
    const appid = Number.parseInt(key, 10)
    if (!Number.isFinite(appid)) continue
    records.set(appid, {
      lastPlayed: num(entry, 'LastPlayed'),
      playtimeMinutes: num(entry, 'Playtime'),
      playtime2WeeksMinutes: num(entry, 'Playtime2wks')
    })
  }

  return records
}

/** Read the lot. Everything the view needs, in one pass over four files. */
export async function loadLibrary(): Promise<SteamLibrary | null> {
  const root = await findRoot()
  if (root === null) return null

  const paths = await libraryPaths(root)
  const [manifestSets, types, playtimes] = await Promise.all([
    Promise.all(paths.map(readManifests)),
    readAppTypes(root),
    readPlaytimes(root)
  ])

  // Keyed by appid, not appended: moving a game between drives can leave a
  // stale manifest behind in the old library, and one game must be one row.
  const apps = new Map<number, SteamApp>()
  const installs = new Map<number, RawInstall>()
  for (const manifests of manifestSets) {
    for (const install of manifests.values()) {
      if (!installs.has(install.appid)) installs.set(install.appid, install)
    }
  }

  for (const install of installs.values()) {
    const info = types.get(install.appid)
    const play = playtimes.get(install.appid)
    apps.set(install.appid, {
      appid: install.appid,
      // `appinfo` carries the name Steam shows in the library, which is
      // occasionally newer than the one frozen into the manifest at install.
      name: info?.name ?? install.name,
      kind: kindOf(info, install.name, types.size > 0),
      installPath: install.installPath,
      sizeOnDisk: install.sizeOnDisk,
      lastPlayed: Math.max(install.lastPlayed, play?.lastPlayed ?? 0),
      playtimeMinutes: play?.playtimeMinutes ?? 0,
      playtime2WeeksMinutes: play?.playtime2WeeksMinutes ?? 0,
      updatePending: install.updatePending,
      libraryPath: install.libraryPath
    })
  }

  return { root, apps: [...apps.values()], typesUnavailable: types.size === 0 }
}

/** Icons read at once. Enough to keep the disk busy, few enough that a hundred rows is not a hundred open files. */
const ICON_CONCURRENCY = 8
/** A row's face, inlined into the render tree. Anything larger than this is library art misfiled as an icon. */
const MAX_ICON_BYTES = 8 * 1024

/**
 * The icons for a set of apps, a few at a time.
 *
 * Resolved apart from the library and after it, because these are the only
 * bytes in the payload that are measured in kilobytes per row: the list paints
 * from names and sizes, and the faces fill in behind it for the rows that are
 * actually on screen.
 */
export async function readAppIcons(
  root: string,
  appids: readonly number[]
): Promise<Record<number, string | null>> {
  const icons: Record<number, string | null> = {}
  let next = 0

  const worker = async (): Promise<void> => {
    for (let index = next++; index < appids.length; index = next++) {
      const appid = appids[index]!
      icons[appid] = await readAppIcon(root, appid)
    }
  }

  await Promise.all(Array.from({ length: Math.min(ICON_CONCURRENCY, appids.length) }, worker))
  return icons
}

/**
 * A game's own 32 px client icon, as a `data:` URI.
 *
 * Steam files it under `appcache/librarycache/<appid>/` named after its content
 * hash - a bare 40-character hex `.jpg` next to the big art, which is the one
 * image in that folder small enough to sit in a list row. Older clients wrote
 * `librarycache/<appid>_icon.jpg` instead, so both spellings are tried.
 */
async function readAppIcon(root: string, appid: number): Promise<string | null> {
  const cache = join(root, 'appcache', 'librarycache')
  const dir = join(cache, String(appid))

  const candidates: string[] = []
  try {
    for (const name of await readdir(dir)) {
      if (/^[0-9a-f]{40}\.jpg$/i.test(name)) candidates.push(join(dir, name))
    }
  } catch {
    // No per-app folder: an older cache layout, or art never fetched.
  }
  candidates.push(join(cache, `${appid}_icon.jpg`))

  for (const path of candidates) {
    try {
      const bytes = await readFile(path)
      if (bytes.length === 0 || bytes.length > MAX_ICON_BYTES) continue
      return `data:image/jpeg;base64,${bytes.toString('base64')}`
    } catch {
      // Try the next candidate.
    }
  }
  return null
}

/**
 * The artwork Steam already downloaded for an app, as a `data:` URI.
 *
 * It has to be inlined: the renderer is only handed URLs, never filesystem
 * paths, so a `/home/…/header.jpg` would be read as a path into the plugin's
 * own `assets/` and quietly fail. One image for the detail panel is cheap;
 * doing this per row would put a megabyte of base64 through every keystroke,
 * which is why list rows use glyphs.
 */
const coverCache = new Map<number, string | null>()

export async function coverImage(root: string, appid: number): Promise<string | null> {
  // Opening the same game's details twice should not re-read and re-encode a
  // ~90 KB JPEG. Keyed by appid and kept for the life of the command, which is
  // the life of one visit to the launcher.
  const cached = coverCache.get(appid)
  if (cached !== undefined) return cached

  const uri = await readCover(root, appid)
  coverCache.set(appid, uri)
  return uri
}

async function readCover(root: string, appid: number): Promise<string | null> {
  const dir = join(root, 'appcache', 'librarycache', String(appid))
  const candidates = [
    ['header.jpg', 'image/jpeg'],
    ['library_hero.jpg', 'image/jpeg'],
    ['library_600x900.jpg', 'image/jpeg'],
    ['logo.png', 'image/png']
  ] as const

  for (const [file, mime] of candidates) {
    try {
      const bytes = await readFile(join(dir, file))
      // Steam writes a placeholder for art it has not fetched; a few hundred
      // bytes is never a real header image.
      if (bytes.length < 1024) continue
      return `data:${mime};base64,${bytes.toString('base64')}`
    } catch {
      // Try the next size.
    }
  }
  return null
}

export function storeUrl(appid: number): string {
  return `https://store.steampowered.com/app/${appid}`
}

export function communityUrl(appid: number): string {
  return `https://steamcommunity.com/app/${appid}`
}

export function installDirName(app: SteamApp): string {
  return app.installPath === null ? '' : basename(app.installPath)
}

export function formatPlaytime(minutes: number): string {
  if (minutes <= 0) return 'never played'
  if (minutes < 60) return `${minutes} min`
  const hours = minutes / 60
  return `${hours < 10 ? hours.toFixed(1) : Math.round(hours)} h`
}

export function formatSize(bytes: number): string {
  if (bytes <= 0) return '-'
  const units = ['B', 'KB', 'MB', 'GB', 'TB']
  let value = bytes
  let unit = 0
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024
    unit += 1
  }
  return `${value < 10 && unit > 1 ? value.toFixed(1) : Math.round(value)} ${units[unit]}`
}

export function formatLastPlayed(seconds: number): string {
  if (seconds <= 0) return 'never'
  const days = Math.floor((Date.now() / 1000 - seconds) / 86400)
  if (days <= 0) return 'today'
  if (days === 1) return 'yesterday'
  if (days < 30) return `${days} days ago`
  if (days < 365) {
    const months = Math.max(1, Math.round(days / 30))
    return `${months === 1 ? 'a month' : `${months} months`} ago`
  }
  const years = Math.max(1, Math.round(days / 365))
  return `${years === 1 ? 'a year' : `${years} years`} ago`
}
