import { generateKeyPairSync, sign } from 'node:crypto'
import type { WindowsUpdateManifest } from '../../shared/windows-update'

export function signedUpdateFixture(revision = 5): {
  manifest: WindowsUpdateManifest
  envelope: Record<string, unknown>
  keys: Record<string, string>
  resign: (value: unknown) => Record<string, unknown>
} {
  const pair = generateKeyPairSync('ed25519')
  const keys = { test: pair.publicKey.export({ format: 'der', type: 'spki' }).toString('base64') }
  const manifest: WindowsUpdateManifest = {
    schema: 1,
    product: 'clash-momo',
    platform: 'win32',
    arch: 'x64',
    tag: `clash-momo-v2.0.4-${revision}`,
    version: '2.0.4',
    revision,
    publishedAt: '2026-11-03T00:00:00Z',
    changelog: 'Windows updates',
    sourceCommit: '1'.repeat(40),
    core: { tag: 'mihomomo-v1.19.33-4', sha256: '2'.repeat(64), sourceCommit: '3'.repeat(40) },
    assets: {
      installer: {
        name: `clash-momo-2.0.4-${revision}-windows-x64-setup.exe`,
        size: 123,
        sha256: '4'.repeat(64)
      },
      portable: {
        name: `clash-momo-2.0.4-${revision}-windows-x64-portable.zip`,
        size: 234,
        sha256: '5'.repeat(64)
      }
    }
  }
  const resign = (value: unknown): Record<string, unknown> => {
    const payload = Buffer.from(JSON.stringify(value))
    return {
      schema: 1,
      keyId: 'test',
      payload: payload.toString('base64'),
      signature: sign(null, payload, pair.privateKey).toString('base64')
    }
  }
  return { manifest, keys, envelope: resign(manifest), resign }
}
