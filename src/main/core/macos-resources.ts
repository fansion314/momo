import { createHash } from 'crypto'
import { mkdir, readFile, realpath, rm } from 'fs/promises'
import path from 'path'
import { atomicWriteFile } from '../utils/safeFile'
import { managerLogger } from '../utils/logger'
import { getSnapshotResources, type MacCoreSnapshot, type SnapshotResource } from './macos-snapshot'
import { macServiceRequest } from './macos-service'

let resources: Record<string, SnapshotResource> = {}
export function rememberMacResources(snapshot: MacCoreSnapshot): void {
  resources = getSnapshotResources(snapshot)
}

// The core is stopped before export, including SQLite checkpointing. Only paths
// materialized by the ordinary user are written back, never paths from a reply.
export async function syncMacResources(): Promise<void> {
  const names = Object.keys(resources)
  if (!names.length) return
  const result = await macServiceRequest<{ files: { path: string; data: string }[] }>(
    '/v1/core/resources',
    Object.fromEntries(names.map((name) => [name, resources[name].digest ?? null])),
    60000
  )
  let size = 0
  for (const file of result.files) {
    const resource = resources[file.path]
    if (!resource) throw new Error('Service returned an unrequested resource')
    const data = Buffer.from(file.data, 'base64')
    size += data.length
    if (size > 512 * 1024 * 1024) throw new Error('Service resource export exceeds limit')
    let current: Buffer | undefined
    try {
      current = await readFile(resource.source)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    }
    const digest = current && createHash('sha256').update(current).digest('hex')
    if (current && digest !== resource.digest) {
      if (!current.equals(data))
        managerLogger.warn(`Preserved externally changed resource: ${resource.source}`)
      continue
    }
    if (current?.equals(data)) continue
    const target = await realpath(resource.source).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== 'ENOENT') throw error
      return resource.source
    })
    await mkdir(path.dirname(target), { recursive: true })
    if (/\.(db|sqlite3?)$/.test(target)) {
      await rm(`${target}-wal`, { force: true })
      await rm(`${target}-shm`, { force: true })
    }
    await atomicWriteFile(target, data, { mode: 0o600 })
    resource.digest = createHash('sha256').update(data).digest('hex')
  }
}
