import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({ execFile: vi.fn(), syncModel: vi.fn() }))
vi.mock('child_process', () => ({ execFile: mocks.execFile, spawn: vi.fn() }))
vi.mock('electron', () => ({ dialog: {}, ipcMain: {} }))
vi.mock('../window', () => ({ mainWindow: null, enterLightweightMode: vi.fn() }))
vi.mock('../config', () => ({}))
vi.mock('../utils/dirs', () => ({
  mihomoCorePath: () => '/usr/bin/mihomomo',
  mihomoWorkDir: () => '/tmp/clash-momo-validation/work',
  mihomoTestDir: () => '/tmp/clash-momo-validation/test'
}))
vi.mock('../resolve/gistApi', () => ({}))
vi.mock('../utils/init', () => ({}))
vi.mock('../utils/age', () => ({
  parseAgeSecretKeys: (value?: string) => (value ? [value.trim()] : [])
}))
vi.mock('../../shared/i18n', () => ({ default: { t: (key: string) => key } }))
vi.mock('../utils/logger', () => ({ managerLogger: { info: vi.fn(), error: vi.fn() } }))
vi.mock('../utils/logFile', () => ({}))
vi.mock('./mihomoApi', () => ({}))
vi.mock('./factory', () => ({}))
vi.mock('./dnsOverrideGuard', () => ({}))
vi.mock('./smartModel', () => ({ syncSmartModelToTestDir: () => mocks.syncModel() }))
vi.mock('./permissions', () => ({ setStopCoreBeforeAdminRestart: vi.fn() }))
vi.mock('./process', () => ({}))
vi.mock('./dns', () => ({}))

beforeEach(() => {
  mocks.execFile
    .mockReset()
    .mockImplementation((_file, _args, _options, callback) => callback(null, '', ''))
  mocks.syncModel.mockReset().mockResolvedValue(undefined)
  vi.stubEnv('SAFE_PATHS', ['/legacy/one', '/legacy/two'].join(path.delimiter))
  vi.stubEnv('SKIP_SAFE_PATH_CHECK', undefined)
})
afterEach(() => vi.unstubAllEnvs())

describe('native profile validation safe paths', () => {
  it.each([undefined, '/tmp/clash-momo-validation/work', '/tmp/isolated-candidate-home'])(
    'allows the fixed history database when validation home is %s',
    async (workDir) => {
      const { checkProfileConfig } = await import('./manager')
      const signal = new AbortController().signal
      await checkProfileConfig(
        '/tmp/candidate-profile.yaml',
        'mihomomo',
        '  AGE-SECRET-KEY-test  ',
        {
          workDir,
          signal,
          timeoutMs: 30000
        }
      )
      const [binary, args, options] = mocks.execFile.mock.calls[0]
      expect(binary).toBe('/usr/bin/mihomomo')
      expect(args).toEqual([
        '-t',
        '-f',
        '/tmp/candidate-profile.yaml',
        '-d',
        workDir ?? '/tmp/clash-momo-validation/test'
      ])
      expect(options.env.SAFE_PATHS.split(path.delimiter)).toEqual([
        '/legacy/one',
        '/legacy/two',
        '/tmp/clash-momo-validation/work'
      ])
      expect(options.env.SKIP_SAFE_PATH_CHECK).toBeUndefined()
      expect(options.env.CLASH_AGE_SECRET_KEY).toBe('AGE-SECRET-KEY-test')
      expect(options.signal).toBe(signal)
      expect(options.timeout).toBe(30000)
      expect(mocks.syncModel).toHaveBeenCalledOnce()
    }
  )

  it('does not duplicate an existing permission for the history directory', async () => {
    vi.stubEnv(
      'SAFE_PATHS',
      ['/legacy/one', '/tmp/clash-momo-validation/work'].join(path.delimiter)
    )
    const { checkProfileConfig } = await import('./manager')
    await checkProfileConfig('/tmp/candidate-profile.yaml')
    expect(mocks.execFile.mock.calls[0][2].env.SAFE_PATHS.split(path.delimiter)).toEqual([
      '/legacy/one',
      '/tmp/clash-momo-validation/work'
    ])
  })
})
