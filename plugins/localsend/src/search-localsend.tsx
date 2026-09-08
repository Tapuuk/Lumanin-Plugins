/**
 * LocalSend, from the launcher. Devices come from the protocol's own
 * discovery on the LAN (src/protocol.ts), received files from the history
 * the LocalSend app keeps under ~/.local/share. No dependencies, and no
 * network beyond the RFC1918 LAN interfaces the scan is restricted to (never
 * a tunnel or a VPN; the Scan Interfaces preference pins it further).
 */
import {
  Action,
  ActionPanel,
  Clipboard,
  Color,
  Form,
  Icon,
  List,
  Toast,
  clearSearchBar,
  environment,
  getPreferenceValues,
  showToast,
  useNavigation,
  usePromise
} from 'lumanin'
import { memo, useEffect, useMemo, useRef, useState } from 'react'
import { promises as fs } from 'node:fs'
import { dirname, join } from 'node:path'
import os from 'node:os'
import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { discover, loadIdentity, outgoingFile, outgoingText, type Device, type Identity, type Outgoing } from './protocol.ts'
import type { Event, Job } from './send.ts'

const CATEGORIES = [
  { id: 'devices', title: 'Devices' },
  { id: 'received', title: 'Received' }
] as const

interface Preferences {
  alias?: string
  scanInterfaces?: string
}

/** The interface names the scan is pinned to; empty means the automatic LAN choice. */
const scanInterfaces = (): string[] =>
  (getPreferenceValues<Preferences>().scanInterfaces ?? '')
    .split(',')
    .map((name) => name.trim())
    .filter((name) => name !== '')

/** The first discovery pass, short enough to paint; then the real one. */
const FIRST_WINDOW_MS = 600
const WIDE_WINDOW_MS = 2500

/** Both passes' devices, newest answer per fingerprint winning. */
function mergeDevices(previous: Device[], found: Device[]): Device[] {
  const byFingerprint = new Map(previous.map((device) => [device.fingerprint, device]))
  for (const device of found) byFingerprint.set(device.fingerprint, device)
  return [...byFingerprint.values()].sort((a, b) => a.alias.localeCompare(b.alias))
}

interface Received {
  id: string
  fileName: string
  fileType: string
  /** Empty for a message: LocalSend keeps the text itself in fileName and saves nothing. */
  path: string
  fileSize: number
  senderAlias: string
  timestamp: string
  isMessage: boolean
  exists: boolean
  /** The row's own strings, settled on load rather than on every keystroke. */
  when: string
  sizeText: string
}

const APP_DATA = join(process.env.XDG_DATA_HOME ?? join(os.homedir(), '.local', 'share'), 'org.localsend.localsend_app')

async function appPreferences(): Promise<Record<string, unknown>> {
  try {
    return JSON.parse(await fs.readFile(join(APP_DATA, 'shared_preferences.json'), 'utf8')) as Record<string, unknown>
  } catch {
    return {}
  }
}

async function appAlias(): Promise<string | undefined> {
  const alias = (await appPreferences())['flutter.ls_alias']
  return typeof alias === 'string' && alias !== '' ? alias : undefined
}

async function listReceived(): Promise<Received[]> {
  const raw = (await appPreferences())['flutter.ls_receive_history']
  if (!Array.isArray(raw)) return []
  const entries: Received[] = []
  for (const line of raw) {
    if (typeof line !== 'string') continue
    try {
      const entry = JSON.parse(line) as Partial<Received> & { path?: string | null }
      if (typeof entry.id !== 'string') continue
      const isMessage = entry.isMessage === true || typeof entry.path !== 'string'
      const path = typeof entry.path === 'string' ? entry.path : ''
      const fileSize = entry.fileSize ?? 0
      const timestamp = entry.timestamp ?? ''
      entries.push({
        id: entry.id,
        fileName: entry.fileName ?? path.split('/').pop() ?? path,
        fileType: entry.fileType ?? 'other',
        path,
        fileSize,
        senderAlias: entry.senderAlias ?? 'unknown',
        timestamp,
        isMessage,
        // Settled below: one `access` per entry, all of them at once.
        exists: isMessage,
        when: when(timestamp),
        sizeText: size(fileSize)
      })
    } catch {
      /* one bad line does not lose the list */
    }
  }

  await Promise.all(
    entries.map(async (entry) => {
      if (entry.isMessage) return
      entry.exists = await fs.access(entry.path).then(
        () => true,
        () => false
      )
    })
  )

  return entries.sort((a, b) => b.timestamp.localeCompare(a.timestamp))
}

