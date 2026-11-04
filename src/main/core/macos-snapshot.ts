import { constants } from 'fs'
import { lstat, open, readdir, realpath } from 'fs/promises'
import path from 'path'
import { createHash } from 'crypto'
import { parse, stringify } from '../utils/yaml'

interface SnapshotFile {
  path: string
  data: string
  importOnly?: boolean
}
export interface MacCoreSnapshot {
  config: string
  files: SnapshotFile[]
  ageSecretKey?: string
}
const MAX_BYTES = 512 * 1024 * 1024
export interface SnapshotResource {
  source: string
  digest?: string
}
const resources = new WeakMap<MacCoreSnapshot, Record<string, SnapshotResource>>()
export const getSnapshotResources = (snapshot: MacCoreSnapshot): Record<string, SnapshotResource> =>
  resources.get(snapshot) || {}

export function rewriteManagedPaths(
  value: unknown,
  sourceRoot: string,
  destinationRoot: string
): unknown {
  if (typeof value === 'string' && path.isAbsolute(value)) {
    const relative = path.relative(sourceRoot, value)
    if (
      relative === '' ||
      (!relative.startsWith('../') && relative !== '..' && !path.isAbsolute(relative))
    ) {
      return path.join(destinationRoot, relative)
    }
    return value
  }
  if (Array.isArray(value))
    return value.map((item) => rewriteManagedPaths(item, sourceRoot, destinationRoot))
  if (value && typeof value === 'object')
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [
        key,
        rewriteManagedPaths(item, sourceRoot, destinationRoot)
      ])
    )
  return value
}

