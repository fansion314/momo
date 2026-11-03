import { execFile } from 'node:child_process'
import { mkdir, copyFile, rm } from 'node:fs/promises'
import path from 'node:path'
import { promisify } from 'node:util'
import { app, BrowserWindow, dialog, ipcMain, Notification, session, shell } from 'electron'
import i18next from 'i18next'
import { getAppConfig, subscribeAppConfig } from '../config/app'
import { dataDir, exeDir, isPortable } from '../utils/dirs'
import { appLogger } from '../utils/logger'
import { mainWindow, showMainWindow } from '../window'
import keys from '../../shared/windows-update-keys.json'
import {
  WINDOWS_UPDATE_CHECK_INTERVAL,
  windowsUpdateAssetUrl,
  windowsUpdateSource,
  type WindowsUpdateManifest,
  type WindowsUpdateState
} from '../../shared/windows-update'
import {
  downloadUpdateAsset,
  findWindowsUpdate,
  verifyDownloadedUpdate,
  type UpdateFetch
} from './windows-update-network'
import { windowsUpdateInstallCommand } from './windows-update-install'

const execFilePromise = promisify(execFile)
let state: WindowsUpdateState | undefined
let operation: Promise<WindowsUpdateState> | undefined
let abortController: AbortController | undefined
let timer: NodeJS.Timeout | undefined
let disposeConfig: (() => void) | undefined
let generation = 0
let downloaded: { path: string; manifest: WindowsUpdateManifest } | undefined
let notifiedTag: string | undefined
let updateSession: Electron.Session | undefined
let updateProxyMode: 'direct' | 'system' | undefined

export function windowsUpdateState(): WindowsUpdateState {
  if (!state) {
    state = {
      supported: process.platform === 'win32' && process.arch === 'x64' && app.isPackaged,
      portable: process.platform === 'win32' && isPortable(),
      source: 'cnb',
      currentVersion: app.getVersion(),
      currentRevision: typeof __APP_REVISION__ === 'number' ? __APP_REVISION__ : 0,
      phase: 'idle'
    }
  }
  return structuredClone(state)
}

function publish(patch: Partial<WindowsUpdateState>): WindowsUpdateState {
  state = { ...windowsUpdateState(), ...patch }
  for (const window of BrowserWindow.getAllWindows()) {
    if (!window.isDestroyed()) window.webContents.send('windowsUpdateState', state)
  }
  return windowsUpdateState()
}

async function fetchUpdate(url: string, options?: RequestInit): Promise<Response> {
  if (!updateSession) {
    updateSession = session.fromPartition('windows-updates', { cache: false })
  }
  // CNB remains usable without a running core; GitHub follows the user's
  // system proxy, without introducing an unrelated third-party download proxy.
  const mode = new URL(url).hostname === 'cnb.cool' ? 'direct' : 'system'
  if (mode !== updateProxyMode) {
    await updateSession.closeAllConnections()
    await updateSession.setProxy({ mode })
    updateProxyMode = mode
  }
  return updateSession.fetch(url, options)
}

function runOperation(
  work: (signal: AbortSignal, epoch: number) => Promise<void>,
  timeout: number
): Promise<WindowsUpdateState> {
  if (operation) return operation
  if (!windowsUpdateState().supported)
    return Promise.reject(new Error('Windows updates require a packaged Windows x64 client'))
  const epoch = generation
  abortController = new AbortController()
  const controller = abortController
  const deadline = setTimeout(
    () => controller.abort(new Error('Windows update operation timed out')),
    timeout
  )
  deadline.unref()
  operation = work(controller.signal, epoch)
    .catch((error: unknown) => {
      if (epoch === generation) publish({ phase: 'error', error: String(error) })
      throw error
    })
    .then(() => windowsUpdateState())
    .finally(() => {
      clearTimeout(deadline)
      if (abortController === controller) abortController = undefined
      operation = undefined
    })
  return operation
}