const identityOf = async (): Promise<Identity> =>
  loadIdentity(environment.supportPath, getPreferenceValues<Preferences>().alias ?? '', await appAlias())

function deviceIcon(device: Device): string {
  switch (device.deviceType) {
    case 'mobile':
      return 'system:phone,smartphone,computer'
    case 'web':
      return 'system:web-browser,computer'
    case 'headless':
    case 'server':
      return 'system:network-server,computer'
    default:
      return 'system:computer'
  }
}

const FILE_ICONS: Record<string, string> = {
  image: 'system:image-x-generic',
  video: 'system:video-x-generic',
  pdf: 'system:application-pdf,x-office-document',
  text: 'system:text-x-generic',
  apk: 'system:android-package-archive,package-x-generic'
}

const fileIcon = (entry: Received): string => FILE_ICONS[entry.fileType] ?? 'system:text-x-generic'

function size(bytes: number): string {
  if (bytes < 1024) return `${String(bytes)} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`
  return `${(bytes / 1024 / 1024 / 1024).toFixed(2)} GB`
}

const RECEIVED_FORMAT = new Intl.DateTimeFormat(undefined, {
  year: 'numeric',
  month: 'numeric',
  day: 'numeric',
  hour: 'numeric',
  minute: 'numeric',
  second: 'numeric'
})

function when(timestamp: string): string {
  const date = new Date(timestamp)
  return Number.isNaN(date.getTime()) ? '' : RECEIVED_FORMAT.format(date)
}

/**
 * Hand the transfer to src/send.ts in a process of its own, so hiding the
 * panel (which ends this worker) does not end the transfer, and mirror its
 * progress into a toast for as long as this worker lives.
 *
 * Resolves once the transfer has *started* (the child spawned, or failed to),
 * so the caller can leave its view with the toast already raised into the one
 * the user is looking at. The outcome arrives on that toast; once the panel is
 * gone, as a desktop notification from the child itself.
 */
async function deliver(device: Device, files: Outgoing[]): Promise<void> {
  const text = files.every((file) => file.text !== undefined)
  const toast = await showToast({ style: Toast.Style.Animated, title: `Waiting for ${device.alias} to accept` })
  try {
    const identity = await identityOf()
    const job: Job = { device, alias: identity.alias, certificate: identity.certificate, privateKey: identity.privateKey, files }
    const jobFile = join(environment.supportPath, `job-${randomUUID()}.json`)
    await fs.writeFile(jobFile, JSON.stringify(job), { mode: 0o600 })
    const script = join(environment.assetsPath, '..', 'src', 'send.ts')
    const child = spawn(process.execPath, [script, jobFile], {
      detached: true,
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }
    })
    child.unref()
    const started = new Promise<void>((resolve) => {
      child.once('spawn', () => resolve())
      child.once('error', () => resolve())
    })
    child.on('error', (error) => {
      toast.style = Toast.Style.Failure
      toast.title = `Could not send to ${device.alias}`
      toast.message = error.message
    })
    // A bounded tail of stderr, kept only to name a crash: a child that dies
    // after spawning with no `done` or `failed` line used to leave the toast
    // animated for ever.
    let errorTail = ''
    child.stderr.setEncoding('utf8')
    child.stderr.on('data', (chunk: string) => {
      errorTail = (errorTail + chunk).slice(-4096)
    })
    let settled = false
    child.on('close', (code) => {
      if (settled || code === 0) return
      toast.style = Toast.Style.Failure
      toast.title = `Could not send to ${device.alias}`
      const firstLine = errorTail.split('\n').find((line) => line.trim() !== '') ?? ''
      toast.message = firstLine !== '' ? firstLine : `the sender exited with code ${String(code)}`
    })
    let buffered = ''
    child.stdout.setEncoding('utf8')
    child.stdout.on('data', (chunk: string) => {
      buffered += chunk
      const lines = buffered.split('\n')
      buffered = lines.pop() ?? ''
      for (const line of lines) {
        if (line === '') continue
        let event: Event
        try {
          event = JSON.parse(line) as Event
        } catch {
          continue
        }
        switch (event.type) {
          case 'waiting':
            toast.title = `Waiting for ${device.alias} to accept`
            break
          case 'progress':
            toast.title = `Sending to ${device.alias}`
            toast.message = `${String(event.done + 1)} of ${String(event.total)}: ${event.fileName}`
            break
          case 'done':
            settled = true
            toast.style = Toast.Style.Success
            toast.message = undefined
            toast.title =
              event.sent === 0
                ? `${device.alias} accepted nothing`
                : text
                  ? `Sent text to ${device.alias}`
                  : `Sent ${String(event.sent)} ${event.sent === 1 ? 'file' : 'files'} to ${device.alias}`
            break
          case 'failed':
            settled = true
            toast.style = Toast.Style.Failure
            toast.title = `Could not send to ${device.alias}`
            toast.message = event.message
            break
        }
      }
    })
    await started
  } catch (error) {
    toast.style = Toast.Style.Failure
    toast.title = `Could not send to ${device.alias}`
    toast.message = error instanceof Error ? error.message : String(error)
  }
}

