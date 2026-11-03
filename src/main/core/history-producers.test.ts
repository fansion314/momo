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
  simpleCompile: vi.fn()
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
  getControledMihomoConfig: async () => ({}),
  getOverrideConfig: async () => ({ items: [] }),
  getOverride: vi.fn(),
  getOverrideItem: vi.fn()
}))
vi.mock('../config/app', () => ({ getAppConfig: async () => mocks.config }))
vi.mock('../utils/logger', () => ({ createLogger: () => ({ info: vi.fn(), error: vi.fn() }) }))
vi.mock('../utils/age', () => ({ decryptAgeContent: vi.fn() }))
vi.mock('../simple/service', () => ({ compileSimpleRuntime: () => mocks.simpleCompile() }))
vi.mock('../simple/subscriptions', () => ({ resolveSimpleDraft: async (draft: unknown) => draft }))
vi.mock('./dnsOverrideGuard', () => ({
  evaluateDnsOverrideGuard: () => ({
    controlDns: false,
    autoDisabled: false,
    fingerprint: null,
    request: null
  })
}))

beforeEach(() => {
  mocks.write.mockReset().mockResolvedValue(undefined)
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
