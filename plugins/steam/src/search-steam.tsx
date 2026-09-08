/**
 * Search Steam - the installed half of your library, as a launcher list.
 *
 * Zero dependencies and no network: everything on screen was read out of
 * Steam's own files by `lib/steam.ts`. The two things that leave this machine
 * do so only because you pressed the key for them - the store and community
 * actions hand a URL to your browser.
 *
 * Sorting is an action rather than a category, because "Hades" is the same row
 * however the list is ordered; the choice is remembered between launches.
 */
import {
  Action,
  ActionPanel,
  Color,
  Detail,
  Icon,
  List,
  Toast,
  open,
  showHUD,
  showToast,
  useCachedPromise,
  useCachedState,
  useNavigation,
  usePromise
} from 'lumanin'
import { useEffect, useMemo, useRef, useState, type ComponentProps } from 'react'
import {
  communityUrl,
  coverImage,
  formatLastPlayed,
  formatPlaytime,
  formatSize,
  installDirName,
  loadLibrary,
  readAppIcons,
  storeUrl,
  type SteamApp
} from './lib/steam'

const CATEGORIES = [
  { id: 'games', title: 'Games' },
  { id: 'tools', title: 'Tools & Runtimes' }
] as const

const SORTS = [
  { id: 'recent', title: 'Recently Played', icon: Icon.Clock },
  { id: 'played', title: 'Most Played', icon: Icon.Star },
  { id: 'name', title: 'Name', icon: Icon.Text }
] as const

type SortId = (typeof SORTS)[number]['id']

type Accessory = NonNullable<ComponentProps<typeof List.Item>['accessories']>[number]

function sortApps(apps: readonly SteamApp[], sort: SortId): SteamApp[] {
  const byName = (a: SteamApp, b: SteamApp): number => a.name.localeCompare(b.name)
  const ordered = [...apps]
  if (sort === 'name') return ordered.sort(byName)
  if (sort === 'played') {
    // Name breaks the tie so the runtimes, which all have zero playtime, stay
    // in a stable readable order instead of whatever order the disk gave them.
    return ordered.sort((a, b) => b.playtimeMinutes - a.playtimeMinutes || byName(a, b))
  }
  return ordered.sort((a, b) => b.lastPlayed - a.lastPlayed || byName(a, b))
}

/**
 * Hand the app to Steam and get out of the way.
 *
 * `steam://rungameid/` is the URL the desktop entries use, so `open` routes
 * it through xdg-open to whichever Steam owns the scheme, native or
 * Flatpak - one path for both installs, instead of spawning a `steam`
 * binary that a Flatpak-only machine does not have on PATH.
 */
async function launch(app: SteamApp): Promise<void> {
  try {
    await open(`steam://rungameid/${app.appid}`)
    await showHUD(`Launching ${app.name}`)
  } catch (error) {
    await showToast({
      style: Toast.Style.Failure,
      title: `Could not start ${app.name}`,
      message: error instanceof Error ? error.message : String(error)
    })
  }
}

async function openInstallFolder(app: SteamApp): Promise<void> {
  if (app.installPath === null) {
    await showToast({ style: Toast.Style.Failure, title: 'No install folder recorded for this app' })
    return
  }
  try {
    await open(app.installPath)
  } catch (error) {
    await showToast({
      style: Toast.Style.Failure,
      title: 'Could not open the install folder',
      message: error instanceof Error ? error.message : String(error)
    })
  }
}

/** The sort switcher, shared by the list rows and the detail view. */
function SortSubmenu({ sort, onChange }: { sort: SortId; onChange: (sort: SortId) => void }) {
  return (
    <ActionPanel.Submenu title="Sort By" icon={Icon.Filter} shortcut={{ modifiers: ['cmd'], key: 's' }}>
      {SORTS.map((option) => (
        <Action
          key={option.id}
          title={option.title}
          icon={option.id === sort ? Icon.Check : option.icon}
          onAction={() => onChange(option.id)}
        />
      ))}
    </ActionPanel.Submenu>
  )
}

function LinkActions({ app }: { app: SteamApp }) {
  return (
    <ActionPanel.Section>
      <Action.OpenInBrowser
        title="Open Store Page"
        icon={Icon.Globe}
        url={storeUrl(app.appid)}
        shortcut={{ modifiers: ['cmd'], key: 'o' }}
      />
      <Action.OpenInBrowser
        title="Open Community Hub"
        icon={Icon.Bubble}
        url={communityUrl(app.appid)}
        shortcut={{ modifiers: ['cmd'], key: 'h' }}
      />
    </ActionPanel.Section>
  )
}

