import { EventEmitter } from 'node:events'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  app: { on: vi.fn(), quit: vi.fn(), exit: vi.fn() },
  powerMonitor: { on: vi.fn() },
  stopCore: vi.fn(),
  cleanupWatcher: vi.fn(),
  triggerProxy: vi.fn(),
  disableProxySync: vi.fn(),
  saveWindow: vi.fn()
}))
vi.mock('electron', () => ({ app: mocks.app, powerMonitor: mocks.powerMonitor }))
vi.mock('./core/manager', () => ({
  stopCoreForExit: mocks.stopCore,
  cleanupCoreWatcher: mocks.cleanupWatcher
}))
vi.mock('./core/admin', () => ({ primeAdminPrivilegesCache: vi.fn() }))
vi.mock('./sys/sysproxy', () => ({
  triggerSysProxy: mocks.triggerProxy,
  disableSysProxySync: mocks.disableProxySync
}))
vi.mock('./utils/dirs', () => ({
  exePath: () => '/Applications/Clash Momo.app/Contents/MacOS/Clash Momo'
}))
vi.mock('./window', () => ({ saveMainWindowState: mocks.saveWindow }))

let appEvents: EventEmitter
let powerEvents: EventEmitter
let processEvents: EventEmitter
const settle = async (): Promise<void> => {
  for (let i = 0; i < 20; i++) await Promise.resolve()
}
beforeEach(() => {
  vi.resetModules()
  vi.clearAllMocks()
  vi.useFakeTimers()
  appEvents = new EventEmitter()
  powerEvents = new EventEmitter()
  processEvents = new EventEmitter()
  mocks.app.on.mockImplementation((...args: Parameters<EventEmitter['on']>) =>
    appEvents.on(...args)
  )
  mocks.powerMonitor.on.mockImplementation((...args: Parameters<EventEmitter['on']>) =>
    powerEvents.on(...args)
  )
  mocks.app.quit.mockImplementation(() =>
    appEvents.emit('before-quit', { preventDefault: vi.fn() })
  )
  mocks.stopCore.mockResolvedValue(undefined)
  mocks.triggerProxy.mockResolvedValue(undefined)
  vi.stubGlobal(
    'process',
    new Proxy(process, {
      get: (target, key) => {
        if (key === 'platform') return 'darwin'
        if (key === 'on') return processEvents.on.bind(processEvents)
        if (key === 'off') return processEvents.off.bind(processEvents)
        return Reflect.get(target, key)
      }
    })
  )
})
afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

describe('macOS termination signals', () => {
  it('routes SIGTERM and SIGINT through one graceful core and proxy cleanup', async () => {
    let release: (() => void) | undefined
    mocks.stopCore.mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          release = resolve
        })
    )
    const { setupAppLifecycle } = await import('./lifecycle')
    setupAppLifecycle()
    processEvents.emit('SIGTERM')
    processEvents.emit('SIGINT')
    expect(mocks.app.quit).toHaveBeenCalledTimes(1)
    expect(mocks.stopCore).toHaveBeenCalledTimes(1)
    expect(mocks.cleanupWatcher).toHaveBeenCalledTimes(1)
    expect(mocks.saveWindow).toHaveBeenCalledTimes(1)
    expect(mocks.triggerProxy).toHaveBeenCalledWith(false, { helperTimeout: 750, force: true })
    expect(mocks.app.exit).not.toHaveBeenCalled()
    release?.()
    await settle()
    expect(mocks.app.exit).toHaveBeenCalledTimes(1)
    appEvents.emit('will-quit')
    expect(processEvents.listenerCount('SIGTERM')).toBe(0)
    expect(processEvents.listenerCount('SIGINT')).toBe(0)
  })
  it('keeps the existing exit budget when a core fails to finish cleanup', async () => {
    mocks.stopCore.mockImplementation(() => new Promise<void>(() => {}))
    const { setupAppLifecycle } = await import('./lifecycle')
    setupAppLifecycle()
    processEvents.emit('SIGINT')
    await vi.advanceTimersByTimeAsync(13999)
    expect(mocks.app.exit).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(1)
    expect(mocks.app.exit).toHaveBeenCalledTimes(1)
    expect(mocks.stopCore).toHaveBeenCalledTimes(1)
    appEvents.emit('will-quit')
  })
  it('shares cleanup with an overlapping normal quit request', async () => {
    const { setupAppLifecycle } = await import('./lifecycle')
    setupAppLifecycle()
    processEvents.emit('SIGTERM')
    appEvents.emit('before-quit', { preventDefault: vi.fn() })
    await settle()
    expect(mocks.stopCore).toHaveBeenCalledTimes(1)
    expect(mocks.saveWindow).toHaveBeenCalledTimes(1)
    expect(mocks.triggerProxy).toHaveBeenCalledTimes(1)
    appEvents.emit('will-quit')
  })
  it('does not change signal handling on Linux', async () => {
    vi.stubGlobal(
      'process',
      new Proxy(process, {
        get: (target, key) => (key === 'platform' ? 'linux' : Reflect.get(target, key))
      })
    )
    const { setupAppLifecycle } = await import('./lifecycle')
    setupAppLifecycle()
    expect(processEvents.listenerCount('SIGTERM')).toBe(0)
    expect(processEvents.listenerCount('SIGINT')).toBe(0)
  })
})
