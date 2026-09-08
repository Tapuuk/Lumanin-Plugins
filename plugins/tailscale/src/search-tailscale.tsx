/**
 * Your tailnet, through the tailscale CLI.
 *
 * Everything is one `tailscale status --json` call to the local daemon; SSH
 * opens a terminal running `tailscale ssh`, and exit-node changes go through
 * `tailscale set`. No network of our own, no dependencies.
 */
import {
  Action,
  ActionPanel,
  Color,
  Icon,
  List,
  Toast,
  closeMainWindow,
  confirmAlert,
  getPreferenceValues,
  showToast,
  useExec
} from 'lumanin'
import { useState } from 'react'
import { execFile, spawn } from 'node:child_process'
import { promisify } from 'node:util'

const run = promisify(execFile)

const CATEGORIES = [{ id: 'devices', title: 'Devices' }] as const

interface Preferences {
  tailscaleBinary?: string
  terminal?: string
}

interface Device {
  /** The stable node id tailscale assigns - the id of a row. */
  id: string
  hostname: string
  dnsName: string
  os: string
  ip: string
  online: boolean
  self: boolean
  exitNodeOption: boolean
  exitNodeActive: boolean
}

interface Status {
  BackendState?: string
  Self?: StatusPeer
  Peer?: Record<string, StatusPeer>
}

interface StatusPeer {
  ID?: string
  HostName?: string
  DNSName?: string
  OS?: string
  TailscaleIPs?: string[]
  Online?: boolean
  ExitNodeOption?: boolean
  ExitNode?: boolean
}

const tailscaleBinary = (): string =>
  getPreferenceValues<Preferences>().tailscaleBinary?.trim() || 'tailscale'

const STATE_HINTS: Record<string, string> = {
  NeedsLogin: 'Run tailscale up in a terminal, then come back.',
  Stopped: 'Run tailscale up in a terminal, then come back.',
  NoState: 'Run tailscale up in a terminal, then come back.',
  Starting: 'Waiting for tailscaled.',
  NeedsMachineAuth: 'Approve this machine in the admin console.',
  InUseOtherUser: 'Another user is using tailscaled on this machine.'
}

const stateHint = (state: string): string =>
  STATE_HINTS[state] ?? 'Run tailscale status in a terminal to see why.'

function said(error: unknown): string {
  const stderr = (error as { stderr?: string }).stderr?.trim()
  return stderr || String((error as Error)?.message ?? error)
}

function toDevice(peer: StatusPeer, self: boolean): Device | null {
  if (typeof peer.ID !== 'string' || peer.ID === '') return null
  return {
    id: peer.ID,
    hostname: peer.HostName ?? '',
    dnsName: (peer.DNSName ?? '').replace(/\.$/, ''),
    os: peer.OS ?? '',
    ip: peer.TailscaleIPs?.[0] ?? '',
    online: peer.Online === true || self,
    self,
    exitNodeOption: peer.ExitNodeOption === true,
    exitNodeActive: peer.ExitNode === true
  }
}

/**
 * What the rows need out of `tailscale status --json`.
 *
 * Done here rather than in the component because this is what `useExec` caches:
 * the raw status carries every node key, IP and login name in the tailnet, and
 * none of that belongs in a file on disk.
 */
function parseStatus(outcome: {
  stdout: string
  stderr: string
  error?: Error
  exitCode: number | null
}): { state: string; devices: Device[] } {
  if (outcome.error) throw outcome.error
  if (outcome.exitCode !== 0) {
    throw new Error(outcome.stderr.trim() || 'tailscale status exited with code ' + String(outcome.exitCode))
  }
  // Only the parse is guarded: everything below is our own code over a decoded
  // object, and a bug there belongs on an error card, not recoloured as an
  // empty tailnet that is "Running".
  let parsed: Status
  try {
    parsed = JSON.parse(outcome.stdout || '{}') as Status
  } catch (error) {
    throw new Error('tailscale status did not return JSON: ' + String((error as Error).message ?? error).split('\n')[0])
  }
  const state = parsed.BackendState ?? 'Running'
  if (state !== 'Running') return { state, devices: [] }
  const devices: Device[] = []
  const self = parsed.Self ? toDevice(parsed.Self, true) : null
  if (self) devices.push(self)
  for (const peer of Object.values(parsed.Peer ?? {})) {
    const device = toDevice(peer, false)
    if (device) devices.push(device)
  }
  return { state, devices }
}

/**
 * The tailscale-assigned identity for this device: the DNS name (already
 * stripped of its trailing dot) or, when MagicDNS is off, the first
 * Tailscale IP. Never the peer's self-reported HostName, which is neither
 * unique nor trustworthy. A leading '-' is refused outright so nothing here
 * can be read as a flag by the tailscale CLI.
 */
function sshTarget(device: Device): string | null {
  const target = device.dnsName || device.ip
  return target !== '' && !target.startsWith('-') ? target : null
}

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

