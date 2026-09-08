/**
 * Running media players, over MPRIS.
 *
 * MPRIS is the D-Bus interface every Linux player speaks - Spotify, VLC, mpv,
 * Chromium, Firefox - so one list controls them all. All calls go through
 * systemd's busctl, which every systemd distribution ships. No network, no
 * dependencies.
 */
import {
  Action,
  ActionPanel,
  Color,
  Icon,
  List,
  Toast,
  showToast,
  usePromise
} from 'lumanin'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

const run = promisify(execFile)

const CATEGORIES = [{ id: 'players', title: 'Players' }] as const

const PREFIX = 'org.mpris.MediaPlayer2.'
/** The application part of a bus name: browsers and VLC append `.instance<pid>`, which changes on every restart. */
const stableId = (busName: string): string => busName.slice(PREFIX.length).split('.')[0]
const OBJECT = '/org/mpris/MediaPlayer2'
const PLAYER = 'org.mpris.MediaPlayer2.Player'

interface Player {
  /**
   * The application part of the bus name, e.g. `chromium`: stable across
   * restarts, which is what a pin stores; a second instance gets `-2`.
   */
  id: string
  /** The full name every `busctl` call takes. */
  busName: string
  identity: string
  status: string
  title: string
  artist: string
  /** The row's icon name, worked out once per load. */
  icon: string
  can: {
    control: boolean
    pause: boolean
    play: boolean
    next: boolean
    previous: boolean
    raise: boolean
  }
}

interface Variant {
  type: string
  data: unknown
}

const BUSCTL_TIMEOUT = ['--timeout=2']
const RUN_TIMEOUT = { timeout: 2000 }

/** How long a control keypress waits before the list is read back. */
const CONFIRM_DELAY = 300

async function getAll(busName: string, iface: string, signal?: AbortSignal): Promise<Record<string, Variant>> {
  const { stdout } = await run(
    'busctl',
    ['--user', ...BUSCTL_TIMEOUT, '--json=short', 'call', busName, OBJECT, 'org.freedesktop.DBus.Properties', 'GetAll', 's', iface],
    { ...RUN_TIMEOUT, ...(signal === undefined ? {} : { signal }) }
  )
  try {
    const reply = JSON.parse(stdout.trim()) as { data?: unknown[] }
    const map = reply.data?.[0]
    return map !== null && typeof map === 'object' ? (map as Record<string, Variant>) : {}
  } catch {
    return {}
  }
}

// A player that omits a Can* property keeps the action: an incomplete player loses nothing.
const flag = (props: Record<string, Variant>, name: string): boolean =>
  typeof props[name]?.data === 'boolean' ? (props[name].data as boolean) : true

async function getProperties(busName: string, signal?: AbortSignal): Promise<Player | null> {
  try {
    const [app, player] = await Promise.all([
      getAll(busName, 'org.mpris.MediaPlayer2', signal),
      getAll(busName, PLAYER, signal)
    ])
    const meta = (player.Metadata?.data ?? {}) as Record<string, Variant>
    const artists = meta['xesam:artist']?.data
    return {
      id: stableId(busName),
      busName,
      identity: String(app.Identity?.data ?? stableId(busName)),
      status: String(player.PlaybackStatus?.data ?? 'Stopped'),
      title: String(meta['xesam:title']?.data ?? ''),
      icon: 'system:' + stableId(busName).toLowerCase() + ',multimedia-player',
      artist: Array.isArray(artists) ? artists.map((a) => (a as Variant).data ?? a).join(', ') : '',
      can: {
        control: flag(player, 'CanControl'),
        pause: flag(player, 'CanPause'),
        play: flag(player, 'CanPlay'),
        next: flag(player, 'CanGoNext'),
        previous: flag(player, 'CanGoPrevious'),
        raise: flag(app, 'CanRaise')
      }
    }
  } catch {
    return null
  }
}

async function loadPlayers(signal?: AbortSignal): Promise<Player[]> {
  const { stdout } = await run(
    'busctl',
    ['--user', ...BUSCTL_TIMEOUT, '--json=short', 'list'],
    { ...RUN_TIMEOUT, ...(signal === undefined ? {} : { signal }) }
  )
  const rows = JSON.parse(stdout) as { name?: string; pid?: number | null; connection?: string }[]
  // Activatable names belong to players that are not running; reading a property would start them.
  const names = rows
    .filter((row) => (row.name ?? '').startsWith(PREFIX) && typeof row.pid === 'number')
    .map((row) => row.name as string)
  const players = await Promise.all(names.map((name) => getProperties(name, signal)))
  const list = players
    .filter((player): player is Player => player !== null)
    .sort((a, b) => a.identity.localeCompare(b.identity))
  // Two instances of one player share a base id. The first keeps the plain id
  // on purpose, because that is what a pin stored; the rest are numbered.
  const seen = new Map<string, number>()
  for (const player of list) {
    const base = player.id
    const count = seen.get(base) ?? 0
    seen.set(base, count + 1)
    player.id = count === 0 ? base : base + '-' + String(count + 1)
  }
  return list
}

