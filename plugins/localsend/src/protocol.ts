/**
 * The LocalSend protocol v2, with Node builtins only: multicast discovery over
 * UDP, an /info scan of the RFC1918 LAN interfaces, and prepare-upload +
 * upload over the device's own HTTP(S) port. Devices use self-signed
 * certificates, so no authority is checked; instead the certificate a device
 * presents is pinned to the fingerprint it announced, and a file leaves this
 * machine only for the certificate whose hash the row shows.
 */
import dgram from 'node:dgram'
import http from 'node:http'
import https from 'node:https'
import os from 'node:os'
import { createReadStream, promises as fs } from 'node:fs'
import { basename, extname, join } from 'node:path'
import { X509Certificate, createPrivateKey, randomUUID } from 'node:crypto'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { Readable, pipeline } from 'node:stream'

const run = promisify(execFile)

export const MULTICAST_GROUP = '224.0.0.167'
export const PORT = 53317
const PROTOCOL_VERSION = '2.1'

export interface Device {
  /** The device's fingerprint - stable across launches, the id of a row. */
  fingerprint: string
  alias: string
  ip: string
  port: number
  protocol: 'http' | 'https'
  /** True only when an https connection was made and the certificate it presented matched the announced fingerprint. */
  verified: boolean
  deviceModel?: string
  deviceType?: string
  download?: boolean
}

export interface Identity {
  alias: string
  /** Uppercase hex SHA-256 of the certificate in DER form - what LocalSend calls a fingerprint. */
  fingerprint: string
  certificate: string
  privateKey: string
}

interface Announcement {
  alias?: string
  version?: string
  deviceModel?: string
  deviceType?: string
  fingerprint?: string
  port?: number
  protocol?: string
  download?: boolean
  announce?: boolean
}

/**
 * Our own identity: a self-signed certificate, minted once with openssl into
 * the plugin's support directory. Devices running LocalSend 1.18 or newer
 * only talk to clients that present one, and its hash is our fingerprint.
 */
export async function loadIdentity(supportPath: string, aliasPreference: string, appAlias: string | undefined): Promise<Identity> {
  const keyFile = join(supportPath, 'key.pem')
  const certFile = join(supportPath, 'cert.pem')
  let privateKey: string
  let certificate: string
  // Minted into temporary names and renamed into place, then the pair is
  // checked: two concurrent mints used to leave a key from one run beside a
  // certificate from the other, and a device that announces one certificate
  // and presents another is exactly what the pin refuses.
  const mint = async (): Promise<void> => {
    await fs.mkdir(supportPath, { recursive: true, mode: 0o700 })
    const tag = randomUUID()
    const tmpKey = `${keyFile}.tmp-${tag}`
    const tmpCert = `${certFile}.tmp-${tag}`
    await run(
      'openssl',
      ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '36500', '-subj', '/CN=LocalSend User', '-keyout', tmpKey, '-out', tmpCert],
      { timeout: 15_000 }
    )
    await fs.chmod(tmpKey, 0o600)
    await fs.rename(tmpKey, keyFile)
    await fs.rename(tmpCert, certFile)
  }
  const read = async (): Promise<[string, string]> =>
    Promise.all([fs.readFile(keyFile, 'utf8'), fs.readFile(certFile, 'utf8')])
  const paired = (key: string, cert: string): boolean => {
    try {
      return new X509Certificate(cert).checkPrivateKey(createPrivateKey(key))
    } catch {
      return false
    }
  }
  try {
    ;[privateKey, certificate] = await read()
  } catch {
    await mint()
    ;[privateKey, certificate] = await read()
  }
  if (!paired(privateKey, certificate)) {
    await mint()
    ;[privateKey, certificate] = await read()
    if (!paired(privateKey, certificate)) throw new Error('the identity certificate does not match its private key')
  }
  return identityFrom(alias(aliasPreference, appAlias), certificate, privateKey)
}

/** A fingerprint as LocalSend spells it: the SHA-256 in uppercase hex with no colons. */
const normalFingerprint = (fingerprint: string): string => fingerprint.replaceAll(':', '').toUpperCase()