function SendFiles({ device }: { device: Device }) {
  const { pop } = useNavigation()
  const [error, setError] = useState<string | undefined>()

  const submit = async (values: { files?: string[] }): Promise<void> => {
    const paths = values.files ?? []
    if (paths.length === 0) {
      setError('Choose at least one file')
      return
    }
    let files: Outgoing[]
    try {
      files = await Promise.all(paths.map(outgoingFile))
    } catch (problem) {
      setError(problem instanceof Error ? problem.message : String(problem))
      return
    }
    // The toast is raised into this view, then the form is left: the other
    // order put the outcome on a view the user had already popped.
    await deliver(device, files)
    pop()
  }

  return (
    <Form
      navigationTitle={`Send to ${device.alias}`}
      actions={
        <ActionPanel>
          <Action.SubmitForm title="Send" icon={Icon.Upload} onSubmit={submit} />
        </ActionPanel>
      }
    >
      <Form.Description title="To" text={`${device.alias} (${device.ip})`} />
      <Form.FilePicker
        id="files"
        title="Files"
        autoFocus
        allowMultipleSelection
        canChooseDirectories={false}
        error={error}
        onChange={() => setError(undefined)}
      />
    </Form>
  )
}

async function sendClipboard(device: Device): Promise<void> {
  const text = (await Clipboard.readText())?.trim() ?? ''
  if (text === '') {
    await showToast({ style: Toast.Style.Failure, title: 'Clipboard holds no text' })
    return
  }
  await deliver(device, [outgoingText(text)])
}

const DeviceRow = memo(function DeviceRow({ device, revalidate }: { device: Device; revalidate: () => void }) {
  const { push } = useNavigation()
  return (
    <List.Item
      key={device.fingerprint}
      id={device.fingerprint}
      title={device.alias}
      subtitle={device.deviceModel}
      icon={deviceIcon(device)}
      accessories={[
        { text: device.ip },
        ...(device.protocol === 'http' ? [{ tag: { value: 'unencrypted', color: Color.Orange } }] : []),
        // Marked, not dropped: the announced fingerprint disagrees with (or
        // was never checked against) the certificate on the wire.
        ...(device.protocol === 'https' && !device.verified ? [{ tag: { value: 'unverified', color: Color.Red } }] : [])
      ]}
      actions={
        <ActionPanel>
          <ActionPanel.Section>
            <Action
              title="Send Files"
              icon={Icon.Upload}
              onAction={() => {
                push(<SendFiles device={device} />)
                clearSearchBar()
              }}
            />
          </ActionPanel.Section>
          <ActionPanel.Section>
            <Action title="Send Clipboard Text" icon={Icon.Clipboard} shortcut={{ modifiers: ['cmd'], key: 't' }} onAction={() => sendClipboard(device)} />
            <Action title="Look Again" icon={Icon.ArrowClockwise} shortcut={{ modifiers: ['cmd'], key: 'r' }} onAction={revalidate} />
            <Action.CopyToClipboard title="Copy Address" content={`${device.ip}:${String(device.port)}`} shortcut={{ modifiers: ['cmd'], key: 'c' }} />
          </ActionPanel.Section>
        </ActionPanel>
      }
    />
  )
})