async function setExitNode(target: string, revalidate: () => void): Promise<void> {
  const clearing = target === ''
  const confirmed = await confirmAlert({
    title: clearing ? 'Stop using the exit node?' : 'Route all traffic through ' + target + '?',
    message: clearing
      ? 'Traffic goes out directly again.'
      : 'Everything this machine sends to the internet goes through that device until you turn it off.'
  })
  if (!confirmed) return
  try {
    await run(tailscaleBinary(), ['set', '--exit-node=' + target], { timeout: 10_000 })
    await showToast({
      style: Toast.Style.Success,
      title: clearing ? 'Exit node off' : 'Exit node set to ' + target
    })
  } catch (error) {
    const stderr = said(error)
    await showToast(
      /access denied/i.test(stderr)
        ? {
            style: Toast.Style.Failure,
            title: 'tailscale needs operator access',
            message: 'sudo tailscale set --operator=$USER'
          }
        : { style: Toast.Style.Failure, title: 'tailscale set refused', message: stderr }
    )
  }
  revalidate()
}

export default function SearchTailscale(props: {
  launchContext?: { category?: unknown }
}): React.JSX.Element {
  const requested = props.launchContext?.category
  const [category, setCategory] = useState(
    typeof requested === 'string' && CATEGORIES.some((entry) => entry.id === requested)
      ? requested
      : 'devices'
  )
  const { isLoading, data, error, revalidate } = useExec(tailscaleBinary(), ['status', '--json'], {
    parseOutput: parseStatus
  })
  // A cache written before the status was parsed here holds a string.
  const status = typeof data === 'object' && data !== null ? data : undefined
  const state = status?.state ?? 'Running'
  const devices = status?.devices ?? []
  const missing = (error as NodeJS.ErrnoException | undefined)?.code === 'ENOENT'
  void category

  return (
    <List
      isLoading={isLoading}
      searchBarPlaceholder="Search tailnet devices"
      searchBarAccessory={
        <List.Dropdown tooltip="Category" value={category} onChange={setCategory}>
          {CATEGORIES.map((cat) => (
            <List.Dropdown.Item key={cat.id} value={cat.id} title={cat.title} />
          ))}
        </List.Dropdown>
      }
    >
      {devices.map((device) => {
        const target = sshTarget(device)
        return (
        <List.Item
          key={device.id}
          id={device.id}
          title={device.hostname}
          subtitle={[device.dnsName, device.ip, device.os].filter((part) => part !== '').join('  ')}
          keywords={[device.dnsName, device.ip, device.os].filter((part) => part !== '')}
          icon={
            device.os === 'android' || device.os === 'iOS'
              ? Icon.Mobile
              : device.self
                ? Icon.Desktop
                : Icon.Network
          }
          accessories={[
            ...(device.self ? [{ tag: { value: 'this machine' } }] : []),
            ...(device.exitNodeActive ? [{ tag: { value: 'exit node', color: Color.Orange } }] : []),
            device.online
              ? { tag: { value: 'online', color: Color.Green } }
              : { tag: { value: 'offline', color: Color.SecondaryText } }
          ]}
          actions={
            <ActionPanel>
              <ActionPanel.Section>
                <Action.CopyToClipboard title="Copy IP" content={device.ip} />
              </ActionPanel.Section>
              <ActionPanel.Section>
                {!device.self && target && (
                  <Action
                    title="SSH in Terminal"
                    icon={Icon.Terminal}
                    shortcut={{ modifiers: ['cmd'], key: 's' }}
                    onAction={() => target && openInTerminal([tailscaleBinary(), 'ssh', target])}
                  />
                )}
                {!device.self && device.exitNodeOption && !device.exitNodeActive && target && (
                  <Action
                    title="Use as Exit Node"
                    icon={Icon.Globe}
                    shortcut={{ modifiers: ['cmd'], key: 'e' }}
                    onAction={() => target && void setExitNode(target, revalidate)}
                  />
                )}
                {device.exitNodeActive && (
                  <Action
                    title="Stop Using Exit Node"
                    icon={Icon.XMarkCircle}
                    shortcut={{ modifiers: ['cmd'], key: 'e' }}
                    onAction={() => void setExitNode('', revalidate)}
                  />
                )}
                <Action.CopyToClipboard
                  title="Copy DNS Name"
                  content={device.dnsName}
                  shortcut={{ modifiers: ['cmd'], key: 'c' }}
                />
              </ActionPanel.Section>
            </ActionPanel>
          }
        />
        )
      })}
      <List.EmptyView
        icon={Icon.Network}
        title={
          error
            ? missing
              ? tailscaleBinary() + ' is not installed or not on PATH'
              : 'tailscale did not answer'
            : state !== 'Running'
              ? 'Tailscale is ' + state
              : 'No devices'
        }
        description={
          error
            ? missing
              ? said(error).split('\n')[0]
              : said(error).split('\n')[0] +
                '\nIs tailscaled running and this machine signed in? Try tailscale status in a terminal.'
            : state !== 'Running'
              ? stateHint(state)
              : 'Your tailnet has no devices visible from here.'
        }
      />
    </List>
  )
}
