import { EventEmitter } from 'node:events'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  config: { silentStart: false, zoomFactor: 1.25, autoQuitWithoutCore: false } as IAppConfig,
  getConfig: vi.fn(),
  tray: vi.fn(),
  destroyFloating: vi.fn(),
  showFloating: vi.fn(),
  configListeners: [] as ((config: IAppConfig) => void)[],
  windows: [] as unknown[],
  order: [] as string[]
}))

class TestWebContents extends EventEmitter {
  setZoomFactor = vi.fn()
  setWindowOpenHandler = vi.fn()
  reload = vi.fn()
  isCrashed = (): boolean => false
}
class TestWindow extends EventEmitter {
  webContents = new TestWebContents()
  visible = false
  destroyed = false
  options: { webPreferences?: { zoomFactor?: number } }
  constructor(options: { webPreferences?: { zoomFactor?: number } }) {
    super()
    this.options = options
    mocks.windows.push(this)
  }
  isDestroyed = (): boolean => this.destroyed
  isVisible = (): boolean => this.visible
  isMaximized = (): boolean => false
  isMinimized = (): boolean => false
  isFullScreen = (): boolean => false
  getContentBounds = (): object => ({ width: 800, height: 600, x: 0, y: 0 })
  show = (): void => {
    this.visible = true
    this.emit('show')
  }
  hide = (): void => {
    this.visible = false
  }
  focusOnWebView = vi.fn()
  close = (): void => {
    this.emit('close', { preventDefault: vi.fn() })
  }
  destroy = (): void => {
    mocks.order.push('destroy')
    // Electron can report renderer termination during deliberate destruction.
    this.webContents.emit('render-process-gone', {}, { reason: 'killed' })
    this.destroyed = true
    this.visible = false
    this.emit('closed')
  }
  async loadFile(): Promise<void> {
    queueMicrotask(() => this.webContents.emit('ipc-message', {}, 'rendererFirstContentReady'))
  }
}

vi.mock('electron', () => ({
  BrowserWindow: TestWindow,
  Menu: { setApplicationMenu: vi.fn() },
  screen: { getAllDisplays: () => [{ bounds: { x: 0, y: 0, width: 2000, height: 1200 } }] },
  shell: { openExternal: vi.fn() }
}))
vi.mock('@electron-toolkit/utils', () => ({ is: { dev: false } }))
vi.mock('./config', () => ({ getAppConfig: () => mocks.getConfig() }))
vi.mock('./config/app', () => ({
  subscribeAppConfig: (listener: (config: IAppConfig) => void) => {
    mocks.configListeners.push(listener)
  }
}))
vi.mock('./resolve/tray', () => ({
  showTrayIcon: () => mocks.tray(),
  closeTrayIcon: vi.fn(),
  showDockIcon: vi.fn(),
  hideDockIcon: vi.fn()
}))
vi.mock('./resolve/floatingWindow', () => ({
  destroyFloatingWindow: () => mocks.destroyFloating(),
  showFloatingWindow: () => mocks.showFloating()
}))
vi.mock('./utils/dirs', () => ({ dataDir: () => '/tmp/clash-momo-window-test' }))
vi.mock('./utils/logger', () => ({
  mainWindowLogger: {
    error: vi.fn().mockResolvedValue(undefined),
    warn: vi.fn().mockResolvedValue(undefined)
  }
}))
vi.mock('./utils/safeFile', () => ({ atomicWriteFileSync: vi.fn() }))

beforeEach(() => {
  vi.resetModules()
  mocks.config = { silentStart: false, zoomFactor: 1.25, autoQuitWithoutCore: false } as IAppConfig
  mocks.getConfig.mockReset().mockImplementation(async () => mocks.config)
  mocks.tray.mockReset().mockImplementation(async () => {
    mocks.order.push('tray')
  })
  mocks.destroyFloating.mockReset()
  mocks.showFloating.mockReset()
  mocks.windows = []
  mocks.order = []
  mocks.configListeners = []
})

const settle = async (): Promise<void> => {
  for (let i = 0; i < 12; ++i) await Promise.resolve()
}