function assertCurrent(epoch: number, signal: AbortSignal): void {
  signal.throwIfAborted()
  if (epoch !== generation) throw new Error('Windows update source changed; check again')
}

export function checkWindowsUpdate(): Promise<WindowsUpdateState> {
  return runOperation(async (signal, epoch) => {
    const config = await getAppConfig()
    const source = windowsUpdateSource(config.windowsUpdateSource)
    publish({ phase: 'checking', source, error: undefined, progress: undefined })
    const current = windowsUpdateState()
    const manifest = await findWindowsUpdate(
      source,
      { version: current.currentVersion, revision: current.currentRevision },
      keys,
      fetchUpdate as UpdateFetch,
      signal
    )
    assertCurrent(epoch, signal)
    downloaded = downloaded?.manifest.tag === manifest?.tag ? downloaded : undefined
    publish({
      phase: manifest ? (downloaded ? 'downloaded' : 'available') : 'idle',
      update: manifest,
      checkedAt: new Date().toISOString()
    })
    if (manifest && notifiedTag !== manifest.tag && Notification.isSupported()) {
      notifiedTag = manifest.tag
      const notification = new Notification({
        title: i18next.t('windowsUpdate.availableTitle'),
        body: i18next.t('windowsUpdate.availableBody', {
          version: `${manifest.version}-${manifest.revision}`
        })
      })
      notification.on('click', showMainWindow)
      notification.show()
    }
  }, 120000)
}

export function downloadWindowsUpdate(): Promise<WindowsUpdateState> {
  return runOperation(
    async (signal, epoch) => {
      const current = windowsUpdateState()
      const manifest = current.update
      if (!manifest) throw new Error('Check for a Windows update first')
      const asset = current.portable ? manifest.assets.portable : manifest.assets.installer
      const confirmation = await dialog.showMessageBox({
        type: 'question',
        title: i18next.t('windowsUpdate.download'),
        message: i18next.t('windowsUpdate.downloadConfirm', {
          version: `${manifest.version}-${manifest.revision}`
        }),
        detail: i18next.t(
          current.portable ? 'windowsUpdate.portableHelp' : 'windowsUpdate.downloadHelp'
        ),
        buttons: [i18next.t('common.cancel'), i18next.t('windowsUpdate.download')],
        defaultId: 1,
        cancelId: 0,
        noLink: true
      })
      if (confirmation.response !== 1) return
      assertCurrent(epoch, signal)
      let destination: string | undefined
      if (current.portable) {
        const save = await dialog.showSaveDialog({
          title: i18next.t('windowsUpdate.savePortable'),
          defaultPath: path.join(app.getPath('downloads'), asset.name),
          filters: [{ name: 'ZIP', extensions: ['zip'] }]
        })
        if (save.canceled || !save.filePath) return
        destination = save.filePath
      }
      const cache = path.join(dataDir(), 'updates')
      await mkdir(cache, { recursive: true })
      const file = path.join(cache, asset.name)
      publish({ phase: 'downloading', progress: 0, error: undefined })
      let lastProgress = -1
      await downloadUpdateAsset(
        windowsUpdateAssetUrl(current.source, manifest.tag, asset.name),
        file,
        asset,
        fetchUpdate as UpdateFetch,
        (progress) => {
          if (progress !== lastProgress && epoch === generation) {
            lastProgress = progress
            publish({ progress })
          }
        },
        signal
      )
      assertCurrent(epoch, signal)
      if (destination) {
        if (path.resolve(destination) === path.resolve(file))
          throw new Error('Choose a location outside the updater cache')
        await copyFile(file, destination)
        if (!(await verifyDownloadedUpdate(destination, asset))) {
          await rm(destination, { force: true }).catch(() => {})
          throw new Error('The saved Windows update ZIP failed verification')
        }
        shell.showItemInFolder(destination)
      }
      downloaded = { path: file, manifest }
      publish({ phase: 'downloaded', progress: 100 })
    },
    15 * 60 * 1000
  )
}

