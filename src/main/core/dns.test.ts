import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  connect: vi.fn(),
  active: vi.fn(),
  request: vi.fn()
}))
vi.mock('./macos-service', () => ({
  connectMacService: mocks.connect,
  isMacServiceActive: mocks.active,
  macServiceRequest: mocks.request
}))

describe('macOS DNS protection', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.stubGlobal(
      'process',
      new Proxy(process, {
        get: (target, key) => (key === 'platform' ? 'darwin' : Reflect.get(target, key))
      })
    )
    mocks.connect.mockResolvedValue(true)
    mocks.active.mockReturnValue(true)
    mocks.request.mockResolvedValue(undefined)
  })
  afterEach(() => vi.unstubAllGlobals())

  it('sends DNS protection through the authenticated network service', async () => {
    const { setPublicDNS } = await import('./dns')
    await setPublicDNS()
    expect(mocks.request).toHaveBeenCalledWith('/v1/network/dns', {
      enabled: true,
      servers: ['223.5.5.5']
    })
  })
  it('requires the network service before changing DNS', async () => {
    mocks.connect.mockResolvedValue(false)
    const { setPublicDNS } = await import('./dns')
    await expect(setPublicDNS()).rejects.toThrow('Install the macOS service')
    expect(mocks.request).not.toHaveBeenCalled()
  })
  it('restores DNS through the service with the requested shutdown timeout', async () => {
    const { recoverDNS } = await import('./dns')
    await recoverDNS({ timeout: 3000 })
    expect(mocks.request).toHaveBeenCalledWith('/v1/network/dns', { enabled: false }, 3000)
  })
})