export async function createMacCoreSnapshot(
  sourceRoot: string,
  configPath: string,
  destinationRoot: string,
  ageSecretKey?: string,
  dataMigrated = false,
  configBaseDir?: string
): Promise<MacCoreSnapshot> {
  sourceRoot = path.resolve(sourceRoot)
  configPath = path.resolve(configPath)
  const configRelative = path.relative(sourceRoot, configPath)
  if (
    configRelative.startsWith('../') ||
    configRelative === '..' ||
    path.isAbsolute(configRelative)
  )
    throw new Error('Service configuration must be inside the work directory')
  const canonicalRoot = await realpath(sourceRoot)
  const ancestors = new Map<string, { dev: number; ino: number }>()
  async function rememberDirectory(directory: string): Promise<void> {
    const stat = await lstat(directory)
    if (!stat.isDirectory() || stat.isSymbolicLink())
      throw new Error(`Service snapshots cannot import symbolic links: ${directory}`)
    ancestors.set(directory, { dev: stat.dev, ino: stat.ino })
  }
  async function verifyAncestors(): Promise<void> {
    for (const [directory, identity] of ancestors) {
      const stat = await lstat(directory)
      const real = await realpath(directory)
      const relative = path.relative(canonicalRoot, real)
      if (
        !stat.isDirectory() ||
        stat.isSymbolicLink() ||
        stat.dev !== identity.dev ||
        stat.ino !== identity.ino ||
        relative === '..' ||
        relative.startsWith('../') ||
        path.isAbsolute(relative)
      )
        throw new Error('Snapshot source directory changed')
    }
  }
  await rememberDirectory(sourceRoot)
  // A configuration in a per-profile directory needs the same ancestor checks as resources.
  for (
    let directory = path.dirname(configPath);
    directory !== sourceRoot;
    directory = path.dirname(directory)
  )
    await rememberDirectory(directory)
  async function readRegular(filePath: string, limit: number): Promise<Buffer> {
    const handle = await open(filePath, constants.O_RDONLY | constants.O_NOFOLLOW)
    try {
      await verifyAncestors()
      const stat = await handle.stat()
      const resolved = await lstat(filePath)
      if (stat.dev !== resolved.dev || stat.ino !== resolved.ino)
        throw new Error('Snapshot file changed during open')
      if (!stat.isFile() || stat.size > limit)
        throw new Error('Snapshot file exceeds import limit or is not a regular file')
      const buffer = Buffer.alloc(stat.size + 1)
      let length = 0
      while (length < buffer.length) {
        const { bytesRead } = await handle.read(buffer, length, buffer.length - length, null)
        if (!bytesRead) break
        length += bytesRead
      }
      const after = await handle.stat()
      await verifyAncestors()
      if (length !== stat.size || after.size !== stat.size || after.mtimeMs !== stat.mtimeMs)
        throw new Error('Snapshot source file changed')
      return buffer.subarray(0, length)
    } finally {
      await handle.close()
    }
  }
  const config = parse<Record<string, unknown>>(
    (await readRegular(configPath, 16 * 1024 * 1024)).toString('utf8')
  )
  ancestors.clear()
  await rememberDirectory(sourceRoot)
  // Relative provider/history paths normally resolve against the selected profile's home.
  // The protected process has one fixed home, so retain that meaning explicitly.
  function resolveRelativePaths(value: unknown): void {
    if (!value || typeof value !== 'object') return
    for (const [key, item] of Object.entries(value)) {
      if (key === 'path' && typeof item === 'string' && !path.isAbsolute(item)) {
        ;(value as Record<string, unknown>)[key] = path.resolve(
          configBaseDir || path.dirname(configPath),
          item
        )
      } else resolveRelativePaths(item)
    }
  }
  resolveRelativePaths(config)
  // Root mode never accepts shell hooks or public controllers from a subscription.
  for (const key of [
    'external-controller',
    'external-controller-tls',
    'external-controller-unix',
    'external-ui',
    'external-ui-url',
    'secret',
    'post-up',
    'post-down'
  ])
    delete config[key]
  const files: SnapshotFile[] = []
  const resourceMap: Record<string, SnapshotResource> = {}
  let total = 0
  const imported = new Set<string>()
  async function importUserResource(
    source: string,
    relative: string,
    stateFile: boolean
  ): Promise<void> {
    if (imported.has(relative)) return
    imported.add(relative)
    resourceMap[relative] = { source }
    let canonical: string
    try {
      canonical = await realpath(source)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        if (stateFile) files.push({ path: relative, data: '', importOnly: true })
        return
      }
      throw error
    }
    const handle = await open(canonical, constants.O_RDONLY | constants.O_NOFOLLOW)
    try {
      const before = await handle.stat()
      if (!before.isFile() || before.size + total > MAX_BYTES || files.length >= 4096)
        throw new Error('Service resource exceeds import limit or is not a regular file')
      const data = await handle.readFile()
      const after = await handle.stat()
      if (
        data.length !== before.size ||
        after.size !== before.size ||
        after.mtimeMs !== before.mtimeMs
      )
        throw new Error('Service resource changed while reading')
      total += data.length
      resourceMap[relative].digest = createHash('sha256').update(data).digest('hex')
      files.push({
        path: relative,
        data: data.toString('base64'),
        ...(stateFile ? { importOnly: true } : {})
      })
    } finally {
      await handle.close()
    }
  }
  // Resolve user-readable resource references before sending bytes to root. The
  // helper still never follows user symlinks or opens user-supplied root paths.
  async function importReferences(value: unknown): Promise<void> {
    if (!value || typeof value !== 'object') return
    for (const [key, item] of Object.entries(value)) {
      if (key === 'custom-certifactes' && Array.isArray(item)) {
        for (let i = 0; i < item.length; i++) {
          const reference = { certificate: item[i] }
          await importReferences(reference)
          item[i] = reference.certificate
        }
        continue
      }
      if (
        ['path', 'certificate', 'private-key', 'client-auth-cert', 'ech-key'].includes(key) &&
        typeof item === 'string' &&
        item &&
        !item.includes('-----BEGIN') &&
        !item.includes('\n') &&
        !item.includes('://')
      ) {
        const source = path.resolve(configBaseDir || path.dirname(configPath), item)
        const local = path.relative(sourceRoot, source)
        const inside = local !== '..' && !local.startsWith('../') && !path.isAbsolute(local)
        const relative = inside
          ? local
          : `imports/${createHash('sha256').update(source).digest('hex').slice(0, 24)}/${path.basename(source)}`
        const info = await lstat(source).catch((error: NodeJS.ErrnoException) => {
          if (error.code === 'ENOENT') return undefined
          throw error
        })
        const resolved = info ? await realpath(source) : undefined
        const linked = inside && resolved && resolved !== path.join(canonicalRoot, local)
        if (!inside || info?.isSymbolicLink() || linked) {
          await importUserResource(source, relative, /\.(db|sqlite3?)(-wal|-shm)?$/.test(source))
          ;(value as Record<string, unknown>)[key] = path.join(destinationRoot, relative)
        }
        resourceMap[relative] ||= { source }
      } else await importReferences(item)
    }
  }
  await importReferences(config)
  async function collect(directory: string): Promise<void> {
    await rememberDirectory(directory)
    await verifyAncestors()
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const filePath = path.join(directory, entry.name)
      const relative = path.relative(sourceRoot, filePath)
      // Referenced symbolic links were materialized above as ordinary files.
      if (entry.isSymbolicLink() || imported.has(relative)) continue
      if (entry.isDirectory()) {
        await collect(filePath)
        continue
      }
      if (!entry.isFile() || /(^|\/)(config\.ya?ml|core\.sock|core\.log)$/.test(relative)) continue
      const stateFile = /(?:\.db(?:-wal|-shm)?|\.sqlite(?:3)?|cache\.db)$/.test(relative)
      if (stateFile && dataMigrated) {
        resourceMap[relative] = {
          source: filePath,
          digest: createHash('sha256')
            .update(await readRegular(filePath, MAX_BYTES))
            .digest('hex')
        }
        continue
      }
      const before = await lstat(filePath)
      if (before.size + total > MAX_BYTES || files.length >= 4096)
        throw new Error('Service snapshot exceeds the 512 MiB / 4096 file import limit')
      const data = await readRegular(filePath, MAX_BYTES - total)
      total += data.length
      files.push({
        path: relative,
        data: data.toString('base64'),
        ...(stateFile ? { importOnly: true } : {})
      })
      resourceMap[relative] = {
        source: filePath,
        digest: createHash('sha256').update(data).digest('hex')
      }
    }
  }
  await collect(sourceRoot)
  for (const name of ['traffic-history.db', 'cache.db', 'Model.bin'])
    resourceMap[name] ||= { source: path.join(sourceRoot, name) }
  const snapshot: MacCoreSnapshot = {
    config: stringify(rewriteManagedPaths(config, sourceRoot, destinationRoot)),
    files,
    ageSecretKey
  }
  resources.set(snapshot, resourceMap)
  return snapshot
}