function FileActions({ app }: { app: SteamApp }) {
  return (
    <ActionPanel.Section>
      <Action
        title="Open Install Folder"
        icon={Icon.Folder}
        shortcut={{ modifiers: ['cmd'], key: 'f' }}
        onAction={() => openInstallFolder(app)}
      />
      <Action.CopyToClipboard
        title="Copy App ID"
        content={String(app.appid)}
        shortcut={{ modifiers: ['cmd'], key: 'i' }}
      />
      {app.installPath !== null && (
        <Action.CopyToClipboard
          title="Copy Install Path"
          content={app.installPath}
          shortcut={{ modifiers: ['cmd'], key: 'p' }}
        />
      )}
    </ActionPanel.Section>
  )
}

/** The pushed panel: cover art Steam already has, and the numbers behind the row. */
function GameDetail({ app, root }: { app: SteamApp; root: string }) {
  const abortable = useRef<AbortController | null>(null)
  const { data: cover, isLoading } = usePromise(coverImage, [root, app.appid], { abortable })

  const markdown =
    cover === null || cover === undefined
      ? `# ${app.name}`
      : `![${app.name}](${cover})`

  return (
    <Detail
      isLoading={isLoading}
      navigationTitle={app.name}
      markdown={markdown}
      metadata={
        <Detail.Metadata>
          <Detail.Metadata.Label title="Playtime" text={formatPlaytime(app.playtimeMinutes)} />
          {app.playtime2WeeksMinutes > 0 && (
            <Detail.Metadata.Label
              title="Past Two Weeks"
              text={formatPlaytime(app.playtime2WeeksMinutes)}
            />
          )}
          <Detail.Metadata.Label title="Last Played" text={formatLastPlayed(app.lastPlayed)} />
          <Detail.Metadata.Separator />
          <Detail.Metadata.Label title="Size on Disk" text={formatSize(app.sizeOnDisk)} />
          <Detail.Metadata.Label title="Install Path" text={app.installPath ?? 'unknown'} />
          <Detail.Metadata.Label title="Library" text={app.libraryPath} />
          <Detail.Metadata.Separator />
          <Detail.Metadata.Label title="App ID" text={String(app.appid)} />
          <Detail.Metadata.TagList title="State">
            <Detail.Metadata.TagList.Item
              text={app.updatePending ? 'update pending' : 'installed'}
              color={app.updatePending ? Color.Orange : Color.Green}
            />
          </Detail.Metadata.TagList>
          <Detail.Metadata.Link title="Store" target={storeUrl(app.appid)} text="store.steampowered.com" />
        </Detail.Metadata>
      }
      actions={
        <ActionPanel>
          <Action title={`Launch ${app.name}`} icon={Icon.Play} onAction={() => launch(app)} />
          <LinkActions app={app} />
          <FileActions app={app} />
        </ActionPanel>
      }
    />
  )
}

/** The right-hand accessories: what you sorted by, plus anything that needs attention. */
function accessoriesFor(app: SteamApp, sort: SortId): Accessory[] {
  const accessories: Accessory[] = []

  if (app.updatePending) {
    accessories.push({ tag: { value: 'update', color: Color.Orange } })
  }

  // A runtime has no playtime worth showing, and its size is already the
  // subtitle - repeating it put "646 MB | 646 MB" on every row.
  if (app.kind === 'tools') return accessories

  if (sort === 'played') {
    accessories.push({
      tag: {
        value: formatPlaytime(app.playtimeMinutes),
        color: app.playtimeMinutes > 0 ? Color.Green : Color.SecondaryText
      }
    })
    return accessories
  }

  accessories.push({ text: formatPlaytime(app.playtimeMinutes) })
  if (app.lastPlayed > 0) accessories.push({ date: new Date(app.lastPlayed * 1000) })
  return accessories
}