describe('renderer lifecycle', () => {
  it('ensures the tray first, destroys both renderers, and recreates a single main window on reopen', async () => {
    const window = await import('./window')
    await window.createWindow()
    const initial = window.mainWindow as unknown as TestWindow
    expect(initial.options.webPreferences?.zoomFactor).toBe(1.25)
    await window.enterLightweightMode()
    await settle()
    expect(mocks.order).toEqual(['tray', 'destroy'])
    expect(mocks.destroyFloating).toHaveBeenCalledOnce()
    expect(window.mainWindow).toBeNull()
    expect(mocks.windows).toHaveLength(1)
    window.showMainWindow()
    window.showMainWindow()
    await settle()
    expect(mocks.windows).toHaveLength(2)
    expect(window.mainWindow?.isVisible()).toBe(true)
    expect(initial.destroyed).toBe(true)
  })

  it('cancels a pending transition when the tray reopens during tray creation', async () => {
    const window = await import('./window')
    await window.createWindow()
    let finishTray!: () => void
    mocks.tray.mockReturnValue(
      new Promise<void>((resolve) => {
        finishTray = resolve
      })
    )
    const enter = window.enterLightweightMode()
    window.showMainWindow()
    finishTray()
    await enter
    expect(window.mainWindow?.isVisible()).toBe(true)
    expect(mocks.destroyFloating).not.toHaveBeenCalled()
    expect(mocks.windows).toHaveLength(1)
  })

  it('applies live config zoom and persisted zoom when recreating the renderer', async () => {
    const window = await import('./window')
    await window.createWindow()
    mocks.config.zoomFactor = 1.37
    for (const listener of mocks.configListeners) listener(mocks.config)
    const initial = window.mainWindow as unknown as TestWindow
    expect(initial.webContents.setZoomFactor).toHaveBeenLastCalledWith(1.37)
    await window.enterLightweightMode()
    window.showMainWindow()
    await settle()
    const recreated = window.mainWindow as unknown as TestWindow
    expect(recreated.options.webPreferences?.zoomFactor).toBe(1.37)
    expect(mocks.configListeners).toHaveLength(1)
  })

  it('uses the same renderer teardown for automatic lightweight mode', async () => {
    vi.useFakeTimers()
    try {
      mocks.config.autoQuitWithoutCore = true
      mocks.config.autoQuitWithoutCoreDelay = 1
      const window = await import('./window')
      await window.createWindow()
      window.closeMainWindow()
      await settle()
      await vi.advanceTimersByTimeAsync(1000)
      await settle()
      expect(window.mainWindow).toBeNull()
      expect(mocks.destroyFloating).toHaveBeenCalledOnce()
      expect(mocks.order).toEqual(['tray', 'destroy'])
    } finally {
      vi.useRealTimers()
    }
  })

  it('coalesces repeated entry and preserves the main window if creating the tray fails', async () => {
    const window = await import('./window')
    await window.createWindow()
    mocks.tray.mockRejectedValueOnce(new Error('tray unavailable'))
    await expect(window.enterLightweightMode()).rejects.toThrow('tray unavailable')
    expect(window.mainWindow?.isVisible()).toBe(true)
    mocks.tray.mockImplementation(async () => {
      mocks.order.push('tray')
    })
    await Promise.all([window.enterLightweightMode(), window.enterLightweightMode()])
    expect(mocks.tray).toHaveBeenCalledTimes(2)
    expect(mocks.order).toEqual(['tray', 'destroy'])
  })

  it('does not schedule an automatic close after a quick tray reopen while config loads', async () => {
    vi.useFakeTimers()
    try {
      const window = await import('./window')
      await window.createWindow()
      let finishConfig!: (config: IAppConfig) => void
      mocks.getConfig.mockReturnValueOnce(
        new Promise<IAppConfig>((resolve) => {
          finishConfig = resolve
        })
      )
      window.closeMainWindow()
      window.showMainWindow()
      finishConfig({ ...mocks.config, autoQuitWithoutCore: true, autoQuitWithoutCoreDelay: 0 })
      await settle()
      await vi.runOnlyPendingTimersAsync()
      expect(window.mainWindow?.isVisible()).toBe(true)
      expect(mocks.tray).not.toHaveBeenCalled()
    } finally {
      vi.useRealTimers()
    }
  })
})
