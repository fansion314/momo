import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  config: {} as IAppConfig,
  serviceActive: true,
  execFile: vi.fn(),
  request: vi.fn(),
  snapshot: vi.fn(),
  cleanup: vi.fn(),
  prepareFiles: vi.fn(),
  generate: vi.fn()
}))
vi.mock('child_process', () => ({ execFile: mocks.execFile, spawn: vi.fn() }))
vi.mock('electron', () => ({ dialog: {}, ipcMain: {} }))
vi.mock('fs', () => ({ existsSync: () => false, watch: vi.fn() }))
vi.mock('../window', () => ({ mainWindow: null, enterLightweightMode: vi.fn() }))
vi.mock('../config', () => ({
  getAppConfig: async () => mocks.config,
  getControledMihomoConfig: async () => ({ tun: { enable: true }, 'log-level': 'info' }),
  getProfileItem: async () => ({ type: 'managed' }),
  manageSmartOverride: vi.fn(),
  patchControledMihomoConfig: vi.fn()
}))
vi.mock('../utils/dirs', () => ({
  dataDir: () => '/tmp/client',
  mihomoCorePath: () => '/formula/mihomomo',
  mihomoWorkDir: () => '/tmp/client/work',
  mihomoTestDir: () => '/tmp/client/test',
  mihomoWorkConfigPath: () => '/tmp/client/work/config.yaml',
  mihomoProfileWorkDir: () => '/tmp/client/work/private'
}))
vi.mock('../resolve/gistApi', () => ({ uploadRuntimeConfigIfChanged: vi.fn() }))
vi.mock('../utils/init', () => ({ ensureRuntimeFiles: mocks.prepareFiles }))
vi.mock('../utils/age', () => ({ parseAgeSecretKeys: () => [] }))
vi.mock('../../shared/i18n', () => ({ default: { t: (key: string) => key } }))
vi.mock('../utils/logger', () => ({
  managerLogger: { info: vi.fn(), error: vi.fn(), warn: vi.fn() }
}))
vi.mock('../utils/logFile', () => ({}))
vi.mock('./mihomoApi', () => ({}))
vi.mock('./factory', () => ({ generateProfile: mocks.generate, getRuntimeConfig: vi.fn() }))
vi.mock('./dnsOverrideGuard', () => ({}))
vi.mock('./smartModel', () => ({ syncSmartModelToTestDir: vi.fn() }))
vi.mock('./permissions', () => ({
  setStopCoreBeforeAdminRestart: vi.fn(),
  getSessionAdminStatus: () => false
}))
vi.mock('./process', () => ({ cleanupSocketFile: mocks.cleanup, verifyProcessOwner: vi.fn() }))
vi.mock('./dns', () => ({ setPublicDNS: vi.fn(), recoverDNS: vi.fn() }))
vi.mock('./macos-service', () => ({
  validateMacCore: vi.fn(),
  connectMacService: vi.fn(),
  isMacServiceActive: () => mocks.serviceActive,
  macServiceStatus: async () => ({
    workDir: '/Library/Application Support/world.fansionia.clash-momo/data'
  }),
  macServiceRequest: mocks.request,
  setMacServiceTransition: vi.fn(),
  expectMacServiceCore: vi.fn()
}))
vi.mock('./macos-snapshot', () => ({ createMacCoreSnapshot: mocks.snapshot }))

beforeEach(() => {
  vi.resetModules()
  vi.stubGlobal('__TIZI_ENABLED__', true)
  vi.stubGlobal(
    'process',
    new Proxy(process, {
      get: (target, key) => (key === 'platform' ? 'darwin' : Reflect.get(target, key))
    })
  )
  mocks.config = {
    core: 'mihomomo',
    operationMode: 'standard',
    tiziActive: true,
    testProfileOnStart: true,
    autoSetDNS: false
  } as IAppConfig
  mocks.serviceActive = true
  mocks.execFile
    .mockReset()
    .mockImplementation((_file, _args, _options, callback) => callback(null, '', ''))
  mocks.cleanup.mockReset().mockResolvedValue(undefined)
  mocks.prepareFiles.mockReset().mockResolvedValue(undefined)
  mocks.generate.mockReset().mockResolvedValue({ profileId: 'tizi-managed', dnsGuard: {} })
  mocks.snapshot
    .mockReset()
    .mockResolvedValue({ config: 'tizi-managed:\n  state-dir: /root-owned/tizi\n', files: [] })
  mocks.request.mockReset()
})
afterEach(() => vi.unstubAllGlobals())

describe('actual manager validation route for helper-owned managed state', () => {
  it('does not run the ordinary-user CLI against root-only state when the macOS helper owns the managed profile', async () => {
    const { prepareCore } = await import('./manager')
    const result = await prepareCore(false)
    expect(mocks.generate).toHaveBeenCalledOnce()
    expect(result).toMatchObject({
      workDir: '/tmp/client/work',
      startupMode: 'api',
      tunEnabled: true
    })
    expect(mocks.execFile).not.toHaveBeenCalled()
    expect(mocks.config.testProfileOnStart).toBe(true)
  })

  it.each([
    { platform: 'darwin', service: true, managed: false },
    { platform: 'darwin', service: false, managed: true },
    { platform: 'linux', service: true, managed: true }
  ])(
    'retains local validation for $platform service=$service managed=$managed',
    async ({ platform, service, managed }) => {
      vi.stubGlobal(
        'process',
        new Proxy(process, {
          get: (target, key) => (key === 'platform' ? platform : Reflect.get(target, key))
        })
      )
      mocks.serviceActive = service
      mocks.config.tiziActive = managed
      const { prepareCore } = await import('./manager')
      await prepareCore(false)
      expect(mocks.execFile).toHaveBeenCalledOnce()
      expect(mocks.execFile.mock.calls[0][1]).toEqual([
        '-t',
        '-f',
        '/tmp/client/work/config.yaml',
        '-d',
        '/tmp/client/test'
      ])
    }
  )

  it('still submits the actual snapshot for mandatory helper validation and propagates a rejection', async () => {
    mocks.request.mockRejectedValue(new Error('managed core rejected configuration snapshot'))
    const { startCore } = await import('./manager')
    await expect(startCore()).rejects.toThrow('managed core rejected configuration snapshot')
    expect(mocks.execFile).not.toHaveBeenCalled()
    expect(mocks.snapshot).toHaveBeenCalledWith(
      '/tmp/client/work',
      '/tmp/client/work/config.yaml',
      '/Library/Application Support/world.fansionia.clash-momo/data',
      '',
      undefined
    )
    expect(mocks.request).toHaveBeenCalledWith(
      '/v1/core/start',
      { config: 'tizi-managed:\n  state-dir: /root-owned/tizi\n', files: [] },
      60000
    )
  })
})
