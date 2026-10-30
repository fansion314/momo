import { afterEach, beforeEach, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({ native: vi.fn(), resume: vi.fn() }))
vi.mock('electron', () => ({
  BrowserWindow: { getAllWindows: () => [] },
  powerMonitor: { on: mocks.resume }
}))
vi.mock('../config/app', () => ({
  getAppConfig: async () => ({ tiziActive: false }),
  patchAppConfig: vi.fn()
}))
vi.mock('../utils/dirs', () => ({
  dataDir: () => '/tmp/momo-reporting-test',
  mihomoWorkDir: () => '/tmp/momo-reporting-test/work',
  mihomoCorePath: () => '/usr/bin/mihomomo'
}))
vi.mock('../core/macos-service', () => ({
  connectMacService: async () => false,
  isMacServiceActive: () => false,
  macServiceRequest: vi.fn(),
  macServiceStatus: vi.fn()
}))
vi.mock('./backend-binding', () => ({
  checkBackendBinding: vi.fn(),
  rememberBackendBinding: vi.fn()
}))
vi.mock('./native', () => ({
  validateTiziRequest: (action: string, payload: unknown) => ({ action, payload }),
  invokeTiziNative: mocks.native
}))
vi.mock('fs/promises', () => ({ mkdir: vi.fn() }))

beforeEach(() => {
  vi.resetModules()
  vi.useFakeTimers()
  vi.stubGlobal('__TIZI_ENABLED__', true)
  vi.setSystemTime(new Date('2026-10-30T22:59:30Z'))
  mocks.native.mockReset().mockImplementation(async (_executable, _directory, action) => ({
    supported: true,
    keyReady: true,
    device_id: 'bound-device',
    logged_in: true,
    last_sync_at: action === 'sync' ? Math.floor(Date.now() / 1000) : 0
  }))
})
afterEach(() => {
  vi.clearAllTimers()
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

it('reports an inactive managed ledger at startup and again after the Shanghai 07:00 boundary', async () => {
  const { startTiziReporting } = await import('./index')
  startTiziReporting()
  startTiziReporting()
  await vi.advanceTimersByTimeAsync(5000)
  expect(mocks.native.mock.calls.map((call) => call[2])).toEqual(['status', 'sync'])
  await vi.advanceTimersByTimeAsync(55000)
  expect(mocks.native.mock.calls.map((call) => call[2])).toEqual([
    'status',
    'sync',
    'status',
    'sync'
  ])
  await vi.advanceTimersByTimeAsync(60000)
  expect(mocks.native).toHaveBeenCalledTimes(4)
  expect(mocks.resume).toHaveBeenCalledWith('resume', expect.any(Function))
})

it('does not register reporting timers when the build feature is disabled', async () => {
  vi.stubGlobal('__TIZI_ENABLED__', false)
  const { startTiziReporting } = await import('./index')
  startTiziReporting()
  await vi.advanceTimersByTimeAsync(120000)
  expect(mocks.native).not.toHaveBeenCalled()
})