const ReceivedRow = memo(function ReceivedRow({ entry }: { entry: Received }) {
  if (entry.isMessage) {
    return (
      <List.Item
        key={entry.id}
        id={entry.id}
        title={entry.fileName}
        subtitle={`message from ${entry.senderAlias}`}
        icon={Icon.Message}
        accessories={[{ text: entry.when }]}
        actions={
          <ActionPanel>
            <ActionPanel.Section>
              <Action.CopyToClipboard title="Copy Text" content={entry.fileName} />
              <Action.Paste title="Paste Text" content={entry.fileName} />
            </ActionPanel.Section>
          </ActionPanel>
        }
      />
    )
  }
  return (
    <List.Item
      key={entry.id}
      id={entry.id}
      title={entry.fileName}
      subtitle={`from ${entry.senderAlias}`}
      icon={fileIcon(entry)}
      accessories={[
        ...(entry.exists ? [] : [{ tag: { value: 'missing', color: Color.Red } }]),
        { text: entry.sizeText },
        { text: entry.when }
      ]}
      actions={
        <ActionPanel>
          <ActionPanel.Section>
            <Action.Open title="Open" target={entry.path} icon={Icon.Document} />
          </ActionPanel.Section>
          <ActionPanel.Section>
            <Action.Open title="Open Containing Folder" target={dirname(entry.path)} icon={Icon.Folder} shortcut={{ modifiers: ['cmd'], key: 'o' }} />
            <Action.CopyToClipboard title="Copy Path" content={entry.path} shortcut={{ modifiers: ['cmd'], key: 'c' }} />
          </ActionPanel.Section>
        </ActionPanel>
      }
    />
  )
})

export default function Command(props: { launchContext?: { category?: string } }) {
  const requested = props.launchContext?.category
  const [category, setCategory] = useState<string>(
    typeof requested === 'string' && CATEGORIES.some((entry) => entry.id === requested) ? requested : 'devices'
  )
  const identity = useRef<Identity | undefined>(undefined)
  const abortable = useRef<AbortController | null>(null)
  // The first look is short so the list has something on it quickly; the full
  // window follows once that one is in, carrying its devices along so nothing
  // found early disappears while the longer pass runs.
  const wide = useRef(false)
  const carried = useRef<Device[]>([])

  const devices = usePromise(
    async () => {
      identity.current ??= await identityOf()
      const full = wide.current
      const found = await discover(
        identity.current,
        abortable.current?.signal,
        full ? WIDE_WINDOW_MS : FIRST_WINDOW_MS,
        scanInterfaces()
      )
      const merged = full ? mergeDevices(carried.current, found) : found
      carried.current = full ? [] : found
      return merged
    },
    [],
    { abortable, execute: category === 'devices' }
  )
  const received = usePromise(listReceived, [], { execute: category === 'received' })
  const current = category === 'devices' ? devices : received

  const revalidateDevices = devices.revalidate
  useEffect(() => {
    if (wide.current || devices.data === undefined) return
    wide.current = true
    void revalidateDevices().catch(() => undefined)
  }, [devices.data, revalidateDevices])

  const deviceRows = useMemo(
    () => (devices.data ?? []).map((device) => <DeviceRow key={device.fingerprint} device={device} revalidate={revalidateDevices} />),
    [devices.data, revalidateDevices]
  )
  const receivedRows = useMemo(
    () => (received.data ?? []).map((entry) => <ReceivedRow key={entry.id} entry={entry} />),
    [received.data]
  )

  return (
    <List
      isLoading={current.isLoading}
      searchBarPlaceholder={category === 'devices' ? 'Filter devices' : 'Filter received files'}
      searchBarAccessory={
        <List.Dropdown tooltip="Category" value={category} onChange={setCategory}>
          {CATEGORIES.map((entry) => (
            <List.Dropdown.Item key={entry.id} title={entry.title} value={entry.id} />
          ))}
        </List.Dropdown>
      }
    >
      {current.error !== undefined && (
        <List.EmptyView
          icon={Icon.Warning}
          title={category === 'devices' ? 'Could not look for devices' : 'Could not read LocalSend history'}
          description={current.error.message}
        />
      )}
      {current.error === undefined && !current.isLoading && (current.data ?? []).length === 0 && (
        category === 'devices' ? (
          <List.EmptyView icon={Icon.Network} title="No LocalSend devices found" description="Open LocalSend on the other device, then press Ctrl+R" />
        ) : (
          <List.EmptyView icon={Icon.Download} title="Nothing received yet" description="Files LocalSend saves show up here" />
        )
      )}
      {category === 'devices' ? deviceRows : receivedRows}
    </List>
  )
}
