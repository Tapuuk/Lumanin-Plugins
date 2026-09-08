/**
 * Your GitHub, through the gh CLI you are already signed in to.
 *
 * All three categories are one gh invocation each; the network traffic is
 * gh's own, to github.com, using the login you gave it with gh auth login.
 * The plugin itself stores nothing and talks to nothing else.
 */
import {
  Action,
  ActionPanel,
  Color,
  Icon,
  List,
  getPreferenceValues,
  useExec
} from 'lumanin'
import { useMemo, useState, type ComponentProps } from 'react'

const CATEGORIES = [
  { id: 'prs', title: 'My Pull Requests' },
  { id: 'issues', title: 'Assigned Issues' },
  { id: 'repos', title: 'My Repositories' }
] as const

type Accessory = NonNullable<ComponentProps<typeof List.Item>['accessories']>[number]
type IconName = (typeof Icon)[keyof typeof Icon]

interface Row {
  /** The GitHub URL - the stable id of a row. */
  url: string
  title: string
  subtitle: string
  /** Never the subtitle, so the identity (owner, repo, number) goes here. */
  keywords: string[]
  icon: IconName
  /** As `gh --json` gave it: a string survives the JSON cache, a Date does not. */
  updatedAt: string | undefined
  tag: string | undefined
}

/** What one run decoded, tagged with the category it was asked for. */
interface Parsed {
  category: string
  rows: Row[]
}

const ghBinary = (): string => getPreferenceValues<{ ghBinary?: string }>().ghBinary?.trim() || 'gh'

const firstLine = (text: string): string => text.split('\n')[0]

/** A failed run is thrown, so the hook's `error` is set; `parseOutput` replaces the default that did that. */
function parseRun(
  category: string,
  outcome: { stdout: string; stderr: string; error?: Error; exitCode: number | null }
): Parsed {
  // Rethrown untouched: wrapping it would lose `code === 'ENOENT'`.
  if (outcome.error) throw outcome.error
  if (outcome.exitCode !== 0) {
    throw new Error(outcome.stderr.trim() || 'gh exited with code ' + String(outcome.exitCode))
  }
  return parseRows(category, outcome.stdout)
}

const ARGS: Record<string, string[]> = {
  prs: [
    'search', 'prs', '--author=@me', '--state=open', '--sort=updated',
    '--json', 'title,url,repository,number,updatedAt', '--limit', '50'
  ],
  issues: [
    'search', 'issues', '--assignee=@me', '--state=open', '--sort=updated',
    '--json', 'title,url,repository,number,updatedAt', '--limit', '50'
  ],
  repos: ['repo', 'list', '--json', 'name,owner,url,description,updatedAt,isPrivate', '--limit', '100']
}

const iconOf = (category: string): IconName =>
  category === 'prs' ? Icon.Shuffle : category === 'issues' ? Icon.Bug : Icon.Folder

// The Date is built here, at render time, because the cache is JSON: a Date
// stored in a row comes back from the cached paint as a string the renderer
// does not treat as a date, and the accessory silently goes missing.
const accessoriesOf = (updatedAt: string | undefined, tag: string | undefined): Accessory[] => {
  const date = updatedAt ? new Date(updatedAt) : null
  return [
    ...(tag === undefined ? [] : [{ tag: { value: tag, color: Color.Orange } }]),
    ...(date !== null && !Number.isNaN(date.getTime()) ? [{ date }] : [])
  ]
}

/**
 * Decode one run's stdout. This is `useExec`'s `parseOutput`, not a memo over
 * `data`: a hook keeps the previous answer while the next one loads, so a memo
 * would decode the old category's JSON through the new category's shape. The
 * returned category is what lets the view refuse to draw the previous
 * category's rows under the new label while the next run is in flight.
 */
