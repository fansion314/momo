import { mkdtemp, readFile, rm, writeFile } from 'fs/promises'
import { tmpdir } from 'os'
import path from 'path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
const mocks = vi.hoisted(() => ({ request: vi.fn() }))
vi.mock('./macos-service', () => ({ macServiceRequest: mocks.request }))
vi.mock('../utils/logger', () => ({ managerLogger: { warn: vi.fn() } }))
import { createMacCoreSnapshot } from './macos-snapshot'
import { rememberMacResources, syncMacResources } from './macos-resources'
let root: string
beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'momo-res-'))
  await writeFile(path.join(root, 'config.yaml'), '{}')
  await writeFile(path.join(root, 'Model.bin'), 'old model')
  rememberMacResources(
    await createMacCoreSnapshot(root, path.join(root, 'config.yaml'), '/protected')
  )
  mocks.request.mockReset()
})
afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})
it('returns service-downloaded files to their user-owned source after stopping', async () => {
  mocks.request.mockResolvedValue({
    files: [{ path: 'Model.bin', data: Buffer.from('new model').toString('base64') }]
  })
  await syncMacResources()
  expect(await readFile(path.join(root, 'Model.bin'), 'utf8')).toBe('new model')
})
it('preserves user edits made while the protected core was running', async () => {
  await writeFile(path.join(root, 'Model.bin'), 'user replacement')
  mocks.request.mockResolvedValue({
    files: [{ path: 'Model.bin', data: Buffer.from('downloaded model').toString('base64') }]
  })
  await syncMacResources()
  expect(await readFile(path.join(root, 'Model.bin'), 'utf8')).toBe('user replacement')
})
it('rejects unrequested export destinations', async () => {
  mocks.request.mockResolvedValue({ files: [{ path: '../outside', data: '' }] })
  await expect(syncMacResources()).rejects.toThrow('unrequested')
})
