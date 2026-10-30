import { constants } from 'fs'
import { lstat, open, readdir, realpath } from 'fs/promises'
import path from 'path'
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
  dataMigrated = false
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
        ;(value as Record<string, unknown>)[key] = path.resolve(path.dirname(configPath), item)
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
  let total = 0
  async function collect(directory: string): Promise<void> {
    await rememberDirectory(directory)
    await verifyAncestors()
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const filePath = path.join(directory, entry.name)
      const relative = path.relative(sourceRoot, filePath)
      if (entry.isSymbolicLink())
        throw new Error(`Service snapshots cannot import symbolic links: ${relative}`)
      if (entry.isDirectory()) {
        await collect(filePath)
        continue
      }
      if (!entry.isFile() || /(^|\/)(config\.ya?ml|core\.sock|core\.log)$/.test(relative)) continue
      const stateFile = /(?:\.db(?:-wal|-shm)?|\.sqlite(?:3)?|cache\.db)$/.test(relative)
      if (stateFile && dataMigrated) continue
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
    }
  }
  await collect(sourceRoot)
  return {
    config: stringify(rewriteManagedPaths(config, sourceRoot, destinationRoot)),
    files,
    ageSecretKey
  }
}
