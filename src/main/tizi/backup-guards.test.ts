import { afterEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  config: { tiziActive: true, webdavBackupCron: '* * * * *' },
  dialog: vi.fn(),
  request: vi.fn(),
  runtime: vi.fn()
}))
vi.mock('electron', () => ({
  dialog: { showSaveDialog: mocks.dialog, showOpenDialog: mocks.dialog }
}))
vi.mock('../config', () => ({ getAppConfig: async () => mocks.config }))
vi.mock('../config/app', () => ({ getAppConfig: async () => mocks.config }))
vi.mock('../utils/dirs', () => ({}))
vi.mock('../utils/logger', () => ({
  systemLogger: { info: vi.fn(), error: vi.fn() },
  createLogger: () => ({ warn: vi.fn() })
}))
vi.mock('../core/factory', () => ({ getRuntimeConfigStr: mocks.runtime }))
vi.mock('../utils/chromeRequest', () => ({
  get: mocks.request,
  post: mocks.request,
  patch: mocks.request
}))
vi.mock('../config/controledMihomo', () => ({ getControledMihomoConfig: vi.fn() }))
vi.mock('../utils/age', () => ({ encryptAgeContent: vi.fn(), generateAgeKeyPair: vi.fn() }))
afterEach(() => vi.unstubAllGlobals())

describe('backup entry points enforce managed subscription policy', () => {
  it('blocks every local/WebDAV operation before opening dialogs or accessing files/network', async () => {
    vi.stubGlobal('__TIZI_ENABLED__', true)
    const backup = await import('../resolve/backup')
    for (const operation of [
      () => backup.webdavBackup(),
      () => backup.webdavRestore('backup.zip'),
      () => backup.listWebdavBackups(),
      () => backup.webdavDelete('backup.zip'),
      () => backup.exportLocalBackup(),
      () => backup.importLocalBackup()
    ])
      await expect(operation()).rejects.toThrow('备份')
    expect(mocks.dialog).not.toHaveBeenCalled()
    await expect(backup.initWebdavBackupScheduler()).resolves.toBeUndefined()
  })

  it('blocks manual Gist operations and silently skips scheduled synchronization', async () => {
    vi.stubGlobal('__TIZI_ENABLED__', true)
    const gist = await import('../resolve/gistApi')
    await expect(gist.getGistUrl()).rejects.toThrow('备份')
    await expect(gist.uploadRuntimeConfig()).rejects.toThrow('备份')
    await expect(gist.exportGistAgeSecretKey()).rejects.toThrow('备份')
    await expect(gist.uploadRuntimeConfigIfChanged()).resolves.toBeUndefined()
    expect(mocks.request).not.toHaveBeenCalled()
    expect(mocks.runtime).not.toHaveBeenCalled()
    expect(mocks.dialog).not.toHaveBeenCalled()
  })
})
