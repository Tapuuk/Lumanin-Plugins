/**
 * Search Firefox - your bookmarks, straight out of places.sqlite.
 *
 * Fully local and zero dependencies: the profile is found through
 * profiles.ini (new Firefox keeps it under $XDG_CONFIG_HOME/mozilla/firefox,
 * older installs under ~/.mozilla/firefox), and the database is read with
 * Node's builtin sqlite module - read-only on the live file when Firefox lets
 * us, and off a copy in the plugin's support directory when it does not.
 *
 * Each row wears the site's own favicon. Firefox already downloaded every one
 * of them into favicons.sqlite next to places.sqlite, so the faces come out of
 * the same profile as the bookmarks - no request to any site, and a bookmark
 * whose icon was never cached falls back to a globe rather than to a gap.
 */
import {
  Action,
  ActionPanel,
  Icon,
  List,
  Toast,
  closeMainWindow,
  environment,
  showToast,
  usePromise
} from 'lumanin'
import { useMemo, useRef, useState } from 'react'
import { DatabaseSync } from 'node:sqlite'
import { spawn } from 'node:child_process'
import { existsSync, readFileSync, unlinkSync } from 'node:fs'
import { chmod, copyFile, mkdir } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'

const CATEGORIES = [
  { id: 'bookmarks', title: 'Bookmarks' },
  { id: 'history', title: 'History' }
] as const

/** History rows worth listing - the launcher's search narrows from here. */
const MAX_HISTORY_ROWS = 1500

/** How big a cached icon may be before inlining it costs more than it is worth. */
const MAX_ICON_BYTES = 12 * 1024

/** SQLite takes 999 bound variables by default; one `IN (...)` stays well under it. */
const MAX_BOUND_IDS = 500

interface Bookmark {
  guid: string
  launch: Launch
  title: string
  url: string
  folder: string
  host: string
  /** The site's own favicon as a data URI, when Firefox has one cached. */
  icon?: string
}

type Launch = [program: string, ...args: string[]]

interface Profile {
  dir: string
  /** The argv prefix that opens a URL in this install's Firefox. */
  launch: Launch
}