export function identityFrom(alias: string, certificate: string, privateKey: string): Identity {
  const fingerprint = new X509Certificate(certificate).fingerprint256.replaceAll(':', '').toUpperCase()
  return { alias, fingerprint, certificate, privateKey }
}

const alias = (preference: string, appAlias: string | undefined): string => preference.trim() || appAlias || os.hostname()

function selfAnnouncement(identity: Identity, port: number, announce: boolean): string {
  return JSON.stringify({
    alias: identity.alias,
    version: PROTOCOL_VERSION,
    deviceModel: 'Linux',
    deviceType: 'desktop',
    fingerprint: identity.fingerprint,
    port,
    protocol: 'http',
    download: false,
    announce
  })
}

function toDevice(raw: Announcement, ip: string): Device | null {
  if (typeof raw.fingerprint !== 'string' || raw.fingerprint === '') return null
  return {
    fingerprint: raw.fingerprint,
    alias: typeof raw.alias === 'string' && raw.alias !== '' ? raw.alias : ip,
    ip,
    port: typeof raw.port === 'number' ? raw.port : PORT,
    protocol: raw.protocol === 'http' ? 'http' : 'https',
    verified: false,
    deviceModel: raw.deviceModel,
    deviceType: raw.deviceType,
    download: raw.download
  }
}

function request(
  device: Pick<Device, 'ip' | 'port' | 'protocol'>,
  identity: Identity | undefined,
  path: string,
  options: {
    method?: string
    timeout?: number
    body?: string | NodeJS.ReadableStream
    contentLength?: number
    headers?: Record<string, string>
    /** A normalised fingerprint the peer's certificate must hash to, or the request is destroyed. */
    expect?: string
  } = {}
): Promise<{ status: number; body: string; observed?: string }> {
  return new Promise((resolve, reject) => {
    // The fingerprint256 the TLS peer actually presented, read on the socket.
    let observed: string | undefined
    const mod = device.protocol === 'https' ? https : http
    const headers: Record<string, string> = { ...options.headers }
    if (typeof options.body === 'string') {
      headers['Content-Type'] = 'application/json'
      headers['Content-Length'] = String(Buffer.byteLength(options.body))
    } else if (options.contentLength !== undefined) {
      headers['Content-Type'] = 'application/octet-stream'
      headers['Content-Length'] = String(options.contentLength)
    }
    const req = mod.request(
      {
        host: device.ip,
        port: device.port,
        path,
        method: options.method ?? 'GET',
        headers,
        timeout: options.timeout ?? 1500,
        rejectUnauthorized: false,
        ...(identity !== undefined ? { key: identity.privateKey, cert: identity.certificate } : {})
      },
      (res) => {
        let body = ''
        res.setEncoding('utf8')
        res.on('data', (chunk: string) => (body += chunk))
        res.on('end', () =>
          resolve({ status: res.statusCode ?? 0, body, ...(observed === undefined ? {} : { observed }) })
        )
      }
    )
    req.on('error', reject)
    if (device.protocol === 'https') {
      // Pinned here, on the socket: under `rejectUnauthorized: false` Node
      // never calls `checkServerIdentity` for a self-signed peer (probed on
      // Node 26), so `secureConnect` is the only place the presented
      // certificate can be compared with the announced fingerprint.
      req.on('socket', (socket) => {
        socket.on('secureConnect', () => {
          const peer = (socket as import('node:tls').TLSSocket).getPeerCertificate()
          observed = peer.fingerprint256 === undefined ? undefined : normalFingerprint(peer.fingerprint256)
          if (options.expect !== undefined && observed !== normalFingerprint(options.expect)) {
            req.destroy(new Error('the device presented a different certificate'))
          }
        })
      })
    }
    req.on('timeout', () => req.destroy(new Error('timed out')))
    if (typeof options.body === 'string') req.end(options.body)
    else if (options.body !== undefined) {
      // A read error (the file moved) is this request's rejection, so the
      // caller's `/cancel` still fires, rather than an uncaught exception.
      pipeline(options.body, req, (error) => {
        if (error) reject(error)
      })
    } else req.end()
  })
}

