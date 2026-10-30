import path from 'node:path'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { defaultSimpleDraft } from '../../shared/simple-config'
import { parse } from '../utils/yaml'

const mocks = vi.hoisted(() => ({
  config: {
    core: 'mihomomo',
    operationMode: 'standard',
    enableTrafficLogger: true,
    trafficHistoryRetentionDays: 30
  } as IAppConfig,
  write: vi.fn(),
  simpleCompile: vi.fn(),
  controlled: {} as Partial<IMihomoConfig>,
  capability: vi.fn()
}))
const workDir = path.join('/tmp', 'clash-momo-history-tests', 'work')
vi.mock('electron', () => ({ BrowserWindow: { getAllWindows: () => [] } }))
vi.mock('fs', async (importOriginal) => ({
  ...(await importOriginal<typeof import('fs')>()),
  existsSync: () => false
}))
vi.mock('fs/promises', async (importOriginal) => ({
  ...(await importOriginal<typeof import('fs/promises')>()),
  mkdir: vi.fn()
}))
vi.mock('../utils/safeFile', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../utils/safeFile')>()),
  atomicWriteFile: (...args: unknown[]) => mocks.write(...args)
}))
vi.mock('../utils/dirs', () => ({
  mihomoWorkDir: () => path.join('/tmp', 'clash-momo-history-tests', 'work'),
  mihomoProfileWorkDir: (id: string) => path.join('/tmp', 'clash-momo-history-tests', 'work', id),
  mihomoWorkConfigPath: (id: string) =>
    path.join('/tmp', 'clash-momo-history-tests', 'work', id, 'config.yaml'),
  simpleConfigPath: () => '/tmp/clash-momo-history-tests/simple.yaml',
  simpleOutputPath: () => '/tmp/clash-momo-history-tests/simple.generated.yaml',
  overridePath: vi.fn(),
  rulePath: () => '/tmp/clash-momo-history-tests/rules.yaml'
}))
vi.mock('../config', () => ({
  getAppConfig: async () => mocks.config,
  getProfileConfig: async () => ({ current: 'profile-one' }),
  getProfileItem: async () => ({ override: [] }),
  getProfile: async () => ({
    'log-level': 'info',
    'proxy-groups': [],
    proxies: [],
    rules: [],
    'traffic-history': { enable: false, path: './subscription-controlled.db', 'retention-days': 1 }
  }),
  getControledMihomoConfig: async () => mocks.controlled,
  getOverrideConfig: async () => ({ items: [] }),
  getOverride: vi.fn(),
  getOverrideItem: vi.fn()
}))
vi.mock('../config/app', () => ({ getAppConfig: async () => mocks.config }))
vi.mock('../utils/logger', () => ({ createLogger: () => ({ info: vi.fn(), error: vi.fn() }) }))
vi.mock('../utils/age', () => ({ decryptAgeContent: vi.fn() }))
vi.mock('../simple/service', () => ({ compileSimpleRuntime: () => mocks.simpleCompile() }))
vi.mock('../tizi', () => ({
  tiziStateDirectory: async () => '/tmp/managed-tizi-state',
  assertManagedTiziCapability: mocks.capability
}))
vi.mock('../simple/subscriptions', () => ({ resolveSimpleDraft: async (draft: unknown) => draft }))
vi.mock('./dnsOverrideGuard', () => ({
  evaluateDnsOverrideGuard: (_id: string, _profile: unknown, controlDns: boolean) => ({
    controlDns,
    autoDisabled: false,
    fingerprint: null,
    request: null
  })
}))

beforeEach(() => {
  mocks.write.mockReset().mockResolvedValue(undefined)
  mocks.controlled = {}
  mocks.capability.mockReset().mockResolvedValue(undefined)
  mocks.config = {
    core: 'mihomomo',
    operationMode: 'standard',
    enableTrafficLogger: true,
    trafficHistoryRetentionDays: 30
  } as IAppConfig
})

const lastWrittenHistory = (): Record<string, unknown> => {
  const calls = mocks.write.mock.calls
  const config = parse<Record<string, unknown>>(calls[calls.length - 1][1])
  return config['traffic-history'] as Record<string, unknown>
}

