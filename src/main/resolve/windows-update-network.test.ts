import { createHash } from 'node:crypto'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { WINDOWS_UPDATE_MANIFEST_NAME } from '../../shared/windows-update'
import { signedUpdateFixture } from './windows-update-test-fixture'
import {
  downloadUpdateAsset,
  fetchUpdateJson,
  findWindowsUpdate,
  verifyDownloadedUpdate
} from './windows-update-network'

const dirs: string[] = []
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
})

function response(value: unknown, url = 'https://example.test/update'): Response {
  const result = new Response(JSON.stringify(value))
  Object.defineProperty(result, 'url', { value: url })
  return result
}

describe('Windows release discovery and downloads', () => {
  it('paginates, ignores kernel/prerelease tags and chooses the highest client revision', async () => {
    const fixture = signedUpdateFixture(10)
    const release = (tag: string, prerelease = false) => ({
      tag_name: tag,
      draft: false,
      prerelease,
      assets: [{ name: WINDOWS_UPDATE_MANIFEST_NAME }]
    })
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce(
        response(Array.from({ length: 100 }, () => release('mihomomo-v1.19.33-99')))
      )
      .mockResolvedValueOnce(
        response([
          release('clash-momo-v2.0.4-9'),
          release('clash-momo-v2.0.4-10'),
          release('clash-momo-v3.0.0-1', true)
        ])
      )
      .mockResolvedValueOnce(response(fixture.envelope))
    expect(
      await findWindowsUpdate('github', { version: '2.0.4', revision: 4 }, fixture.keys, fetcher)
    ).toEqual(fixture.manifest)
    expect(fetcher.mock.calls[1][0]).toContain('page=2')
    expect(fetcher.mock.calls[2][0]).toContain('/clash-momo-v2.0.4-10/')
  })

  it('accepts historical releases with no manifest only when they are not newer', async () => {
    const fetcher = vi
      .fn()
      .mockImplementation(async () =>
        response([{ tag_name: 'clash-momo-v2.0.4-4', draft: false, prerelease: false, assets: [] }])
      )
    expect(
      await findWindowsUpdate('github', { version: '2.0.4', revision: 5 }, {}, fetcher)
    ).toBeUndefined()
    await expect(
      findWindowsUpdate('github', { version: '2.0.4', revision: 3 }, {}, fetcher)
    ).rejects.toThrow('no signed update manifest')
  })

  it('never falls back after a corrupt newest manifest and detects release mismatches', async () => {
    const fixture = signedUpdateFixture()
    const listing = [
      {
        tag_name: 'clash-momo-v2.0.4-6',
        draft: false,
        prerelease: false,
        assets: [{ name: WINDOWS_UPDATE_MANIFEST_NAME }]
      }
    ]
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce(response(listing))
      .mockResolvedValueOnce(response(fixture.envelope))
    await expect(
      findWindowsUpdate('github', { version: '2.0.4', revision: 4 }, fixture.keys, fetcher)
    ).rejects.toThrow('do not match')
    expect(fetcher).toHaveBeenCalledTimes(2)
  })

  it('verifies CNB metadata and rejects oversized metadata or insecure redirects', async () => {
    const fixture = signedUpdateFixture()
    expect(
      await findWindowsUpdate('cnb', { version: '2.0.4', revision: 4 }, fixture.keys, async () =>
        response(fixture.envelope)
      )
    ).toEqual(fixture.manifest)
    await expect(
      fetchUpdateJson('https://example.test', async () => response('x'.repeat(2 * 1024 ** 2)))
    ).rejects.toThrow('too large')
    await expect(
      fetchUpdateJson('https://example.test', async () => response({}, 'http://example.test'))
    ).rejects.toThrow()
  })

  it('accepts Electron fetch responses with an empty URL while retaining HTTPS input checks', async () => {
    const fixture = signedUpdateFixture()
    const electronResponse = async () => new Response(JSON.stringify(fixture.envelope))
    expect(await fetchUpdateJson('https://cnb.cool/update', electronResponse)).toEqual(
      fixture.envelope
    )
    await expect(fetchUpdateJson('http://insecure.test/update', electronResponse)).rejects.toThrow()
    const dir = await mkdtemp(path.join(tmpdir(), 'windows-update-electron-'))
    dirs.push(dir)
    const bytes = Buffer.from('electron native fetch body')
    const file = path.join(dir, 'setup.exe')
    await downloadUpdateAsset(
      'https://cnb.cool/setup.exe',
      file,
      {
        name: 'setup.exe',
        size: bytes.length,
        sha256: createHash('sha256').update(bytes).digest('hex')
      },
      async () => new Response(bytes),
      () => {}
    )
    expect(await readFile(file)).toEqual(bytes)
  })

  it('streams and hashes the download, rechecks cache and removes corrupt partial files', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'windows-update-test-'))
    dirs.push(dir)
    const file = path.join(dir, 'setup.exe')
    const data = Buffer.from('verified bundled client')
    const asset = {
      name: 'setup.exe',
      size: data.length,
      sha256: createHash('sha256').update(data).digest('hex')
    }
    const fetcher = vi.fn(async () => {
      const result = new Response(data)
      Object.defineProperty(result, 'url', { value: 'https://example.test/setup.exe' })
      return result
    })
    await downloadUpdateAsset('https://example.test/setup.exe', file, asset, fetcher, () => {})
    expect(await readFile(file)).toEqual(data)
    await downloadUpdateAsset('https://example.test/setup.exe', file, asset, fetcher, () => {})
    expect(fetcher).toHaveBeenCalledTimes(1)
    await writeFile(file, Buffer.alloc(data.length))
    expect(await verifyDownloadedUpdate(file, asset)).toBe(false)
    await downloadUpdateAsset('https://example.test/setup.exe', file, asset, fetcher, () => {})
    expect(fetcher).toHaveBeenCalledTimes(2)
    await rm(file)
    await expect(
      downloadUpdateAsset(
        'https://example.test/setup.exe',
        file,
        { ...asset, sha256: '0'.repeat(64) },
        fetcher,
        () => {}
      )
    ).rejects.toThrow('SHA-256')
    await expect(readFile(file + '.partial')).rejects.toThrow()
    await expect(readFile(file)).rejects.toThrow()
  })

  it('cancels the response when the output file cannot be opened', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'windows-update-open-failure-'))
    dirs.push(dir)
    const result = new Response('body')
    Object.defineProperty(result, 'url', { value: 'https://example.test/setup.exe' })
    const cancel = vi.fn()
    const reader = { read: vi.fn(), cancel, releaseLock: vi.fn() }
    const body = result.body
    if (!body) throw new Error('Missing test response body')
    vi.spyOn(body, 'getReader').mockReturnValue(
      reader as unknown as ReadableStreamDefaultReader<Uint8Array<ArrayBuffer>>
    )
    await expect(
      downloadUpdateAsset(
        'https://example.test/setup.exe',
        path.join(dir, 'absent', 'setup.exe'),
        { name: 'setup.exe', size: 4, sha256: 'a'.repeat(64) },
        async () => result,
        () => {}
      )
    ).rejects.toThrow()
    expect(cancel).toHaveBeenCalledTimes(1)
  })
})
