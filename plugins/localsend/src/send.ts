/**
 * The transfer itself, as a process of its own. The launcher ends a command's
 * worker the moment the panel hides, and a person sending a large file will
 * hide it - so the plugin hands the job to this script, detached, and only
 * watches its progress for as long as it is around. Run on the launcher's own
 * Node (Electron with ELECTRON_RUN_AS_NODE), which strips the types itself.
 *
 * Argument: the path of a job file, JSON of the Job shape below. Progress goes
 * to stdout as one JSON line per event; if nobody is listening any more, the
 * outcome becomes a desktop notification instead.
 */
import { promises as fs } from 'node:fs'
import { execFile } from 'node:child_process'
import { identityFrom, send, SendError, type Device, type Outgoing } from './protocol.ts'

export interface Job {
  device: Device
  alias: string
  certificate: string
  privateKey: string
  files: Outgoing[]
}

export type Event =
  | { type: 'waiting' }
  | { type: 'progress'; done: number; total: number; fileName: string }
  | { type: 'done'; sent: number }
  | { type: 'failed'; message: string }

let orphaned = false
process.stdin.on('end', () => (orphaned = true))
process.stdin.on('close', () => (orphaned = true))
process.stdin.on('error', () => (orphaned = true))
process.stdin.resume()
process.stdout.on('error', () => (orphaned = true))

function emit(event: Event): void {
  if (orphaned) return
  try {
    process.stdout.write(`${JSON.stringify(event)}\n`)
  } catch {
    orphaned = true
  }
}

function notify(title: string, body: string): void {
  execFile('notify-send', ['--app-name=LocalSend', title, body], () => undefined)
}

async function main(): Promise<void> {
  const jobFile = process.argv[2]
  if (jobFile === undefined) throw new Error('no job file')
  const job = JSON.parse(await fs.readFile(jobFile, 'utf8')) as Job
  await fs.unlink(jobFile).catch(() => undefined)
  const identity = identityFrom(job.alias, job.certificate, job.privateKey)
  emit({ type: 'waiting' })
  try {
    const sent = await send(job.device, identity, job.files, (done, total, fileName) => emit({ type: 'progress', done, total, fileName }))
    emit({ type: 'done', sent })
    if (orphaned) {
      const text = job.files.every((file) => file.text !== undefined)
      notify(`Sent to ${job.device.alias}`, sent === 0 ? 'The device accepted nothing' : text ? 'Text delivered' : `${String(sent)} ${sent === 1 ? 'file' : 'files'}`)
    }
  } catch (error) {
    const message = error instanceof SendError || error instanceof Error ? error.message : String(error)
    emit({ type: 'failed', message })
    if (orphaned) notify(`Could not send to ${job.device.alias}`, message)
  }
}

// Never `process.exit()`: it abandons queued stdout writes, and the last line
// (`done` or `failed`) is the one that matters. Dropping the stdin ref lets
// the loop drain and the process end on its own once stdout has flushed.
main().then(
  () => {
    process.exitCode = 0
    process.stdin.pause()
  },
  (error: unknown) => {
    emit({ type: 'failed', message: error instanceof Error ? error.message : String(error) })
    process.exitCode = 1
    process.stdin.pause()
  }
)
