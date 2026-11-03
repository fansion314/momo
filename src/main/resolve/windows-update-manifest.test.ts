import { describe, expect, it } from 'vitest'
import {
  compareWindowsVersions,
  parseWindowsReleaseTag,
  windowsUpdateAssetUrl
} from '../../shared/windows-update'
import { verifyWindowsUpdateEnvelope } from './windows-update-manifest'
import { signedUpdateFixture } from './windows-update-test-fixture'

describe('signed Windows update manifests', () => {
  it('verifies the exact raw payload and paired-core identity', () => {
    const { manifest, envelope, keys } = signedUpdateFixture()
    expect(verifyWindowsUpdateEnvelope(envelope, keys)).toEqual(manifest)
  })

  it('rejects tampering, missing signatures, unknown keys and malformed encoding', () => {
    const { envelope, keys } = signedUpdateFixture()
    for (const patch of [
      { keyId: 'unknown' },
      { signature: '' },
      { signature: 'A'.repeat(88) },
      { payload: String(envelope.payload) + '\n' },
      { payload: Buffer.from('{}').toString('base64') },
      { schema: 2 }
    ])
      expect(() => verifyWindowsUpdateEnvelope({ ...envelope, ...patch }, keys)).toThrow()
    expect(() => verifyWindowsUpdateEnvelope({ ...envelope, keyId: '__proto__' }, keys)).toThrow()
  })

  it('rejects signed manifests for the wrong product, release, core or attachment', () => {
    const { manifest, resign, keys } = signedUpdateFixture()
    const bad = [
      { ...manifest, product: 'other' },
      { ...manifest, platform: 'darwin' },
      { ...manifest, tag: 'mihomomo-v2.0.4-5' },
      { ...manifest, revision: 4 },
      { ...manifest, tag: 'clash-momo-v2.0.4-5-beta' },
      { ...manifest, sourceCommit: 'main' },
      { ...manifest, core: { ...manifest.core, tag: 'clash-momo-v2.0.4-5' } },
      {
        ...manifest,
        assets: {
          ...manifest.assets,
          installer: { ...manifest.assets.installer, name: '../other.exe' }
        }
      },
      {
        ...manifest,
        assets: { ...manifest.assets, portable: { ...manifest.assets.portable, size: 0 } }
      },
      {
        ...manifest,
        assets: {
          ...manifest.assets,
          portable: { ...manifest.assets.portable, size: 3 * 1024 ** 3 }
        }
      }
    ]
    for (const value of bad)
      expect(() => verifyWindowsUpdateEnvelope(resign(value), keys)).toThrow()
  })

  it('compares semantic versions before numeric package revisions', () => {
    expect(
      compareWindowsVersions({ version: '2.0.4', revision: 10 }, { version: '2.0.4', revision: 9 })
    ).toBe(1)
    expect(
      compareWindowsVersions({ version: '2.0.5', revision: 1 }, { version: '2.0.4', revision: 20 })
    ).toBe(1)
    expect(
      compareWindowsVersions({ version: '2.0.4', revision: 5 }, { version: '2.0.4', revision: 5 })
    ).toBe(0)
    for (const tag of [
      'clash-momo-v2.0.4-05',
      'clash-momo-v2.0.4-5-beta',
      'mihomomo-v1.19.33-4',
      'clash-momo-v2.00.4-5'
    ])
      expect(parseWindowsReleaseTag(tag)).toBeNull()
  })

  it('maps only fixed source URLs and rejects executable paths', () => {
    expect(
      windowsUpdateAssetUrl('cnb', 'clash-momo-v2.0.4-5', 'clash-momo-windows-x64-update.json')
    ).toBe(
      'https://cnb.cool/fansionia/packages/-/releases/download/windows-clash-momo-v2.0.4-5/clash-momo-windows-x64-update.json'
    )
    expect(() =>
      windowsUpdateAssetUrl('github', 'clash-momo-v2.0.4-5', '../../payload.exe')
    ).toThrow()
  })
})
