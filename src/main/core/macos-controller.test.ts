import { mkdtemp, mkdir, readFile, rm, writeFile } from 'fs/promises'
import { tmpdir } from 'os'
import path from 'path'
import http from 'http'
import { once } from 'events'
import { Readable } from 'stream'
import type { IncomingMessage } from 'http'
import AdmZip from 'adm-zip'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
const mocks = vi.hoisted(() => ({
  root: '',
  config: {} as IMihomoConfig,
  get: vi.fn(),
  request: vi.fn(),
  applied: vi.fn(),
  validate: vi.fn(),
  restart: vi.fn()
}))
vi.mock('./factory', () => ({
  getRuntimeConfig: async () => mocks.config,
  setAppliedRuntimeConfig: mocks.applied
}))
vi.mock('../utils/dirs', () => ({ mihomoWorkDir: () => mocks.root }))
vi.mock('../utils/logger', () => ({ managerLogger: { warn: vi.fn() } }))
vi.mock('../utils/chromeRequest', () => ({ get: mocks.get }))
vi.mock('./macos-service', () => ({
  MAC_HELPER_SOCKET: '',
  macServiceHeaders: () => ({}),
  macServiceRequest: mocks.request,
  macServiceStatus: async () => ({ workDir: '/protected', dataMigrated: true }),
  installMacService: vi.fn()
}))
vi.mock('./manager', () => ({ checkProfileConfig: mocks.validate, restartCore: mocks.restart }))
import {
  startMacExternalController,
  stopMacExternalController,
  upgradeMacExternalUI,
  handleMacControllerRequest
} from './macos-controller'

beforeEach(async () => {
  mocks.root = await mkdtemp(path.join(tmpdir(), 'momo-ui-'))
  mocks.config = {
    'external-controller': '127.0.0.1:0',
    'external-ui': 'ui',
    'external-ui-url': 'https://example.com/panel.zip',
    'mixed-port': 7890,
    secret: 'access-token'
  } as IMihomoConfig
  mocks.get.mockReset()
  mocks.request.mockReset().mockResolvedValue({})
  mocks.applied.mockReset()
  mocks.validate.mockReset().mockResolvedValue(undefined)
  mocks.restart.mockReset().mockResolvedValue(undefined)
})
afterEach(async () => {
  await stopMacExternalController()
  await rm(mocks.root, { recursive: true, force: true })
})
function archive(prefix = ''): Buffer {
  const zip = new AdmZip()
  zip.addFile(`${prefix}index.html`, Buffer.from('<h1>New panel</h1>'))
  zip.addFile(`${prefix}assets/main.js`, Buffer.from('console.log(42)'))
  return zip.toBuffer()
}

describe('macOS WebUI lifecycle', () => {
  const request = (method: string, url: string, body = {}): IncomingMessage =>
    Object.assign(Readable.from([JSON.stringify(body)]), { method, url }) as IncomingMessage
  it('validates and stages full config payloads before sending a protected snapshot', async () => {
    const result = await handleMacControllerRequest(
      request('PUT', '/configs?force=true', { payload: 'mode: direct\nproxies: []\n' })
    )
    expect(result?.status).toBe(204)
    expect(mocks.validate).toHaveBeenCalledOnce()
    expect(mocks.request).toHaveBeenCalledWith(
      '/v1/core/config',
      expect.objectContaining({ config: expect.stringContaining('mode: direct') }),
      60000
    )
    expect(mocks.applied).toHaveBeenCalledWith(
      expect.objectContaining({ mode: 'direct', secret: 'access-token' })
    )
  })
  it('leaves runtime configuration intact when validation fails', async () => {
    mocks.validate.mockRejectedValueOnce(new Error('Invalid candidate'))
    await expect(
      handleMacControllerRequest(request('PUT', '/configs', { payload: 'mode: direct' }))
    ).rejects.toThrow('Invalid candidate')
    expect(mocks.request).not.toHaveBeenCalled()
    expect(mocks.applied).not.toHaveBeenCalled()
  })
  it('defers restart until the public response has been delivered', async () => {
    const result = await handleMacControllerRequest(request('POST', '/restart'))
    expect(result?.body).toEqual({ status: 'ok' })
    expect(mocks.restart).not.toHaveBeenCalled()
    await result?.afterResponse?.()
    expect(mocks.restart).toHaveBeenCalledOnce()
  })
  it.each(['', 'dist/', 'metacubexd-gh-pages/'])(
    'installs panel archives with root %s as the ordinary user',
    async (prefix) => {
      mocks.get.mockResolvedValue({ status: 200, data: archive(prefix) })
      await mkdir(path.join(mocks.root, 'ui'))
      await writeFile(path.join(mocks.root, 'ui', 'old.js'), 'old')
      await upgradeMacExternalUI()
      expect(await readFile(path.join(mocks.root, 'ui', 'index.html'), 'utf8')).toContain(
        'New panel'
      )
      expect(await readFile(path.join(mocks.root, 'ui', 'assets', 'main.js'), 'utf8')).toContain(
        '42'
      )
      await expect(readFile(path.join(mocks.root, 'ui', 'old.js'))).rejects.toMatchObject({
        code: 'ENOENT'
      })
      expect(mocks.get).toHaveBeenCalledWith(
        mocks.config['external-ui-url'],
        expect.objectContaining({ proxy: { protocol: 'http', host: '127.0.0.1', port: 7890 } })
      )
    }
  )

  it('keeps an existing panel after an invalid download and permits retry', async () => {
    await mkdir(path.join(mocks.root, 'ui'))
    await writeFile(path.join(mocks.root, 'ui', 'index.html'), 'existing panel')
    mocks.get.mockResolvedValueOnce({ status: 503, data: Buffer.from('unavailable') })
    await expect(upgradeMacExternalUI()).rejects.toThrow('HTTP 503')
    expect(await readFile(path.join(mocks.root, 'ui', 'index.html'), 'utf8')).toBe('existing panel')
    mocks.get.mockResolvedValueOnce({ status: 200, data: archive() })
    await upgradeMacExternalUI()
    expect(await readFile(path.join(mocks.root, 'ui', 'index.html'), 'utf8')).toContain('New panel')
  })

  it('shares concurrent updates and does not download a disabled panel', async () => {
    mocks.get.mockResolvedValue({ status: 200, data: archive() })
    await Promise.all([upgradeMacExternalUI(), upgradeMacExternalUI()])
    expect(mocks.get).toHaveBeenCalledOnce()
    mocks.config['external-ui'] = ''
    await startMacExternalController()
    expect(mocks.get).toHaveBeenCalledOnce()
  })

  it('applies changed credentials on restart and closes a disabled listener', async () => {
    const probe = http.createServer()
    probe.listen(0, '127.0.0.1')
    await once(probe, 'listening')
    const port = (probe.address() as import('net').AddressInfo).port
    await new Promise<void>((resolve) => probe.close(() => resolve()))
    mocks.config['external-controller'] = `127.0.0.1:${port}`
    mocks.config['external-ui'] = ''
    const url = `http://127.0.0.1:${port}/version`
    await startMacExternalController()
    expect((await fetch(url)).status).toBe(401)
    mocks.config.secret = 'changed-token'
    await startMacExternalController()
    expect((await fetch(url, { headers: { Authorization: 'Bearer access-token' } })).status).toBe(
      401
    )
    mocks.config['external-controller'] = ''
    await startMacExternalController()
    await expect(fetch(url)).rejects.toThrow()
  })
})