describe('managed tizi configuration producer', () => {
  it('refuses an old kernel on startup before overwriting the valid configuration', async () => {
    vi.stubGlobal('__TIZI_ENABLED__', true)
    try {
      mocks.config.tiziActive = true
      mocks.capability.mockRejectedValueOnce(new Error('Upgrade mihomomo 1.19.33-3'))
      const { generateProfile } = await import('./factory')
      await expect(generateProfile()).rejects.toThrow('Upgrade')
      expect(mocks.write).not.toHaveBeenCalled()
    } finally {
      vi.unstubAllGlobals()
    }
  })
  it('writes only a native managed reference and ignores the simple/private subscription compiler', async () => {
    vi.stubGlobal('__TIZI_ENABLED__', true)
    try {
      const { generateProfile, getRuntimeConfigStr } = await import('./factory')
      mocks.config.tiziActive = true
      mocks.config.operationMode = 'simple'
      mocks.config.diffWorkDir = true
      mocks.simpleCompile.mockClear()
      const result = await generateProfile()
      expect(result.profileId).toBe('tizi-managed')
      expect(mocks.simpleCompile).not.toHaveBeenCalled()
      const config = parse<Record<string, unknown>>(await getRuntimeConfigStr())
      expect(config['tizi-managed']).toEqual({
        'state-dir': '/tmp/managed-tizi-state',
        smart: { enabled: true, useLightGBM: false, collectData: false, collectorSize: 100 }
      })
      expect(config).not.toHaveProperty('proxies')
      expect(config).not.toHaveProperty('proxy-providers')
      expect(config).not.toHaveProperty('rules')
      expect(config).not.toHaveProperty('external-controller')
      expect(lastWrittenHistory()).toHaveProperty('enable', true)
    } finally {
      vi.unstubAllGlobals()
    }
  })
  it('keeps a working controlled DNS/sniffer with TUN and passes only typed Smart policy to the kernel', async () => {
    vi.stubGlobal('__TIZI_ENABLED__', true)
    try {
      mocks.config = {
        ...mocks.config,
        tiziActive: true,
        controlDns: true,
        controlSniff: true,
        useNameserverPolicy: false,
        enableSmartOverride: true,
        smartCoreUseLightGBM: true,
        smartCoreCollectData: true,
        smartCollectorSize: 512
      }
      mocks.controlled = {
        tun: { enable: true, 'dns-hijack': ['any:53'] },
        dns: {
          enable: true,
          'enhanced-mode': 'fake-ip',
          nameserver: ['https://dns.example/query'],
          'nameserver-policy': { '+.private.example': 'https://other.example/query' }
        },
        hosts: { 'test.example': ['127.0.0.1'] },
        sniffer: { enable: true },
        'external-controller': '0.0.0.0:9090',
        secret: 'configured-local-api-auth',
        proxies: [{ name: 'must-not-export', password: 'must-not-export' }]
      } as unknown as Partial<IMihomoConfig>
      const { generateProfile, getRuntimeConfigStr } = await import('./factory')
      const result = await generateProfile()
      const config = parse<Record<string, unknown>>(await getRuntimeConfigStr())
      expect(config.dns).toEqual({
        enable: true,
        'enhanced-mode': 'fake-ip',
        nameserver: ['https://dns.example/query']
      })
      expect(config.hosts).toEqual({ 'test.example': ['127.0.0.1'] })
      expect(config.sniffer).toEqual({ enable: true })
      expect(config.tun).toMatchObject({ enable: true, 'dns-hijack': ['any:53'] })
      expect(config['tizi-managed']).toEqual({
        'state-dir': '/tmp/managed-tizi-state',
        smart: { enabled: true, useLightGBM: true, collectData: true, collectorSize: 512 }
      })
      expect(result.dnsGuard.controlDns).toBe(true)
      expect(mocks.controlled.dns).toHaveProperty('nameserver-policy')
      expect(config).not.toHaveProperty('proxies')
      expect(config).not.toHaveProperty('external-controller')
      expect(config.secret).toBe('configured-local-api-auth')
    } finally {
      vi.unstubAllGlobals()
    }
  })

  it('does not add controlled DNS/hosts/sniffer when their override flags are disabled', async () => {
    vi.stubGlobal('__TIZI_ENABLED__', true)
    try {
      mocks.config = {
        ...mocks.config,
        tiziActive: true,
        controlDns: false,
        controlSniff: false,
        enableSmartOverride: false
      }
      mocks.controlled = {
        dns: { enable: true },
        hosts: { example: ['127.0.0.1'] },
        sniffer: { enable: true }
      } as unknown as Partial<IMihomoConfig>
      const { generateProfile, getRuntimeConfigStr } = await import('./factory')
      await generateProfile()
      const config = parse<Record<string, unknown>>(await getRuntimeConfigStr())
      expect(config).not.toHaveProperty('dns')
      expect(config).not.toHaveProperty('hosts')
      expect(config).not.toHaveProperty('sniffer')
      expect(config['tizi-managed']).toMatchObject({ smart: { enabled: false } })
    } finally {
      vi.unstubAllGlobals()
    }
  })
})

describe('native history config in actual profile producers', () => {
  it('uses one absolute database across standard profile work directories', async () => {
    const { generateProfile } = await import('./factory')
    mocks.config.diffWorkDir = true
    await generateProfile(undefined, { profileId: 'one' })
    const first = lastWrittenHistory()
    await generateProfile(undefined, { profileId: 'two' })
    expect(lastWrittenHistory()).toEqual(first)
    expect(first).toMatchObject({
      enable: true,
      path: path.join(workDir, 'traffic-history.db'),
      'retention-days': 30
    })
    expect(path.isAbsolute(first.path as string)).toBe(true)
    expect(first.path).not.toContain('profile-one')
  })

  it('overrides subscription history settings and propagates disabling and retention', async () => {
    const { generateProfile } = await import('./factory')
    mocks.config.enableTrafficLogger = false
    mocks.config.trafficHistoryRetentionDays = 90
    await generateProfile()
    expect(lastWrittenHistory()).toMatchObject({
      enable: false,
      path: path.join(workDir, 'traffic-history.db'),
      'retention-days': 90
    })
  })

  it('injects the same application settings after simple-mode compilation', async () => {
    const { compileAndWriteSimple } = await import('../simple/store')
    const draft = defaultSimpleDraft()
    draft.preserved = {
      ...draft.preserved,
      'traffic-history': { enable: false, path: '/tmp/wrong.db' }
    }
    const state = { version: 2 as const, revision: 0, draft, published: structuredClone(draft) }
    const preview = await compileAndWriteSimple(state, true, {})
    expect(preview.errors).toEqual([])
    expect(lastWrittenHistory()).toMatchObject({
      enable: true,
      path: path.join(workDir, 'traffic-history.db'),
      'retention-days': 30
    })
    mocks.config.enableTrafficLogger = false
    mocks.config.trafficHistoryRetentionDays = 45
    await compileAndWriteSimple(state, true, {})
    expect(lastWrittenHistory()).toMatchObject({ enable: false, 'retention-days': 45 })
  })
})