/** The default profile, as the first profiles.ini with a readable one names it - or null. */
function findProfileDir(): Profile | null {
  const home = homedir()
  const config = process.env.XDG_CONFIG_HOME ?? join(home, '.config')
  const roots: Array<{ root: string; launch: Launch }> = [
    { root: join(config, 'mozilla', 'firefox'), launch: ['firefox'] },
    { root: join(home, '.config', 'mozilla', 'firefox'), launch: ['firefox'] },
    { root: join(home, '.mozilla', 'firefox'), launch: ['firefox'] },
    {
      root: join(home, '.var', 'app', 'org.mozilla.firefox', '.mozilla', 'firefox'),
      launch: ['flatpak', 'run', 'org.mozilla.firefox']
    },
    { root: join(home, 'snap', 'firefox', 'common', '.mozilla', 'firefox'), launch: ['/snap/bin/firefox'] }
  ]
  const seen = new Set<string>()
  for (const { root, launch } of roots) {
    if (seen.has(root)) continue
    seen.add(root)
    const ini = join(root, 'profiles.ini')
    if (!existsSync(ini)) continue
    const text = readFileSync(ini, 'utf8')
    // Prefer the [Install…] section's Default= (the profile Firefox actually
    // starts); fall back to the profile section flagged Default=1.
    let path: string | undefined
    let absolute = false
    const sections = text.split(/\n(?=\[)/)
    for (const section of sections) {
      if (/^\[Install/.test(section)) {
        path = section.match(/^Default=(.+)$/m)?.[1]?.trim()
        if (path) break
      }
    }
    if (!path) {
      for (const section of sections) {
        if (/^\[Profile/.test(section) && /^Default=1\r?$/m.test(section)) {
          path = section.match(/^Path=(.+)$/m)?.[1]?.trim()
          absolute = /^IsRelative=0\r?$/m.test(section)
          break
        }
      }
    }
    if (!path) continue
    // Firefox writes the profile path absolute when it lives outside this root.
    const dir = absolute || path.startsWith('/') ? path : join(root, path)
    if (existsSync(join(dir, 'places.sqlite'))) return { dir, launch }
  }
  return null
}

/** The lookup walks five directories and reads profiles.ini; once per worker is enough. */
let profileLookup: Promise<Profile | null> | null = null

const profileDir = async (): Promise<Profile | null> => (profileLookup ??= (async () => findProfileDir())())

/**
 * A profile database, copied aside and opened.
 *
 * Firefox holds these open in WAL mode, so copying the file and its journal
 * into our support directory and reading the copy is the safe way in - the
 * running browser never sees us touch its live file.
 */
let copySequence = 0

async function openProfileCopy(
  profile: string,
  file: string
): Promise<{ db: DatabaseSync; close(): void }> {
  await mkdir(environment.supportPath, { recursive: true })
  const copy = join(environment.supportPath, `${file}-${Date.now()}-${process.pid}-${++copySequence}`)
  // SQLite creates its own -shm next to the copy on open, so every sidecar
  // name is removed rather than only the ones we wrote.
  const remove = () => {
    for (const path of [copy, `${copy}-wal`, `${copy}-shm`]) {
      try {
        unlinkSync(path)
      } catch {
        // never written, or already gone
      }
    }
  }
  try {
    await copyFile(join(profile, file), copy)
    await chmod(copy, 0o600)
    // The journal and its shared-memory index are independent files; copying
    // them one after the other only adds latency.
    await Promise.all(
      ['-wal', '-shm']
        .filter((suffix) => existsSync(join(profile, `${file}${suffix}`)))
        .map(async (suffix) => {
          await copyFile(join(profile, `${file}${suffix}`), `${copy}${suffix}`)
          await chmod(`${copy}${suffix}`, 0o600)
        })
    )
    const db = new DatabaseSync(copy, { readOnly: true })
    return {
      db,
      close() {
        db.close()
        remove()
      }
    }
  } catch (error) {
    remove()
    throw error
  }
}

/**
 * Run a query against a profile database.
 *
 * The live file opens read-only most of the time, which is a whole megabyte of
 * copying saved; a browser mid-write locks it, and that is what the copy is
 * for. Both the open and the query can fail, so both are inside the try.
 */
async function queryProfile<T>(
  profile: string,
  file: string,
  query: (db: DatabaseSync) => T,
  signal?: AbortSignal
): Promise<T> {
  signal?.throwIfAborted()
  try {
    const live = new DatabaseSync(join(profile, file), { readOnly: true })
    try {
      return query(live)
    } finally {
      live.close()
    }
  } catch {
    // Locked, busy, or a journal we may not read: fall back to the copy.
  }
  signal?.throwIfAborted()
  const { db, close } = await openProfileCopy(profile, file)
  try {
    return query(db)
  } finally {
    close()
  }
}

/** The image type of a favicon blob, read from the bytes rather than guessed. */
function imageType(data: Uint8Array): string | null {
  if (data.length < 4) return null
  const [a, b, c, d] = data
  if (a === 0x89 && b === 0x50) return 'image/png'
  if (a === 0xff && b === 0xd8) return 'image/jpeg'
  if (a === 0x47 && b === 0x49) return 'image/gif'
  if (a === 0x00 && b === 0x00 && c === 0x01 && d === 0x00) return 'image/x-icon'
  if (a === 0x52 && b === 0x49 && c === 0x46 && d === 0x46) return 'image/webp'
  // An SVG favicon arrives as text, with or without an XML declaration.
  if (a === 0x3c) return 'image/svg+xml'
  return null
}

/**
 * The favicons of the hosts a list is about to show, out of favicons.sqlite.
 *
 * A host usually has several sizes cached; 32 px wins, then 16 px, then
 * whatever is nearest 32, because that is roughly what a list row draws and
 * scaling a 192 px PNG down costs bytes in every render patch. `width` is
 * 65535 for an SVG, which is a size the row is happy to have. Anything the
 * browser never cached simply has no entry.
 *
 * Only the wanted hosts are read, and the size bound is SQL's rather than
 * ours: the alternative materialises every blob in the profile to throw most
 * of them away. The result is kept per profile and category, so flipping the
 * dropdown back does not do the work twice.
 */
let faviconCache: { key: string; faces: Map<string, string> } | null = null

async function loadFavicons(
  profile: string,
  category: string,
  hosts: Set<string>,
  signal?: AbortSignal
): Promise<Map<string, string>> {
  if (hosts.size === 0 || !existsSync(join(profile, 'favicons.sqlite'))) return new Map()
  const key = `${profile}:${category}`
  if (faviconCache?.key === key) return faviconCache.faces

  const faces = new Map<string, { score: number; uri: string }>()
  await queryProfile(
    profile,
    'favicons.sqlite',
    (db) => {
      // Icons are filed by page URL, not by host, so the pages worth reading
      // are picked first and only their blobs are ever fetched.
      const pages = db
        .prepare('SELECT id AS id, page_url AS page FROM moz_pages_w_icons')
        .all() as Array<{ id: number; page: string }>
      const wanted = new Map<number, string>()
      for (const page of pages) {
        const host = siteOf(page.page)
        if (host === '' || !hosts.has(host)) continue
        wanted.set(page.id, host)
      }

      const ids = [...wanted.keys()]
      for (let start = 0; start < ids.length; start += MAX_BOUND_IDS) {
        const chunk = ids.slice(start, start + MAX_BOUND_IDS)
        const rows = db
          .prepare(
            `SELECT m.page_id AS page, i.width AS width, i.data AS data
               FROM moz_icons_to_pages m
               JOIN moz_icons i ON i.id = m.icon_id
              WHERE m.page_id IN (${chunk.map(() => '?').join(',')})
                AND length(i.data) BETWEEN 1 AND ${MAX_ICON_BYTES}`
          )
          .all(...chunk) as Array<{ page: number; width: number; data: Uint8Array }>

        for (const row of rows) {
          const host = wanted.get(row.page)
          if (host === undefined) continue
          // 65535 is Firefox's "no intrinsic size", which is what an SVG gets.
          const width = row.width === 65535 ? 32 : row.width
          const score = width === 32 ? 0 : width === 16 ? 1 : Math.abs(width - 32) + 2
          const held = faces.get(host)
          if (held !== undefined && held.score <= score) continue
          const type = imageType(row.data)
          if (type === null) continue
          faces.set(host, {
            score,
            uri: `data:${type};base64,${Buffer.from(row.data).toString('base64')}`
          })
        }
      }
    },
    signal
  )
  const built = new Map([...faces].map(([host, face]) => [host, face.uri]))
  faviconCache = { key, faces: built }
  return built
}

/** The hostname of a URL, or '' when it does not parse. */
function hostOf(url: string): string {
  try {
    return new URL(url).hostname
  } catch {
    return ''
  }
}

/** The hostname a row is filed under, which is how the favicon map is keyed. */
function siteOf(url: string): string {
  return hostOf(url).replace(/^www\./, '')
}

async function loadBookmarks(category: string, signal?: AbortSignal): Promise<Bookmark[]> {
  const profile = await profileDir()
  if (!profile) {
    throw new Error('No Firefox profile found - run Firefox once so it creates one.')
  }
  // A query is uninterruptible once SQLite has it, so an abandoned load stops
  // between stages rather than inside one.
  signal?.throwIfAborted()

  // History rows reuse the bookmark shape; `folder` carries the last visit
  // day, which the same accessory tag renders.
  const sql =
    category === 'history'
      ? `SELECT p.guid AS guid, p.title AS title, p.url AS url,
                date(p.last_visit_date / 1000000, 'unixepoch') AS folder
           FROM moz_places p
          WHERE p.hidden = 0 AND p.last_visit_date IS NOT NULL
            AND p.url NOT LIKE 'place:%'
          ORDER BY p.last_visit_date DESC
          LIMIT ${MAX_HISTORY_ROWS}`
      : `SELECT b.guid AS guid, b.title AS title, p.url AS url,
                COALESCE(f.title, '') AS folder
           FROM moz_bookmarks b
           JOIN moz_places p ON b.fk = p.id
           LEFT JOIN moz_bookmarks f ON b.parent = f.id
          WHERE b.type = 1 AND p.url NOT LIKE 'place:%'
            AND b.parent NOT IN (SELECT id FROM moz_bookmarks
                                  WHERE parent = (SELECT id FROM moz_bookmarks WHERE guid = 'tags________'))
          ORDER BY p.frecency DESC, b.dateAdded DESC`
  const queried = await queryProfile(
    profile.dir,
    'places.sqlite',
    (db) =>
      db.prepare(sql).all() as Array<{
        guid: string
        title: string | null
        url: string
        folder: string
      }>,
    signal
  )
  signal?.throwIfAborted()

  // Bookmarks only: Firefox re-seeds its locale-default folder on every
  // locale change, stacking the same handful of URLs under several guids.
  // Keep the first row per URL in the existing sort order (highest
  // frecency wins). History rows are visits, not bookmarks - never dedupe.
  const rows =
    category === 'history'
      ? queried
      : (() => {
          const seen = new Set<string>()
          const deduped: typeof queried = []
          for (const row of queried) {
            // Firefox's own seeded set (Get Help, Customize, About Us...)
            // lives in a "Mozilla Firefox" folder it re-creates on every
            // locale change, so deleting the rows never sticks. Hide the
            // vendor folder; a user folder of the same name survives
            // unless its rows also point at mozilla.org.
            if (row.folder === 'Mozilla Firefox' && /(^|\.)mozilla\.org/.test(hostOf(row.url)))
              continue
            if (seen.has(row.url)) continue
            seen.add(row.url)
            deduped.push(row)
          }
          return deduped
        })()

  const hosts = new Set(rows.map((row) => siteOf(row.url)).filter((host) => host !== ''))
  const favicons = await loadFavicons(profile.dir, category, hosts, signal)
  signal?.throwIfAborted()

  return rows.map((row) => {
    const host = siteOf(row.url)
    return {
      guid: row.guid,
      launch: profile.launch,
      title: row.title?.trim() || row.url,
      url: row.url,
      folder: row.folder,
      host,
      icon: favicons.get(host)
    }
  })
}

/** Spawn detached so a running Firefox outlives this worker, toast on failure. */
async function openInFirefox(url: string, launch: Launch): Promise<void> {
  const [program, ...args] = launch
  try {
    await new Promise<void>((resolve, reject) => {
      const child = spawn(program, [...args, url], { detached: true, stdio: 'ignore' })
      child.once('spawn', () => {
        child.unref()
        resolve()
      })
      child.once('error', reject)
    })
  } catch (error) {
    await showToast({
      style: Toast.Style.Failure,
      title: 'Could not open Firefox',
      message: error instanceof Error ? error.message : String(error)
    })
    return
  }
  await closeMainWindow()
}

export default function Command(props: { launchContext?: { category?: string } }) {
  const requested = props.launchContext?.category
  const [category, setCategory] = useState(
    typeof requested === 'string' && CATEGORIES.some((entry) => entry.id === requested)
      ? requested
      : 'bookmarks'
  )
  const abortable = useRef<AbortController | null>(null)
  const { data, error, isLoading } = usePromise(
    (which: string) => loadBookmarks(which, abortable.current?.signal),
    [category],
    { abortable }
  )

  const rows = useMemo(
    () =>
      (data ?? []).map((bookmark) => (
        <List.Item
          key={bookmark.guid}
          id={bookmark.guid}
          title={bookmark.title}
          subtitle={bookmark.url}
          keywords={bookmark.host ? [bookmark.host] : undefined}
          icon={bookmark.icon ?? Icon.Globe}
          accessories={bookmark.folder ? [{ tag: bookmark.folder }] : undefined}
          actions={
            <ActionPanel>
              <Action
                title="Open in Firefox"
                icon={Icon.Globe}
                onAction={() => openInFirefox(bookmark.url, bookmark.launch)}
              />
              <ActionPanel.Section>
                <Action.CopyToClipboard
                  title="Copy URL"
                  content={bookmark.url}
                  shortcut={{ modifiers: ['cmd'], key: 'c' }}
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
      searchBarPlaceholder="Search bookmarks and history"
      searchBarAccessory={
        <List.Dropdown tooltip="Category" value={category} onChange={setCategory}>
          {CATEGORIES.map((entry) => (
            <List.Dropdown.Item key={entry.id} title={entry.title} value={entry.id} />
          ))}
        </List.Dropdown>
      }
    >
      {rows}
      {rows.length === 0 && error !== undefined && (
        <List.EmptyView icon={Icon.Warning} title="Could not read the profile" description={error.message} />
      )}
    </List>
  )
}
