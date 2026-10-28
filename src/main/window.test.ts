import { EventEmitter } from 'node:events'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  config: { silentStart: false, zoomFactor: 1.25, autoQuitWithoutCore: false } as IAppConfig,
  getConfig: vi.fn(),
  tray: vi.fn(),
  destroyFloating: vi.fn(),
  showFloating: vi.fn(),
  configListeners: [] as ((config: IAppConfig) => void)[],
  ozonePlatform: 'x11',
  windows: [] as unknown[],
  order: [] as string[]
}))

class TestWebContents extends EventEmitter {
  send = vi.fn()
  setZoomFactor = vi.fn()
  setWindowOpenHandler = vi.fn()
  reload = vi.fn()
  isCrashed = (): boolean => false
}
class TestWindow extends EventEmitter {
  webContents = new TestWebContents()
  visible = false
  destroyed = false
  maximized = false
  alwaysOnTop = false
  options: Electron.BrowserWindowConstructorOptions
  constructor(options: Electron.BrowserWindowConstructorOptions) {
    super()
    this.options = options
    mocks.windows.push(this)
  }
  isDestroyed = (): boolean => this.destroyed
  isVisible = (): boolean => this.visible
  isMaximized = (): boolean => this.maximized
  isAlwaysOnTop = (): boolean => this.alwaysOnTop
  setAlwaysOnTop = vi.fn((value: boolean) => {
    this.alwaysOnTop = value
    this.emit('always-on-top-changed')
  })
  minimize = vi.fn()
  maximize = (): void => {
    this.maximized = true
    this.emit('maximize')
  }
  unmaximize = (): void => {
    this.maximized = false
    this.emit('unmaximize')
  }
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
  app: { commandLine: { getSwitchValue: () => mocks.ozonePlatform } },
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
  mocks.ozonePlatform = 'x11'
})

afterEach(() => vi.unstubAllEnvs())

const settle = async (): Promise<void> => {
  for (let i = 0; i < 12; ++i) await Promise.resolve()
}

describe('renderer lifecycle', () => {
  it('uses renderer controls on Linux and preserves the configured system title bar', async () => {
    const window = await import('./window')
    await window.createWindow()
    const frameless = window.mainWindow as unknown as TestWindow
    expect(frameless.options.frame).toBe(false)
    expect(frameless.options.titleBarOverlay).toBe(false)
    await window.enterLightweightMode()
    mocks.config.useWindowFrame = true
    window.showMainWindow()
    await settle()
    const framed = window.mainWindow as unknown as TestWindow
    expect(framed.options.frame).toBe(true)
    expect(framed.options.titleBarStyle).toBe('default')
    expect(framed.options.titleBarOverlay).toBe(false)
  })

  it('minimizes, toggles maximize, and broadcasts actual native window state', async () => {
    const window = await import('./window')
    await window.createWindow()
    const native = window.mainWindow as unknown as TestWindow
    window.minimizeMainWindow()
    expect(native.minimize).toHaveBeenCalledOnce()
    expect(window.toggleMainWindowMaximized().maximized).toBe(true)
    expect(window.toggleMainWindowMaximized().maximized).toBe(false)
    expect(window.setMainWindowAlwaysOnTop(true).alwaysOnTop).toBe(true)
    expect(native.setAlwaysOnTop).toHaveBeenCalledWith(true)
    native.alwaysOnTop = false
    native.emit('focus')
    expect(native.webContents.send).toHaveBeenLastCalledWith('mainWindowStateChanged', {
      maximized: false,
      alwaysOnTop: false,
      supportsAlwaysOnTop: true
    })
  })

  it('does not advertise or call unsupported always-on-top on native Wayland', async () => {
    mocks.ozonePlatform = 'wayland'
    const window = await import('./window')
    await window.createWindow()
    const native = window.mainWindow as unknown as TestWindow
    expect(window.getMainWindowState().supportsAlwaysOnTop).toBe(false)
    expect(window.setMainWindowAlwaysOnTop(true).alwaysOnTop).toBe(false)
    expect(native.setAlwaysOnTop).not.toHaveBeenCalled()
  })

  it('uses the explicit X11 backend even inside a Wayland session', async () => {
    vi.stubEnv('XDG_SESSION_TYPE', 'wayland')
    vi.stubEnv('WAYLAND_DISPLAY', 'wayland-0')
    const window = await import('./window')
    expect(window.getMainWindowState().supportsAlwaysOnTop).toBe(true)
  })

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
