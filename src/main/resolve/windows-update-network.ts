import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { lstat, open, rename, rm } from 'node:fs/promises'
import type {
  WindowsUpdateAsset,
  WindowsUpdateManifest,
  WindowsUpdateSource
} from '../../shared/windows-update'
import {
  compareWindowsVersions,
  parseWindowsReleaseTag,
  windowsUpdateAssetUrl,
  WINDOWS_UPDATE_CNB_FEED,
  WINDOWS_UPDATE_GITHUB_API,
  WINDOWS_UPDATE_MANIFEST_NAME
} from '../../shared/windows-update'
import { verifyWindowsUpdateEnvelope } from './windows-update-manifest'

export type UpdateFetch = (url: string, options?: RequestInit) => Promise<Response>
const JSON_LIMIT = 2 * 1024 * 1024

export async function fetchUpdateJson(
  url: string,
  fetcher: UpdateFetch,
  signal?: AbortSignal
): Promise<unknown> {
  const response = await fetcher(url, {
    signal,
    credentials: 'omit',
    headers: { Accept: 'application/json', 'User-Agent': 'Clash-Momo-Windows-Updater' }
  })
  if (!response.ok || !response.body || !response.url.startsWith('https://')) {
    await response.body?.cancel().catch(() => {})
    throw new Error(`Windows update source returned HTTP ${response.status}`)
  }
  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let length = 0
  try {
    while (true) {
      const next = await reader.read()
      if (next.done) break
      length += next.value.length
      if (length > JSON_LIMIT) throw new Error('Windows update metadata is too large')
      chunks.push(next.value)
    }
    return JSON.parse(Buffer.concat(chunks).toString('utf8'))
  } finally {
    await reader.cancel().catch(() => {})
    reader.releaseLock()
  }
}

export async function findWindowsUpdate(
  source: WindowsUpdateSource,
  current: { version: string; revision: number },
  keys: Record<string, string>,
  fetcher: UpdateFetch,
  signal?: AbortSignal
): Promise<WindowsUpdateManifest | undefined> {
  if (source === 'cnb') {
    const value = await fetchUpdateJson(WINDOWS_UPDATE_CNB_FEED, fetcher, signal)
    const manifest = verifyWindowsUpdateEnvelope(value, keys)
    return compareWindowsVersions(manifest, current) > 0 ? manifest : undefined
  }
  let newest: { tag: string; version: string; revision: number; hasManifest: boolean } | undefined
  for (let page = 1; ; page++) {
    if (page > 20) throw new Error('Windows release listing exceeded its page limit')
    const releases = await fetchUpdateJson(
      `${WINDOWS_UPDATE_GITHUB_API}?per_page=100&page=${page}`,
      fetcher,
      signal
    )
    if (!Array.isArray(releases)) throw new Error('Invalid Windows release listing')
    for (const value of releases) {
      if (
        !value ||
        typeof value !== 'object' ||
        value.draft !== false ||
        value.prerelease !== false ||
        typeof value.tag_name !== 'string'
      )
        continue
      const release = parseWindowsReleaseTag(value.tag_name)
      if (!release) continue
      if (!newest || compareWindowsVersions(release, newest) > 0) {
        newest = {
          ...release,
          tag: value.tag_name,
          hasManifest:
            Array.isArray(value.assets) &&
            value.assets.some(
              (asset: { name?: unknown }) => asset?.name === WINDOWS_UPDATE_MANIFEST_NAME
            )
        }
      }
    }
    if (releases.length < 100) break
  }
  // Historical releases predate the signed Windows feed. A newer release must
  // always provide valid metadata; never silently fall back to an older build.
  if (!newest || compareWindowsVersions(newest, current) <= 0) return undefined
  if (!newest.hasManifest)
    throw new Error('The newest Windows release has no signed update manifest')
  const value = await fetchUpdateJson(
    windowsUpdateAssetUrl('github', newest.tag, WINDOWS_UPDATE_MANIFEST_NAME),
    fetcher,
    signal
  )
  const manifest = verifyWindowsUpdateEnvelope(value, keys)
  if (manifest.tag !== newest.tag)
    throw new Error('Windows release and update manifest do not match')
  return manifest
}

export async function verifyDownloadedUpdate(
  file: string,
  asset: WindowsUpdateAsset
): Promise<boolean> {
  try {
    const info = await lstat(file)
    if (!info.isFile() || info.isSymbolicLink() || info.size !== asset.size) return false
    const hash = createHash('sha256')
    for await (const chunk of createReadStream(file)) hash.update(chunk)
    return hash.digest('hex') === asset.sha256
  } catch {
    return false
  }
}

export async function downloadUpdateAsset(
  url: string,
  file: string,
  asset: WindowsUpdateAsset,
  fetcher: UpdateFetch,
  onProgress: (percent: number) => void,
  signal?: AbortSignal
): Promise<void> {
  if (await verifyDownloadedUpdate(file, asset)) return
  const partial = `${file}.partial`
  await rm(partial, { force: true })
  const response = await fetcher(url, { signal, credentials: 'omit' })
  if (!response.ok || !response.body || !response.url.startsWith('https://')) {
    await response.body?.cancel().catch(() => {})
    throw new Error(`Windows update download returned HTTP ${response.status}`)
  }
  const contentLength = response.headers.get('content-length')
  if (contentLength !== null && Number(contentLength) !== asset.size) {
    await response.body.cancel()
    throw new Error('Windows update download size does not match')
  }
  const reader = response.body.getReader()
  let output: Awaited<ReturnType<typeof open>> | undefined
  const hash = createHash('sha256')
  let length = 0
  try {
    output = await open(partial, 'wx', 0o600)
    while (true) {
      const next = await reader.read()
      if (next.done) break
      length += next.value.length
      if (length > asset.size) throw new Error('Windows update download exceeds its signed size')
      hash.update(next.value)
      await output.writeFile(next.value)
      onProgress(Math.floor((length / asset.size) * 100))
    }
    if (length !== asset.size || hash.digest('hex') !== asset.sha256)
      throw new Error('Windows update download failed SHA-256 verification')
    await output.sync()
    await output.close()
    await rm(file, { force: true })
    await rename(partial, file)
  } catch (error) {
    await output?.close().catch(() => {})
    await rm(partial, { force: true }).catch(() => {})
    throw error
  } finally {
    await reader.cancel().catch(() => {})
    reader.releaseLock()
  }
}