async function info(identity: Identity, ip: string, protocol: 'http' | 'https', timeout: number): Promise<Device | null> {
  if (timeout <= 0) return null
  try {
    const { status, body, observed } = await request({ ip, port: PORT, protocol }, identity, '/api/localsend/v2/info', { timeout })
    if (status !== 200) return null
    const raw = JSON.parse(body) as Announcement
    const device = toDevice(raw, ip)
    if (device === null) return null
    // Verified means the certificate on the wire hashed to what the device announced.
    const verified = protocol === 'https' && observed !== undefined && observed === normalFingerprint(device.fingerprint)
    return { ...device, protocol, port: PORT, verified }
  } catch {
    return null
  }
}

/**
 * How many hosts are asked for /info at once: one probe per host of a /24, so
 * a silent subnet is still covered inside one window (a dead host holds its
 * socket for the whole probe timeout, and a smaller pool would leave hosts
 * unasked when the window closes).
 */
const SCAN_CONCURRENCY = 256

/** The longest one /info probe waits, when the window has room for it. */
const PROBE_TIMEOUT = 1500

/** Runs `work` over `items` with at most `limit` of them in flight. */
async function pool<T>(items: readonly T[], limit: number, work: (item: T) => Promise<void>): Promise<void> {
  let next = 0
  const worker = async (): Promise<void> => {
    while (next < items.length) {
      const item = items[next++]
      if (item !== undefined) await work(item)
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker))
}

/** Interface name prefixes that are never a LAN: loopback, container bridges, tunnels and VPNs. */
const SKIPPED_INTERFACES = ['docker', 'br-', 'veth', 'tun', 'tap', 'wg', 'tailscale', 'zt', 'ppp', 'utun']

const isRfc1918 = (ip: string): boolean => {
  const [a, b] = ip.split('.').map(Number)
  return a === 10 || (a === 172 && b !== undefined && b >= 16 && b <= 31) || (a === 192 && b === 168)
}

/** A /24 or narrower: a /16 corporate range is not ours to sweep, a /32 is not a LAN. */
const isLanMask = (netmask: string): boolean => {
  const [a, b, c, d] = netmask.split('.').map(Number)
  return a === 255 && b === 255 && c === 255 && d !== undefined && d < 255
}

/** The LAN addresses this machine has, each with its interface name. */
export function lanAddresses(
  interfaces: NodeJS.Dict<os.NetworkInterfaceInfo[]> = os.networkInterfaces(),
  only: readonly string[] = []
): { name: string; address: string }[] {
  const found: { name: string; address: string }[] = []
  for (const [name, addresses] of Object.entries(interfaces)) {
    if (only.length > 0 ? !only.includes(name) : name === 'lo' || SKIPPED_INTERFACES.some((prefix) => name.startsWith(prefix))) continue
    for (const address of addresses ?? []) {
      if (address.family !== 'IPv4' || address.internal || address.address.startsWith('169.254.')) continue
      if (!isRfc1918(address.address) || !isLanMask(address.netmask)) continue
      found.push({ name, address: address.address })
    }
  }
  return found
}

/**
 * Every /24 this machine sits in on an ordinary LAN: RFC1918 addresses on
 * interfaces that are not loopback, a container bridge, a tunnel or a VPN,
 * with a /24 or narrower mask. `only` pins the scan to named interfaces.
 */
export function subnetHosts(
  interfaces: NodeJS.Dict<os.NetworkInterfaceInfo[]> = os.networkInterfaces(),
  only: readonly string[] = []
): string[] {
  const hosts: string[] = []
  for (const { address } of lanAddresses(interfaces, only)) {
    const prefix = address.split('.').slice(0, 3).join('.')
    for (let i = 1; i < 255; i++) hosts.push(`${prefix}.${i}`)
  }
  return hosts
}

/**
 * Announce ourselves on the multicast group and collect the replies, and in
 * parallel ask every host on the subnet for /info - the app does the same two
 * things, and the scan is what finds a device whose multicast is filtered.
 * A device answers an announcement with POST /register to the port we
 * announced, falling back to multicast only when that fails, so a plain HTTP
 * server on an ephemeral port takes the replies for as long as we listen.
 */
/** The most a /register body may carry; a real announcement is a few hundred bytes. */
const REGISTER_BODY_LIMIT = 64 * 1024

