import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  native: vi.fn(),
  restart: vi.fn(),
  patch: vi.fn(),
  config: { tiziActive: false }
}))
vi.mock('electron', () => ({
  BrowserWindow: { getAllWindows: () => [] },
  powerMonitor: { on: vi.fn() }
}))
vi.mock('../config/app', () => ({
  getAppConfig: async () => ({ ...mocks.config }),
  patchAppConfig: async (patch: Partial<IAppConfig>) => {
    mocks.patch(patch)
    Object.assign(mocks.config, patch)
  }
}))
vi.mock('../utils/dirs', () => ({
  dataDir: () => '/tmp/tizi-activation',
  mihomoWorkDir: () => '/tmp/tizi-activation/work',
  mihomoCorePath: () => '/core'
}))
vi.mock('../core/macos-service', () => ({
  connectMacService: async () => false,
  isMacServiceActive: () => false,
  macServiceRequest: vi.fn(),
  macServiceStatus: vi.fn()
}))
vi.mock('../core/manager', () => ({ restartCore: mocks.restart }))
vi.mock('../resolve/backup', () => ({ initWebdavBackupScheduler: vi.fn() }))
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
  vi.stubGlobal('__TIZI_ENABLED__', true)
  vi.stubGlobal(
    'process',
    new Proxy(process, {
      get: (target, key) => (key === 'platform' ? 'linux' : Reflect.get(target, key))
    })
  )
  mocks.config.tiziActive = false
  mocks.restart.mockReset().mockResolvedValue(undefined)
  mocks.patch.mockReset()
  mocks.native.mockReset().mockResolvedValue({
    supported: true,
    keyReady: true,
    managed_config_version: 2,
    logged_in: true,
    device_id: 'device'
  })
})
afterEach(() => {
  vi.unstubAllGlobals()
  vi.useRealTimers()
})

describe('managed activation concurrency and rollback', () => {
  it('rejects old managed kernels without changing the selected configuration', async () => {
    mocks.native.mockResolvedValue({ supported: true, keyReady: true, logged_in: true })
    const { tiziAction } = await import('./index')
    await expect(tiziAction('activate')).rejects.toThrow('1.19.33-3')
    expect(mocks.config.tiziActive).toBe(false)
    expect(mocks.restart).not.toHaveBeenCalled()
    expect(mocks.patch).not.toHaveBeenCalled()
  })
  it('keeps local status and activation responsive while remote usage is stalled', async () => {
    let finishUsage!: (value: unknown) => void
    mocks.native.mockImplementation(async (_core, _directory, action) =>
      action === 'usage'
        ? new Promise((resolve) => {
            finishUsage = resolve
          })
        : {
            supported: true,
            keyReady: true,
            managed_config_version: 2,
            logged_in: true,
            device_id: 'device'
          }
    )
    const { tiziAction } = await import('./index')
    const usage = tiziAction('usage')
    await expect(tiziAction('status')).resolves.toMatchObject({ active: false, logged_in: true })
    await expect(tiziAction('activate')).resolves.toMatchObject({ active: true })
    expect(mocks.restart).toHaveBeenCalledOnce()
    finishUsage({ days: [] })
    await usage
  })

  it('rolls back activation and restores the previous core when API readiness fails', async () => {
    mocks.restart.mockRejectedValueOnce(new Error('API readiness failed'))
    const { tiziAction } = await import('./index')
    await expect(tiziAction('activate')).rejects.toThrow('API readiness failed')
    expect(mocks.config.tiziActive).toBe(false)
    expect(mocks.patch.mock.calls).toEqual([[{ tiziActive: true }], [{ tiziActive: false }]])
    expect(mocks.restart).toHaveBeenCalledTimes(2)
    await expect(tiziAction('activate')).resolves.toMatchObject({ active: true })
  })

  it('does not place the background remote report in front of activation', async () => {
    vi.useFakeTimers()
    let finishSync!: (value: unknown) => void
    mocks.native.mockImplementation(async (_core, _directory, action) =>
      action === 'sync'
        ? new Promise((resolve) => {
            finishSync = resolve
          })
        : {
            supported: true,
            keyReady: true,
            managed_config_version: 2,
            logged_in: true,
            device_id: 'device'
          }
    )
    const { startTiziReporting, tiziAction } = await import('./index')
    startTiziReporting()
    await vi.advanceTimersByTimeAsync(5000)
    await expect(tiziAction('activate')).resolves.toMatchObject({ active: true })
    finishSync({ last_sync_at: Math.floor(Date.now() / 1000) })
    await vi.advanceTimersByTimeAsync(1)
    vi.clearAllTimers()
  })
})