function parseRows(category: string, stdout: string): Parsed {
  let parsed: unknown
  try {
    parsed = JSON.parse(stdout === '' ? '[]' : stdout)
  } catch {
    return { category, rows: [] }
  }
  if (!Array.isArray(parsed)) return { category, rows: [] }

  const icon = iconOf(category)

  if (category === 'repos') {
    const rows = (parsed as {
      name?: string
      owner?: { login?: string }
      url?: string
      description?: string
      updatedAt?: string
      isPrivate?: boolean
    }[])
      .filter((repo) => (repo.url ?? '') !== '')
      .map((repo) => ({
        url: repo.url ?? '',
        title: repo.name ?? '',
        subtitle: repo.description ?? '',
        keywords: [repo.owner?.login ?? '', repo.name ?? ''].filter((part) => part !== ''),
        icon,
        updatedAt: repo.updatedAt,
        tag: repo.isPrivate ? 'private' : undefined
      }))
    return { category, rows }
  }
  const rows = (parsed as {
    title?: string
    url?: string
    number?: number
    repository?: { nameWithOwner?: string }
    updatedAt?: string
  }[])
    .filter((item) => (item.url ?? '') !== '')
    .map((item) => ({
      url: item.url ?? '',
      title: item.title ?? '',
      subtitle: (item.repository?.nameWithOwner ?? '') + ' #' + String(item.number ?? ''),
      keywords: [item.repository?.nameWithOwner ?? '', String(item.number ?? '')].filter((part) => part !== ''),
      icon,
      updatedAt: item.updatedAt,
      tag: undefined
    }))
  return { category, rows }
}

export default function SearchGitHub(props: {
  launchContext?: { category?: unknown }
}): React.JSX.Element {
  const requested = props.launchContext?.category
  const [category, setCategory] = useState(
    typeof requested === 'string' && CATEGORIES.some((entry) => entry.id === requested)
      ? requested
      : 'prs'
  )
  const { isLoading, data, error } = useExec<Parsed>(ghBinary(), ARGS[category] ?? ARGS.prs, {
    timeout: 30000,
    parseOutput: (outcome: { stdout: string; stderr: string; error?: Error; exitCode: number | null }) =>
      parseRun(category, outcome)
  })
  const missing = (error as NodeJS.ErrnoException | undefined)?.code === 'ENOENT'
  const message = error ? String(error.message ?? error) : ''
  // gh's own wording for a missing login; anything unrecognised gets the generic shape.
  const needsAuth = !missing && /auth login|not logged in|authentication|HTTP 401/i.test(message)
  const errorTitle = missing
    ? ghBinary() + ' is not installed or not on PATH'
    : needsAuth
      ? 'gh is not signed in'
      : 'gh did not answer'
  const errorDescription = missing
    ? firstLine(message)
    : needsAuth
      ? 'Sign in once with gh auth login, then reopen this list.'
      : firstLine(message)
  // A cache written before this shape holds an array or a string, so the shape
  // is checked; and previous data is kept while the next category loads, so
  // only rows of the chosen category render, never under the wrong label.
  const parsed = data !== null && typeof data === 'object' && 'rows' in data ? data : undefined
  const rows = useMemo(
    () =>
      (parsed?.category === category ? parsed.rows : []).map((row) => (
        <List.Item
          key={row.url}
          id={row.url}
          title={row.title}
          subtitle={row.subtitle}
          keywords={row.keywords}
          icon={row.icon}
          accessories={accessoriesOf(row.updatedAt, row.tag)}
          actions={
            <ActionPanel>
              <ActionPanel.Section>
                <Action.OpenInBrowser title="Open on GitHub" url={row.url} />
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
      )),
    [parsed, category]
  )

  return (
    <List
      isLoading={isLoading}
      searchBarPlaceholder="Search pull requests, issues and repositories"
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
        icon={Icon.Globe}
        title={error ? errorTitle : 'Nothing here'}
        description={error ? errorDescription : 'This category is empty on your account right now.'}
      />
    </List>
  )
}