export async function discover(
  identity: Identity,
  signal?: AbortSignal,
  windowMs = 2500,
  only: readonly string[] = []
): Promise<Device[]> {
  const found = new Map<string, Device>()
  const add = (device: Device | null): void => {
    if (device === null || device.fingerprint === identity.fingerprint) return
    const previous = found.get(device.fingerprint)
    if (previous === undefined || (previous.protocol === 'http' && device.protocol === 'https')) found.set(device.fingerprint, device)
  }

  const server = http.createServer((req, res) => {
    let body = ''
    let over = false
    req.setEncoding('utf8')
    req.on('data', (chunk: string) => {
      if (over) return
      body += chunk
      // Bounded: one peer must not grow this worker's heap towards its ceiling.
      if (body.length > REGISTER_BODY_LIMIT) {
        over = true
        res.writeHead(413)
        res.end()
        req.destroy()
      }
    })
    req.on('end', () => {
      if (over) return
      if (req.method === 'POST' && req.url?.startsWith('/api/localsend/v2/register')) {
        try {
          add(toDevice(JSON.parse(body) as Announcement, req.socket.remoteAddress?.replace(/^::ffff:/, '') ?? ''))
        } catch {
          /* not a LocalSend register */
        }
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(selfAnnouncement(identity, PORT, false))
        return
      }
      res.writeHead(404)
      res.end()
    })
  })
  server.headersTimeout = 5000
  server.requestTimeout = 10_000
  // Bound to the one LAN address when there is exactly one; several would
  // need one server each, so the wildcard stays as the fallback there.
  const lan = lanAddresses(os.networkInterfaces(), only)
  const bindAddress = lan.length === 1 ? (lan[0]?.address ?? '0.0.0.0') : '0.0.0.0'
  const registerPort = await new Promise<number>((resolve) => {
    server.listen(0, bindAddress, () => {
      const address = server.address()
      resolve(typeof address === 'object' && address !== null ? address.port : PORT)
    })
  })

  const multicast = new Promise<void>((resolve) => {
    const socket = dgram.createSocket({ type: 'udp4', reuseAddr: true })
    let done = false
    const finish = (): void => {
      if (done) return
      done = true
      try {
        socket.close()
      } catch {
        /* already closed */
      }
      resolve()
    }
    socket.on('error', finish)
    socket.on('message', (message, rinfo) => {
      try {
        add(toDevice(JSON.parse(message.toString()) as Announcement, rinfo.address))
      } catch {
        /* not a LocalSend packet */
      }
    })
    socket.bind(PORT, () => {
      try {
        socket.setMulticastTTL(1)
        socket.addMembership(MULTICAST_GROUP)
      } catch {
        /* no multicast on this interface; the scan still runs */
      }
      const packet = selfAnnouncement(identity, registerPort, true)
      socket.send(packet, PORT, MULTICAST_GROUP)
      setTimeout(() => !done && socket.send(packet, PORT, MULTICAST_GROUP), 700)
    })
    setTimeout(finish, windowMs)
    signal?.addEventListener('abort', finish)
  })

  // Two probes per host across a whole /24 is five hundred sockets at once, so
  // they go through a pool - and the window bounds it, since a scan that
  // outlives the answer it belongs to is work nobody reads. `http` is only
  // tried for a host whose `https` probe came back with nothing.
  const deadline = Date.now() + windowMs
  const scan = pool(subnetHosts(os.networkInterfaces(), only), SCAN_CONCURRENCY, async (ip) => {
    if (signal?.aborted) return
    const secure = await info(identity, ip, 'https', Math.min(PROBE_TIMEOUT, deadline - Date.now()))
    if (secure !== null) {
      add(secure)
      return
    }
    if (signal?.aborted) return
    add(await info(identity, ip, 'http', Math.min(PROBE_TIMEOUT, deadline - Date.now())))
  })

  await Promise.all([multicast, scan])
  server.close()
  // Keep-alive sockets outlive `close()` on their own; discovery ends here.
  server.closeAllConnections()
  return [...found.values()].sort((a, b) => a.alias.localeCompare(b.alias))
}

export interface Outgoing {
  id: string
  fileName: string
  size: number
  fileType: string
  path?: string
  text?: string
}

