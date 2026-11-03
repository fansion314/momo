export type WindowsUpdateSource = 'cnb' | 'github'

export interface WindowsUpdateAsset {
  name: string
  size: number
  sha256: string
}

export interface WindowsUpdateManifest {
  schema: 1
  product: 'clash-momo'
  platform: 'win32'
  arch: 'x64'
  tag: string
  version: string
  revision: number
  publishedAt: string
  changelog: string
  sourceCommit: string
  core: { tag: string; sha256: string; sourceCommit: string }
  assets: { installer: WindowsUpdateAsset; portable: WindowsUpdateAsset }
}

export interface WindowsUpdateEnvelope {
  schema: 1
  keyId: string
  payload: string
  signature: string
}

export type WindowsUpdatePhase =
  'idle' | 'checking' | 'available' | 'downloading' | 'downloaded' | 'installing' | 'error'

export interface WindowsUpdateState {
  supported: boolean
  portable: boolean
  source: WindowsUpdateSource
  currentVersion: string
  currentRevision: number
  phase: WindowsUpdatePhase
  update?: WindowsUpdateManifest
  progress?: number
  checkedAt?: string
  error?: string
}

export const WINDOWS_UPDATE_MANIFEST_NAME = 'clash-momo-windows-x64-update.json'
export const WINDOWS_UPDATE_CNB_FEED =
  'https://cnb.cool/fansionia/packages/-/git/raw/windows-updates/clash-momo/windows-x64/latest.json'
export const WINDOWS_UPDATE_GITHUB_API = 'https://api.github.com/repos/fansion314/momo/releases'
export const WINDOWS_UPDATE_CHECK_INTERVAL = 24 * 60 * 60 * 1000

export function windowsUpdateSource(value: unknown): WindowsUpdateSource {
  return value === 'github' ? 'github' : 'cnb'
}

export function parseWindowsReleaseTag(tag: string): { version: string; revision: number } | null {
  const match = /^clash-momo-v((?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*))-([1-9]\d*)$/.exec(
    tag
  )
  if (!match) return null
  const revision = Number(match[2])
  if (
    !Number.isSafeInteger(revision) ||
    !match[1].split('.').every((v) => Number.isSafeInteger(Number(v)))
  )
    return null
  return { version: match[1], revision }
}

export function compareWindowsVersions(
  left: { version: string; revision: number },
  right: { version: string; revision: number }
): number {
  const a = [...left.version.split('.').map(Number), left.revision]
  const b = [...right.version.split('.').map(Number), right.revision]
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return a[i] > b[i] ? 1 : -1
  }
  return 0
}

export function windowsUpdateAssetUrl(
  source: WindowsUpdateSource,
  tag: string,
  name: string
): string {
  if (!parseWindowsReleaseTag(tag) || !/^clash-momo-[\w.-]+$/.test(name))
    throw new Error('Invalid Windows update asset')
  const base =
    source === 'cnb'
      ? `https://cnb.cool/fansionia/packages/-/releases/download/windows-${tag}`
      : `https://github.com/fansion314/momo/releases/download/${tag}`
  return `${base}/${encodeURIComponent(name)}`
}
