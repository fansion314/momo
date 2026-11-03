import { createPublicKey, verify } from 'node:crypto'
import {
  parseWindowsReleaseTag,
  type WindowsUpdateEnvelope,
  type WindowsUpdateManifest
} from '../../shared/windows-update'

const MAX_PAYLOAD_SIZE = 128 * 1024
const MAX_ASSET_SIZE = 2 * 1024 * 1024 * 1024
const SHA256 = /^[a-f0-9]{64}$/
const COMMIT = /^[a-f0-9]{40}$/

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function decodeBase64(value: unknown, limit: number): Buffer {
  if (typeof value !== 'string' || value.length > Math.ceil(limit / 3) * 4)
    throw new Error('Invalid Windows update encoding')
  const decoded = Buffer.from(value, 'base64')
  if (decoded.length > limit || decoded.toString('base64') !== value)
    throw new Error('Invalid Windows update encoding')
  return decoded
}

export function validateWindowsUpdateManifest(value: unknown): WindowsUpdateManifest {
  if (!record(value)) throw new Error('Invalid Windows update manifest')
  const release = typeof value.tag === 'string' ? parseWindowsReleaseTag(value.tag) : null
  if (
    value.schema !== 1 ||
    value.product !== 'clash-momo' ||
    value.platform !== 'win32' ||
    value.arch !== 'x64' ||
    !release ||
    value.version !== release.version ||
    value.revision !== release.revision ||
    typeof value.publishedAt !== 'string' ||
    !/^\d{4}-\d{2}-\d{2}T/.test(value.publishedAt) ||
    !Number.isFinite(Date.parse(value.publishedAt)) ||
    typeof value.changelog !== 'string' ||
    value.changelog.length > 64 * 1024 ||
    typeof value.sourceCommit !== 'string' ||
    !COMMIT.test(value.sourceCommit) ||
    !record(value.core) ||
    typeof value.core.tag !== 'string' ||
    !/^mihomomo-v\d+\.\d+\.\d+-[1-9]\d*$/.test(value.core.tag) ||
    typeof value.core.sha256 !== 'string' ||
    !SHA256.test(value.core.sha256) ||
    typeof value.core.sourceCommit !== 'string' ||
    !COMMIT.test(value.core.sourceCommit) ||
    !record(value.assets)
  )
    throw new Error('Invalid Windows update manifest')
  for (const [kind, suffix] of [
    ['installer', 'setup.exe'],
    ['portable', 'portable.zip']
  ] as const) {
    const asset = value.assets[kind]
    if (
      !record(asset) ||
      asset.name !== `clash-momo-${release.version}-${release.revision}-windows-x64-${suffix}` ||
      typeof asset.size !== 'number' ||
      !Number.isSafeInteger(asset.size) ||
      asset.size <= 0 ||
      asset.size > MAX_ASSET_SIZE ||
      typeof asset.sha256 !== 'string' ||
      !SHA256.test(asset.sha256)
    )
      throw new Error('Invalid Windows update asset')
  }
  return value as unknown as WindowsUpdateManifest
}

export function verifyWindowsUpdateEnvelope(
  value: unknown,
  keys: Record<string, string>
): WindowsUpdateManifest {
  if (
    !record(value) ||
    value.schema !== 1 ||
    typeof value.keyId !== 'string' ||
    !Object.prototype.hasOwnProperty.call(keys, value.keyId)
  )
    throw new Error('Unknown Windows update signing key')
  const envelope = value as unknown as WindowsUpdateEnvelope
  const payload = decodeBase64(envelope.payload, MAX_PAYLOAD_SIZE)
  const signature = decodeBase64(envelope.signature, 64)
  if (signature.length !== 64) throw new Error('Invalid Windows update signature')
  const key = createPublicKey({
    key: Buffer.from(keys[envelope.keyId], 'base64'),
    format: 'der',
    type: 'spki'
  })
  if (key.asymmetricKeyType !== 'ed25519' || !verify(null, payload, key, signature))
    throw new Error('Invalid Windows update signature')
  return validateWindowsUpdateManifest(JSON.parse(payload.toString('utf8')))
}