const TYPE_BY_EXTENSION: Record<string, string> = {
  '.jpg': 'image',
  '.jpeg': 'image',
  '.png': 'image',
  '.gif': 'image',
  '.webp': 'image',
  '.heic': 'image',
  '.mp4': 'video',
  '.mkv': 'video',
  '.mov': 'video',
  '.webm': 'video',
  '.pdf': 'pdf',
  '.txt': 'text',
  '.md': 'text',
  '.apk': 'apk'
}

export function fileTypeOf(fileName: string): string {
  return TYPE_BY_EXTENSION[extname(fileName).toLowerCase()] ?? 'other'
}

export async function outgoingFile(path: string): Promise<Outgoing> {
  const stat = await fs.stat(path)
  if (!stat.isFile()) throw new Error(`${basename(path)} is not a file`)
  return { id: randomUUID(), fileName: basename(path), size: stat.size, fileType: fileTypeOf(path), path }
}

export function outgoingText(text: string): Outgoing {
  return { id: randomUUID(), fileName: `${randomUUID()}.txt`, size: Buffer.byteLength(text), fileType: 'text', text }
}

export class SendError extends Error {
  status: number | undefined
  constructor(message: string, status?: number) {
    super(message)
    this.status = status
  }
}

function explain(status: number): string {
  switch (status) {
    case 401:
      return 'the device asks for a PIN, which this plugin cannot enter'
    case 403:
      return 'the device declined'
    case 409:
      return 'the device is busy with another transfer'
    case 429:
      return 'the device says too many requests'
    case 500:
      return 'the device reported an error'
    default:
      return `the device answered ${String(status)}`
  }
}

/**
 * prepare-upload, then one upload per accepted file. The receiver may take a
 * while to answer the first call - a person has to tap Accept - so it waits
 * up to two minutes for that one.
 */
export async function send(
  device: Device,
  identity: Identity,
  files: Outgoing[],
  onProgress: (done: number, total: number, fileName: string) => void
): Promise<number> {
  // Every request here is pinned: a file leaves this machine only for the
  // certificate whose hash is the fingerprint the row shows.
  const expect = device.fingerprint
  const prepared = await request(device, identity, '/api/localsend/v2/prepare-upload', {
    method: 'POST',
    timeout: 120_000,
    expect,
    body: JSON.stringify({
      info: {
        alias: identity.alias,
        version: PROTOCOL_VERSION,
        deviceModel: 'Linux',
        deviceType: 'desktop',
        fingerprint: identity.fingerprint,
        port: PORT,
        protocol: 'http',
        download: false
      },
      files: Object.fromEntries(
        files.map((file) => [
          file.id,
          {
            id: file.id,
            fileName: file.fileName,
            size: file.size,
            fileType: file.fileType,
            ...(file.text !== undefined ? { preview: file.text } : {})
          }
        ])
      )
    })
  })
  // 204 is "nothing to upload": a message travels in prepare-upload itself
  // as the file's preview, so for text that is delivery, not refusal.
  if (prepared.status === 204) return files.every((file) => file.text !== undefined) ? files.length : 0
  if (prepared.status !== 200) throw new SendError(explain(prepared.status), prepared.status)

  const session = JSON.parse(prepared.body) as { sessionId: string; files: Record<string, string> }
  const accepted = files.filter((file) => session.files[file.id] !== undefined)
  let done = 0
  for (const file of accepted) {
    onProgress(done, accepted.length, file.fileName)
    const query = `sessionId=${encodeURIComponent(session.sessionId)}&fileId=${encodeURIComponent(file.id)}&token=${encodeURIComponent(session.files[file.id] ?? '')}`
    const result = await request(device, identity, `/api/localsend/v2/upload?${query}`, {
      method: 'POST',
      timeout: 600_000,
      body: file.path !== undefined ? createReadStream(file.path) : Readable.from([Buffer.from(file.text ?? '')]),
      contentLength: file.size,
      expect
    })
    if (result.status !== 200) {
      await request(device, identity, `/api/localsend/v2/cancel?sessionId=${encodeURIComponent(session.sessionId)}`, { method: 'POST', expect }).catch(() => undefined)
      throw new SendError(`${file.fileName}: ${explain(result.status)}`, result.status)
    }
    done++
  }
  return accepted.length
}