export function installWindowsUpdate(): Promise<WindowsUpdateState> {
  return runOperation(
    async (signal, epoch) => {
      const current = windowsUpdateState()
      if (current.portable || !downloaded || current.update?.tag !== downloaded.manifest.tag)
        throw new Error('Download the Windows installer before installing')
      const ready = downloaded
      const confirmation = await dialog.showMessageBox({
        type: 'question',
        title: i18next.t('windowsUpdate.install'),
        message: i18next.t('windowsUpdate.installConfirm', {
          version: `${ready.manifest.version}-${ready.manifest.revision}`
        }),
        detail: i18next.t('windowsUpdate.installHelp'),
        buttons: [i18next.t('common.cancel'), i18next.t('windowsUpdate.install')],
        defaultId: 0,
        cancelId: 0,
        noLink: true
      })
      if (confirmation.response !== 1) return
      assertCurrent(epoch, signal)
      if (!(await verifyDownloadedUpdate(ready.path, ready.manifest.assets.installer)))
        throw new Error('The cached Windows installer failed verification; download it again')
      publish({ phase: 'installing', error: undefined })
      const command = windowsUpdateInstallCommand(
        ready.path,
        ready.manifest.assets.installer,
        process.pid,
        exeDir()
      )
      try {
        // The elevated process waits for our normal before-quit cleanup. UAC
        // cancellation returns before touching the current core or proxy state.
        await execFilePromise(command.program, command.args, { windowsHide: true, timeout: 300000 })
      } catch (error) {
        publish({ phase: 'downloaded', error: i18next.t('windowsUpdate.installCanceled') })
        await appLogger.warn('Windows update elevation was canceled or could not start', error)
        return
      }
      app.quit()
    },
    6 * 60 * 1000
  )
}

function scheduleCheck(delay = 20000): void {
  if (timer) clearTimeout(timer)
  timer = setTimeout(() => {
    timer = undefined
    void checkWindowsUpdate()
      .catch((error) => appLogger.warn('Automatic Windows update check failed', error))
      .finally(() => {
        if (!disposeConfig) return
        void getAppConfig().then((config) => {
          if (config.windowsAutoCheckUpdate !== false && !timer && disposeConfig)
            scheduleCheck(WINDOWS_UPDATE_CHECK_INTERVAL)
        })
      })
  }, delay)
  timer.unref()
}

export function initWindowsUpdater(): void {
  if (!windowsUpdateState().supported || disposeConfig) return
  let previousEnabled: boolean | undefined
  let previousSource: string | undefined
  disposeConfig = subscribeAppConfig((config) => {
    const enabled = config.windowsAutoCheckUpdate !== false
    const source = windowsUpdateSource(config.windowsUpdateSource)
    if (source !== previousSource) {
      generation++
      abortController?.abort()
      downloaded = undefined
      publish({ source, phase: 'idle', update: undefined, progress: undefined, error: undefined })
    }
    if (source !== previousSource || enabled !== previousEnabled) {
      if (timer) clearTimeout(timer)
      timer = undefined
      if (enabled) scheduleCheck()
    }
    previousEnabled = enabled
    previousSource = source
  })
  app.once('before-quit', disposeWindowsUpdater)
}

export function disposeWindowsUpdater(): void {
  disposeConfig?.()
  disposeConfig = undefined
  if (timer) clearTimeout(timer)
  timer = undefined
  abortController?.abort()
}

export function registerWindowsUpdateIpc(): void {
  const handlers = {
    windowsUpdateState,
    checkWindowsUpdate,
    downloadWindowsUpdate,
    installWindowsUpdate
  }
  for (const [channel, handler] of Object.entries(handlers)) {
    ipcMain.handle(channel, async (event, ...args: unknown[]) => {
      try {
        if (
          !mainWindow ||
          event.sender !== mainWindow.webContents ||
          event.senderFrame !== event.sender.mainFrame ||
          args.length !== 0
        )
          throw new Error('Invalid Windows update IPC request')
        return await handler()
      } catch (error) {
        return { invokeError: String(error) }
      }
    })
  }
}