export default function Command(props: { launchContext?: { category?: string } }) {
  // A pinned category or a hotkey says which half to open in; the dropdown owns
  // it afterwards.
  const requested = props.launchContext?.category
  const [category, setCategory] = useState<string>(
    typeof requested === 'string' && CATEGORIES.some((entry) => entry.id === requested)
      ? requested
      : 'games'
  )
  // Read synchronously on the first render, so the first paint is already in
  // the order the last visit chose instead of sorting itself a frame later.
  const [sort, setSort] = useCachedState<SortId>('sort', 'recent')
  const { data, error, isLoading, revalidate } = useCachedPromise(loadLibrary, [])
  const [icons, setIcons] = useState<Record<number, string | null>>({})
  const { push } = useNavigation()

  const root = data?.root ?? null
  const shown = useMemo(
    () => sortApps((data?.apps ?? []).filter((app) => app.kind === category), sort),
    [data, category, sort]
  )
  const sortTitle = SORTS.find((option) => option.id === sort)?.title ?? 'Recently Played'

  // Faces for the rows on screen, and only those: switching category fills in
  // the rest. The library itself is remembered between launches, the icons are
  // not - they are kilobytes each and the cache is for the cheap half.
  useEffect(() => {
    if (root === null) return
    const missing = shown.filter((app) => !(app.appid in icons)).map((app) => app.appid)
    if (missing.length === 0) return
    let live = true
    void readAppIcons(root, missing).then((found) => {
      if (live) setIcons((previous) => ({ ...previous, ...found }))
    })
    return () => {
      live = false
    }
  }, [root, shown, icons])

  // Every string a row renders, worked out once per library-and-order rather
  // than on every keystroke the launcher filters with.
  const rows = useMemo(
    () =>
      root === null
        ? []
        : shown.map((app) => (
            <List.Item
              key={app.appid}
              id={String(app.appid)}
              title={app.name}
              subtitle={formatSize(app.sizeOnDisk)}
              // Never the subtitle, so the searchable extras go here: the appid,
              // and the folder name, which is what a lot of games are known by
              // on disk ("Hades" lives in "Hades", but "CS2D" does not).
              keywords={[String(app.appid), installDirName(app)]}
              icon={icons[app.appid] ?? (app.kind === 'games' ? Icon.Play : Icon.Gear)}
              accessories={accessoriesFor(app, sort)}
              actions={
                <ActionPanel>
                  {app.kind === 'games' ? (
                    <>
                      <Action title="Launch" icon={Icon.Play} onAction={() => launch(app)} />
                      <Action
                        title="Show Details"
                        icon={Icon.Info}
                        shortcut={{ modifiers: ['cmd'], key: 'd' }}
                        onAction={() => push(<GameDetail app={app} root={root} />)}
                      />
                    </>
                  ) : (
                    <>
                      <Action
                        title="Show Details"
                        icon={Icon.Info}
                        onAction={() => push(<GameDetail app={app} root={root} />)}
                      />
                      <Action title="Launch" icon={Icon.Play} onAction={() => launch(app)} />
                    </>
                  )}
                  <ActionPanel.Section>
                    <SortSubmenu sort={sort} onChange={setSort} />
                    <Action
                      title="Refresh"
                      icon={Icon.ArrowClockwise}
                      shortcut={{ modifiers: ['cmd'], key: 'r' }}
                      onAction={() => revalidate()}
                    />
                  </ActionPanel.Section>
                  <LinkActions app={app} />
                  <FileActions app={app} />
                </ActionPanel>
              }
            />
          )),
    [root, shown, sort, icons, push, setSort, revalidate]
  )

  return (
    <List
      isLoading={isLoading}
      searchBarPlaceholder={`Search installed Steam apps - by ${sortTitle.toLowerCase()}`}
      searchBarAccessory={
        <List.Dropdown tooltip="Category" value={category} onChange={setCategory}>
          {CATEGORIES.map((entry) => (
            <List.Dropdown.Item key={entry.id} title={entry.title} value={entry.id} />
          ))}
        </List.Dropdown>
      }
    >
      {error !== undefined && (
        <List.EmptyView icon={Icon.Warning} title="Could not read Steam's files" description={error.message} />
      )}
      {error === undefined && data === null && (
        <List.EmptyView
          icon={Icon.Warning}
          title="No Steam installation found"
          description="Looked in ~/.steam, ~/.local/share/Steam and the Flatpak data directory."
        />
      )}
      {error === undefined && data !== null && data !== undefined && shown.length === 0 && !isLoading && (
        <List.EmptyView
          icon={Icon.Download}
          title={category === 'games' ? 'No games installed' : 'No tools installed'}
          description={
            data.typesUnavailable
              ? "Steam's app cache could not be read, so games and runtimes cannot be told apart."
              : 'Install something in Steam and it will show up here.'
          }
        />
      )}
      {rows}
    </List>
  )
}
