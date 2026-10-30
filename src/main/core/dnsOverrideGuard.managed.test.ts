import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
const mocks = vi.hoisted(() => ({
  current: 'tizi-managed',
  getProfile: vi.fn(),
  sync: vi.fn(),
  reload: vi.fn()
}))
vi.mock('../config', () => ({
  getAppConfig: async () => ({ controlDns: false }),
  getProfileConfig: async () => ({ current: mocks.current }),
  getProfile: mocks.getProfile,
  syncAppConfigAfterApply: mocks.sync
}))
vi.mock('../window', () => ({ mainWindow: { webContents: { send: vi.fn() } } }))
vi.mock('../utils/logger', () => ({ createLogger: () => ({ info: vi.fn(), error: vi.fn() }) }))
vi.mock('./mihomoApi', () => ({
  mihomoHotReloadConfig: async () => {
    mocks.reload()
    const guard = await import('./dnsOverrideGuard')
    await guard.syncControlDnsAfterApply(
      guard.evaluateDnsOverrideGuard('tizi-managed', {}, false, true)
    )
  }
}))
beforeEach(() => {
  vi.resetModules()
  mocks.current = 'tizi-managed'
  mocks.getProfile.mockReset().mockRejectedValue(new Error('protected raw config'))
  mocks.sync.mockReset()
  mocks.reload.mockReset()
})
afterEach(() => vi.restoreAllMocks())
describe('explicit DNS override for sealed managed profiles', () => {
  it('applies enable/disable requests without reading protected node configuration', async () => {
    const { setControlDns } = await import('./dnsOverrideGuard')
    await expect(setControlDns(true)).resolves.toEqual({ status: 'applied' })
    expect(mocks.sync).toHaveBeenLastCalledWith({ controlDns: true })
    await expect(setControlDns(false)).resolves.toEqual({ status: 'applied' })
    expect(mocks.sync).toHaveBeenLastCalledWith({ controlDns: false })
    expect(mocks.getProfile).not.toHaveBeenCalled()
  })
  it('retains source-DNS confirmation for ordinary private profiles', async () => {
    mocks.current = 'private'
    mocks.getProfile.mockResolvedValue({
      dns: { 'proxy-server-nameserver': ['https://private.example/query'] }
    })
    const { setControlDns } = await import('./dnsOverrideGuard')
    await expect(setControlDns(true)).resolves.toMatchObject({ status: 'confirm-required' })
    expect(mocks.getProfile).toHaveBeenCalledWith('private')
    expect(mocks.reload).not.toHaveBeenCalled()
  })
})
