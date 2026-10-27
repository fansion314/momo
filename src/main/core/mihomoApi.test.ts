import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  running: false,
  config: { showTraffic: false } as IAppConfig,
  getConfig: vi.fn(),
  getControlled: vi.fn(),
  sockets: [] as { url: string; close: ReturnType<typeof vi.fn> }[]
}))

vi.mock('ws', () => ({
  default: class {
    static OPEN = 1
    static CONNECTING = 0
    readyState = 1
    close = vi.fn()
    terminate = vi.fn()
    removeAllListeners = vi.fn()
    constructor(public url: string) {
      mocks.sockets.push(this)
    }
  }
}))
vi.mock('electron', () => ({ app: {} }))
vi.mock('../config', () => ({
  getAppConfig: () => mocks.getConfig(),
  getControledMihomoConfig: () => mocks.getControlled(),
  manageSmartOverride: vi.fn()
}))
vi.mock('../window', () => ({ mainWindow: null }))
vi.mock('../resolve/tray', () => ({ tray: null }))
vi.mock('../resolve/floatingWindow', () => ({ floatingWindow: null }))
vi.mock('../utils/calc', () => ({ calcTraffic: vi.fn() }))
vi.mock('../utils/logger', () => ({
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() })
}))
vi.mock('../utils/dirs', () => ({ mihomoWorkConfigPath: vi.fn() }))
vi.mock('./factory', () => ({ generateProfile: vi.fn(), getRuntimeConfig: vi.fn() }))
vi.mock('./dnsOverrideGuard', () => ({ syncControlDnsAfterApply: vi.fn() }))
vi.mock('./manager', () => ({
  getMihomoIpcPath: () => '/tmp/clash-momo-unit.sock',
  hasCoreProcess: () => mocks.running,
  restartCore: vi.fn()
}))

const originalPlatform = process.platform
afterEach(() => {
  Object.defineProperty(process, 'platform', { value: originalPlatform })
})

beforeEach(() => {
  Object.defineProperty(process, 'platform', { value: 'darwin' })
  vi.resetModules()
  mocks.running = false
  mocks.config = { showTraffic: false } as IAppConfig
  mocks.getConfig.mockReset().mockImplementation(async () => mocks.config)
  mocks.getControlled.mockReset().mockResolvedValue({ 'log-level': 'info' })
  mocks.sockets = []
})
const settle = async (): Promise<void> => {
  for (let i = 0; i < 10; ++i) await Promise.resolve()
}

describe('lightweight UI streams', () => {
  it('closes UI subscriptions while keeping the core and restores each stream once on reopen', async () => {
    const api = await import('./mihomoApi')
    const { lightweightState } = await import('../lightweight')
    expect(mocks.sockets).toHaveLength(0)
    mocks.running = true
    await Promise.all([
      api.startMihomoTraffic(),
      api.startMihomoConnections(),
      api.startMihomoLogs(),
      api.startMihomoMemory()
    ])
    const initial = [...mocks.sockets]
    lightweightState.enterIfCurrent(lightweightState.requestEntry())
    await settle()
    expect(initial).toHaveLength(4)
    expect(initial.every((socket) => socket.close.mock.calls.length === 1)).toBe(true)
    expect(mocks.running).toBe(true)
    lightweightState.leave()
    await settle()
    expect(mocks.sockets).toHaveLength(8)
    expect(
      mocks.sockets
        .slice(4)
        .map((socket) => socket.url)
        .sort()
    ).toEqual([
      'ws://localhost/connections',
      'ws://localhost/logs?level=info',
      'ws://localhost/memory',
      'ws://localhost/traffic'
    ])
    lightweightState.leave()
    await settle()
    expect(mocks.sockets).toHaveLength(8)
  })

  it('does not create a delayed logs socket after lightweight teardown', async () => {
    const api = await import('./mihomoApi')
    const { lightweightState } = await import('../lightweight')
    mocks.running = true
    let finishConfig!: (value: object) => void
    mocks.getControlled.mockReturnValue(
      new Promise<object>((resolve) => {
        finishConfig = resolve
      })
    )
    const start = api.startMihomoLogs()
    lightweightState.enterIfCurrent(lightweightState.requestEntry())
    finishConfig({ 'log-level': 'info' })
    await start
    await settle()
    expect(mocks.sockets).toHaveLength(0)
  })

  it('preserves only the traffic subscription when the tray needs live traffic', async () => {
    const api = await import('./mihomoApi')
    const { lightweightState } = await import('../lightweight')
    mocks.running = true
    mocks.config.showTraffic = true
    await api.startMihomoTraffic()
    lightweightState.enterIfCurrent(lightweightState.requestEntry())
    await settle()
    expect(mocks.sockets).toHaveLength(1)
    expect(mocks.sockets[0].close).not.toHaveBeenCalled()
  })

  it('does not revive traffic from a stale config read after a close and reopen cycle', async () => {
    const api = await import('./mihomoApi')
    const { lightweightState } = await import('../lightweight')
    mocks.running = true
    lightweightState.enterIfCurrent(lightweightState.requestEntry())
    await settle()
    let finishConfig!: (value: IAppConfig) => void
    mocks.getConfig.mockReturnValueOnce(
      new Promise<IAppConfig>((resolve) => {
        finishConfig = resolve
      })
    )
    const staleStart = api.startMihomoTraffic()
    lightweightState.leave()
    await settle()
    lightweightState.enterIfCurrent(lightweightState.requestEntry())
    await settle()
    finishConfig({ showTraffic: true } as IAppConfig)
    await staleStart
    await settle()
    expect(mocks.sockets.filter((socket) => socket.url.endsWith('/traffic'))).toHaveLength(1)
    expect(mocks.sockets.every((socket) => socket.close.mock.calls.length === 1)).toBe(true)
  })

  it('does not keep an unused Linux traffic stream for a migrated showTraffic preference', async () => {
    Object.defineProperty(process, 'platform', { value: 'linux' })
    const api = await import('./mihomoApi')
    const { lightweightState } = await import('../lightweight')
    mocks.running = true
    mocks.config.showTraffic = true
    await api.startMihomoTraffic()
    lightweightState.enterIfCurrent(lightweightState.requestEntry())
    await settle()
    expect(mocks.sockets[0].close).toHaveBeenCalledOnce()
    await api.startMihomoTraffic()
    expect(mocks.sockets).toHaveLength(1)
  })
})
