import { afterEach, expect, it, vi } from 'vitest'

const { expose, invoke } = vi.hoisted(() => ({ expose: vi.fn(), invoke: vi.fn() }))
vi.mock('electron', () => ({
  contextBridge: { exposeInMainWorld: expose },
  ipcRenderer: { invoke },
  webUtils: {}
}))
const isolated = Object.getOwnPropertyDescriptor(process, 'contextIsolated')
afterEach(() => {
  if (isolated) Object.defineProperty(process, 'contextIsolated', isolated)
  else Object.defineProperty(process, 'contextIsolated', { configurable: true, value: undefined })
  vi.unstubAllGlobals()
})

it('allows the Linux application lookup through the renderer and preload bridge', async () => {
  Object.defineProperty(process, 'contextIsolated', { configurable: true, value: true })
  await import('./index')
  const api = expose.mock.calls.find(([name]) => name === 'electron')?.[1]
  vi.stubGlobal('window', { electron: api })
  const info = { name: 'Browser', icon: 'data:image/png;base64,aWNvbg==' }
  invoke.mockResolvedValue(info)
  const { getAppInfo } = await import('../renderer/src/utils/ipc')
  const metadata = { processPath: '/opt/browser' } as IMihomoConnectionDetail['metadata']
  await expect(getAppInfo(metadata)).resolves.toEqual(info)
  expect(invoke).toHaveBeenCalledWith('getAppInfo', metadata)
})

it('allows custom window controls and native state through the renderer bridge', async () => {
  Object.defineProperty(process, 'contextIsolated', { configurable: true, value: true })
  await import('./index')
  const api = expose.mock.calls.find(([name]) => name === 'electron')?.[1]
  vi.stubGlobal('window', { electron: api })
  const controls = await import('../renderer/src/utils/ipc')
  const state = { maximized: true, alwaysOnTop: false, supportsAlwaysOnTop: false }
  invoke.mockResolvedValue(state)
  await expect(controls.getMainWindowState()).resolves.toEqual(state)
  expect(invoke).toHaveBeenLastCalledWith('getMainWindowState')
  await expect(controls.toggleMainWindowMaximized()).resolves.toEqual(state)
  expect(invoke).toHaveBeenLastCalledWith('toggleMainWindowMaximized')
  await controls.minimizeMainWindow()
  expect(invoke).toHaveBeenLastCalledWith('minimizeMainWindow')
  await expect(controls.setAlwaysOnTop(true)).resolves.toEqual(state)
  expect(invoke).toHaveBeenLastCalledWith('setAlwaysOnTop', true)
})

it('allows named media checks through the preload allowlist', async () => {
  Object.defineProperty(process, 'contextIsolated', { configurable: true, value: true })
  await import('./index')
  const api = expose.mock.calls.find(([name]) => name === 'electron')?.[1]
  vi.stubGlobal('window', { electron: api })
  const { checkMediaUnlockItem } = await import('../renderer/src/utils/ipc')
  const result = { name: 'Netflix', status: 'Yes', region: 'SG', check_time: '2026-10-28 12:00:00' }
  invoke.mockResolvedValue(result)
  await expect(checkMediaUnlockItem('Netflix')).resolves.toEqual(result)
  expect(invoke).toHaveBeenLastCalledWith('checkMediaUnlockItem', 'Netflix')
})