async function call(busName: string, method: string, revalidate: () => void): Promise<void> {
  try {
    await run('busctl', ['--user', ...BUSCTL_TIMEOUT, 'call', busName, OBJECT, PLAYER, method], RUN_TIMEOUT)
  } catch {
    await showToast({ style: Toast.Style.Failure, title: 'Player refused ' + method })
  }
  revalidate()
}

async function raise(busName: string): Promise<void> {
  try {
    await run(
      'busctl',
      ['--user', ...BUSCTL_TIMEOUT, 'call', busName, OBJECT, 'org.mpris.MediaPlayer2', 'Raise'],
      RUN_TIMEOUT
    )
  } catch {
    await showToast({ style: Toast.Style.Failure, title: 'Player cannot raise its window' })
  }
}

const nowPlaying = (player: Player): string =>
  player.title === '' ? '' : player.artist === '' ? player.title : player.artist + ' - ' + player.title

function actionsFor(player: Player, revalidate: () => void): React.JSX.Element | undefined {
  const { can } = player
  const playPause = can.control && (can.pause || can.play)
  const next = can.control && can.next
  const previous = can.control && can.previous
  if (!playPause && !next && !previous && !can.raise) return undefined
  return (
    <ActionPanel>
      {playPause && (
        <ActionPanel.Section>
          <Action
            title="Toggle Play and Pause"
            icon={player.status === 'Playing' ? Icon.Pause : Icon.Play}
            onAction={() => void call(player.busName, 'PlayPause', revalidate)}
          />
        </ActionPanel.Section>
      )}
      <ActionPanel.Section>
        {next && (
          <Action
            title="Next Track"
            icon={Icon.Forward}
            shortcut={{ modifiers: ['cmd'], key: 'n' }}
            onAction={() => void call(player.busName, 'Next', revalidate)}
          />
        )}
        {previous && (
          <Action
            title="Previous Track"
            icon={Icon.Rewind}
            shortcut={{ modifiers: ['cmd'], key: 'p' }}
            onAction={() => void call(player.busName, 'Previous', revalidate)}
          />
        )}
        {can.raise && (
          <Action
            title="Raise Player Window"
            icon={Icon.Window}
            shortcut={{ modifiers: ['cmd'], key: 'r' }}
            onAction={() => void raise(player.busName)}
          />
        )}
      </ActionPanel.Section>
    </ActionPanel>
  )
}

export default function SearchMediaPlayers(props: {
  launchContext?: { category?: unknown }
}): React.JSX.Element {
  const requested = props.launchContext?.category
  const [category, setCategory] = useState(
    typeof requested === 'string' && CATEGORIES.some((entry) => entry.id === requested)
      ? requested
      : 'players'
  )
  const abortable = useRef<AbortController | null>(null)
  const { isLoading, data, error, revalidate } = usePromise(
    () => loadPlayers(abortable.current?.signal),
    [],
    { abortable }
  )
  void category

  // A control key confirms itself by reading the players back, and a held key
  // would otherwise start one sweep of the bus per repeat.
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const confirm = useCallback(() => {
    if (timer.current !== null) clearTimeout(timer.current)
    timer.current = setTimeout(() => {
      timer.current = null
      void revalidate().catch(() => undefined)
    }, CONFIRM_DELAY)
  }, [revalidate])
  useEffect(() => () => {
    if (timer.current !== null) clearTimeout(timer.current)
  }, [])

  const rows = useMemo(
    () =>
      (data ?? []).map((player) => (
        <List.Item
          key={player.id}
          id={player.id}
          title={player.identity}
          subtitle={nowPlaying(player)}
          icon={player.icon}
          accessories={[
            player.status === 'Playing'
              ? { tag: { value: 'Playing', color: Color.Green } }
              : { tag: { value: player.status } }
          ]}
          actions={actionsFor(player, confirm)}
        />
      )),
    [data, confirm]
  )
  const failed = error !== undefined && (data ?? []).length === 0

  return (
    <List
      isLoading={isLoading}
      searchBarPlaceholder="Search running media players"
      searchBarAccessory={
        <List.Dropdown tooltip="Category" value={category} onChange={setCategory}>
          {CATEGORIES.map((cat) => (
            <List.Dropdown.Item key={cat.id} value={cat.id} title={cat.title} />
          ))}
        </List.Dropdown>
      }
    >
      {rows}
      {rows.length === 0 && (
        <List.EmptyView
          icon={Icon.Music}
          title={failed ? 'Could not list players' : 'Nothing is playing'}
          description={
            failed && error !== undefined
              ? error.message + '\n' + 'This plugin needs busctl (part of systemd) to talk to players over D-Bus.'
              : 'Start any media player - Spotify, VLC, mpv, a browser tab - and it will show up here.'
          }
        />
      )}
    </List>
  )
}
