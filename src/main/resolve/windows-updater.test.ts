import { mkdtemp, rm, writeFile, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { WINDOWS_UPDATE_CHECK_INTERVAL } from '../../shared/windows-update'
import { signedUpdateFixture } from './windows-update-test-fixture'

const mocks = vi.hoisted(() => ({
  config: { windowsAutoCheckUpdate: true, windowsUpdateSource: 'cnb' } as Record<string, unknown>,
  configListener: undefined as ((config: unknown) => void) | undefined,
  directory: '',
  portable: false,
  quit: vi.fn(),
  once: vi.fn(),
  execFile: vi.fn(),
  dialog: vi.fn(),
  save: vi.fn(),
  showFile: vi.fn(),
  findUpdate: vi.fn(),
  download: vi.fn(),
  verify: vi.fn(),
  send: vi.fn(),
  ipc: new Map<string, (...args: unknown[]) => Promise<unknown>>(),
  webContents: { mainFrame: {} },
  notify: vi.fn(),
  disposeConfig: vi.fn(),
  setProxy: vi.fn(),
  closeConnections: vi.fn(),
  fetch: vi.fn()
}))

vi.mock('node:child_process', () => ({ execFile: mocks.execFile }))
vi.mock('i18next', () => ({ default: { t: (key: string) => key } }))
vi.mock('../config/app', () => ({
  getAppConfig: async () => mocks.config,
  subscribeAppConfig: (listener: (config: unknown) => void) => {
    mocks.configListener = listener
    listener(mocks.config)
    return mocks.disposeConfig
  }
}))
vi.mock('../utils/dirs', () => ({
  dataDir: () => mocks.directory,
  exeDir: () => 'D:\\中文 目录\\Clash Momo',
  isPortable: () => mocks.portable
}))
vi.mock('../utils/logger', () => ({ appLogger: { warn: vi.fn() } }))
vi.mock('../window', () => ({
  mainWindow: { webContents: mocks.webContents },
  showMainWindow: vi.fn()
}))
vi.mock('./windows-update-network', () => ({
  findWindowsUpdate: mocks.findUpdate,
  downloadUpdateAsset: mocks.download,
  verifyDownloadedUpdate: mocks.verify
}))
vi.mock('electron', () => ({
  app: {
    isPackaged: true,
    getVersion: () => '2.0.4',
    getPath: () => mocks.directory,
    quit: mocks.quit,
    once: mocks.once
  },
  BrowserWindow: {
    getAllWindows: () => [{ isDestroyed: () => false, webContents: { send: mocks.send } }]
  },
  dialog: { showMessageBox: mocks.dialog, showSaveDialog: mocks.save },
  shell: { showItemInFolder: mocks.showFile },
  session: {
    fromPartition: () => ({
      setProxy: mocks.setProxy,
      closeAllConnections: mocks.closeConnections,
      fetch: mocks.fetch
    })
  },
  Notification: class {
    static isSupported() {
      return true
    }
    on() {
      return this
    }
    show() {
      mocks.notify()
    }
  },
  ipcMain: {
    handle: (channel: string, handler: (...args: unknown[]) => Promise<unknown>) =>
      mocks.ipc.set(channel, handler)
  }
}))

const originalPlatform = process.platform
const originalArch = process.arch
let updater: typeof import('./windows-updater')

beforeEach(async () => {
  vi.resetModules()
  vi.clearAllMocks()
  vi.stubGlobal('__APP_REVISION__', 4)
  Object.defineProperty(process, 'platform', { value: 'win32' })
  Object.defineProperty(process, 'arch', { value: 'x64' })
  mocks.directory = await mkdtemp(path.join(tmpdir(), 'windows-updater-service-'))
  mocks.portable = false
  mocks.config = { windowsAutoCheckUpdate: true, windowsUpdateSource: 'cnb' }
  mocks.configListener = undefined
  mocks.ipc.clear()
  mocks.setProxy.mockResolvedValue(undefined)
  mocks.closeConnections.mockResolvedValue(undefined)
  mocks.fetch.mockResolvedValue(new Response('{}'))
  mocks.findUpdate.mockResolvedValue(signedUpdateFixture().manifest)
  mocks.dialog.mockResolvedValue({ response: 1 })
  mocks.save.mockResolvedValue({ canceled: true })
  mocks.verify.mockResolvedValue(true)
  mocks.download.mockImplementation(async (_url: string, file: string) => {
    await writeFile(file, 'portable zip')
  })
  mocks.execFile.mockImplementation(
    (
      _program: unknown,
      _args: unknown,
      _options: unknown,
      callback: (error: Error | null, stdout: string, stderr: string) => void
    ) => callback(null, '', '')
  )
  updater = await import('./windows-updater')
})

afterEach(async () => {
  updater.disposeWindowsUpdater()
  vi.useRealTimers()
  vi.unstubAllGlobals()
  Object.defineProperty(process, 'platform', { value: originalPlatform })
  Object.defineProperty(process, 'arch', { value: originalArch })
  await rm(mocks.directory, { recursive: true, force: true })
})

describe('Windows update coordination', () => {
  it('uses a direct CNB connection and refreshes connections when GitHub uses the system proxy', async () => {
    updater.initWindowsUpdater()
    mocks.findUpdate.mockImplementation(
      async (
        source: string,
        _current: unknown,
        _keys: unknown,
        fetcher: (url: string) => Promise<unknown>
      ) => {
        await fetcher(
          source === 'cnb'
            ? 'https://cnb.cool/feed'
            : 'https://api.github.com/repos/fansion314/momo/releases'
        )
        return undefined
      }
    )
    await updater.checkWindowsUpdate()
    expect(mocks.setProxy).toHaveBeenLastCalledWith({ mode: 'direct' })
    await updater.checkWindowsUpdate()
    expect(mocks.setProxy).toHaveBeenCalledTimes(1)
    mocks.config.windowsUpdateSource = 'github'
    mocks.configListener?.(mocks.config)
    await updater.checkWindowsUpdate()
    expect(mocks.setProxy).toHaveBeenLastCalledWith({ mode: 'system' })
    expect(mocks.closeConnections).toHaveBeenCalledTimes(2)
  })
  it('checks after startup and every 24 hours in the main process, without downloading or installing', async () => {
    vi.useFakeTimers()
    updater.initWindowsUpdater()
    await vi.advanceTimersByTimeAsync(20000)
    expect(mocks.findUpdate).toHaveBeenCalledTimes(1)
    expect(mocks.notify).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(WINDOWS_UPDATE_CHECK_INTERVAL)
    expect(mocks.findUpdate).toHaveBeenCalledTimes(2)
    expect(mocks.notify).toHaveBeenCalledTimes(1)
    expect(mocks.dialog).not.toHaveBeenCalled()
    expect(mocks.download).not.toHaveBeenCalled()
    expect(mocks.execFile).not.toHaveBeenCalled()
    mocks.config.windowsAutoCheckUpdate = false
    mocks.configListener?.(mocks.config)
    await vi.advanceTimersByTimeAsync(WINDOWS_UPDATE_CHECK_INTERVAL)
    expect(mocks.findUpdate).toHaveBeenCalledTimes(2)
  })

  it('uses CNB by default and clears stale availability after a source change', async () => {
    updater.initWindowsUpdater()
    await updater.checkWindowsUpdate()
    expect(mocks.findUpdate.mock.calls[0][0]).toBe('cnb')
    expect(updater.windowsUpdateState().phase).toBe('available')
    mocks.config.windowsUpdateSource = 'github'
    mocks.configListener?.(mocks.config)
    expect(updater.windowsUpdateState()).toMatchObject({
      source: 'github',
      phase: 'idle',
      update: undefined
    })
  })

  it('requires a download confirmation and a separate install confirmation', async () => {
    await updater.checkWindowsUpdate()
    mocks.dialog.mockResolvedValueOnce({ response: 0 })
    await updater.downloadWindowsUpdate()
    expect(mocks.download).not.toHaveBeenCalled()
    await updater.downloadWindowsUpdate()
    expect(mocks.download).toHaveBeenCalledTimes(1)
    expect(updater.windowsUpdateState().phase).toBe('downloaded')
    expect(mocks.quit).not.toHaveBeenCalled()
    mocks.dialog.mockResolvedValueOnce({ response: 0 })
    await updater.installWindowsUpdate()
    expect(mocks.execFile).not.toHaveBeenCalled()
    await updater.installWindowsUpdate()
    expect(mocks.execFile).toHaveBeenCalledTimes(1)
    expect(mocks.quit).toHaveBeenCalledTimes(1)
    expect(mocks.verify).toHaveBeenCalledTimes(1)
  })

  it('keeps the current application running when UAC is canceled', async () => {
    await updater.checkWindowsUpdate()
    await updater.downloadWindowsUpdate()
    mocks.execFile.mockImplementationOnce(
      (_program: unknown, _args: unknown, _options: unknown, callback: (error: Error) => void) =>
        callback(new Error('UAC canceled'))
    )
    const state = await updater.installWindowsUpdate()
    expect(state.phase).toBe('downloaded')
    expect(state.error).toBeTruthy()
    expect(mocks.quit).not.toHaveBeenCalled()
  })

  it('refuses to launch a changed cached installer', async () => {
    await updater.checkWindowsUpdate()
    await updater.downloadWindowsUpdate()
    mocks.verify.mockResolvedValueOnce(false)
    await expect(updater.installWindowsUpdate()).rejects.toThrow('failed verification')
    expect(mocks.execFile).not.toHaveBeenCalled()
    expect(mocks.quit).not.toHaveBeenCalled()
  })

  it('downloads only a portable ZIP to the selected location and never installs it', async () => {
    mocks.portable = true
    const destination = path.join(mocks.directory, 'portable-update.zip')
    mocks.save.mockResolvedValueOnce({ canceled: false, filePath: destination })
    await updater.checkWindowsUpdate()
    await updater.downloadWindowsUpdate()
    expect(mocks.download.mock.calls[0][0]).toContain('-portable.zip')
    expect(await readFile(destination, 'utf8')).toBe('portable zip')
    expect(mocks.showFile).toHaveBeenCalledWith(destination)
    await expect(updater.installWindowsUpdate()).rejects.toThrow()
    expect(mocks.execFile).not.toHaveBeenCalled()
    expect(mocks.quit).not.toHaveBeenCalled()
  })

  it('restricts update IPC to the main frame of the client, with no renderer-controlled paths', async () => {
    updater.registerWindowsUpdateIpc()
    const handler = mocks.ipc.get('windowsUpdateState')
    expect(handler).toBeTruthy()
    const event = { sender: mocks.webContents, senderFrame: mocks.webContents.mainFrame }
    expect(await handler?.(event)).toMatchObject({ supported: true })
    expect(await handler?.(event, 'C:\\payload.exe')).toHaveProperty('invokeError')
    expect(await handler?.({ ...event, senderFrame: {} })).toHaveProperty('invokeError')
    expect(await handler?.({ ...event, sender: { mainFrame: event.senderFrame } })).toHaveProperty(
      'invokeError'
    )
  })
})
