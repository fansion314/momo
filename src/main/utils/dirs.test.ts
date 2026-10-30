import path from 'path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// dirs.ts 用 path.join 拼路径，在 Windows 上会得到反斜杠分隔符。
// 断言里不能写死 POSIX 字面量，否则整个用例只在类 Unix 平台通过。
const APP_DATA = path.join(path.sep, 'tmp', 'app-data')
const HOME = path.join(path.sep, 'tmp', 'home')
const EXE_DIR = path.join(path.sep, 'tmp', 'runtime', 'Electron.app', 'Contents', 'MacOS')
const EXE = path.join(EXE_DIR, 'Electron')

let packaged = false
let portable = false
let appName = 'mihomo-party'
let appPath = '/tmp/clash-momo'
const paths: Record<string, string> = {}
const setPath = vi.fn((name: string, value: string) => {
  paths[name] = value
})
const setName = vi.fn((value: string) => {
  appName = value
})

vi.mock('electron', () => ({
  app: {
    get isPackaged() {
      return packaged
    },
    getPath: (name: string) => paths[name],
    setPath,
    setName,
    getName: () => appName,
    getAppPath: () => appPath
  }
}))

vi.mock('fs', async (importOriginal) => {
  const original = await importOriginal<typeof import('fs')>()
  return {
    ...original,
    existsSync: (value: string) => portable && path.basename(value) === 'PORTABLE'
  }
})

vi.mock('@electron-toolkit/utils', () => ({ is: { dev: true } }))

beforeEach(() => {
  packaged = false
  appPath = '/tmp/clash-momo'
  portable = false
  appName = 'mihomo-party'
  Object.assign(paths, {
    appData: APP_DATA,
    userData: path.join(APP_DATA, 'mihomo-party'),
    home: HOME,
    exe: EXE
  })
  setPath.mockClear()
  setName.mockClear()
  vi.resetModules()
})

afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

describe('configureAppPaths', () => {
  it('isolates an unpackaged local development app', async () => {
    const { configureAppPaths } = await import('./dirs')
    configureAppPaths()

    expect(setName).toHaveBeenCalledWith('clash-momo-dev')
    expect(paths.userData).toBe(path.join(APP_DATA, 'clash-momo-dev'))
  })

  it('isolates packaged builds from upstream production paths', async () => {
    packaged = true
    const { configureAppPaths } = await import('./dirs')
    configureAppPaths()

    expect(setName).toHaveBeenCalledWith('clash-momo')
    expect(paths.userData).toBe(path.join(APP_DATA, 'clash-momo'))
  })

  it('uses production identity and resources for the system Electron directory install', async () => {
    appPath = '/usr/lib/clash-momo'
    const { configureAppPaths, resourcesDir } = await import('./dirs')
    configureAppPaths()
    expect(setName).toHaveBeenCalledWith('clash-momo')
    expect(paths.userData).toBe(path.join(APP_DATA, 'clash-momo'))
    expect(resourcesDir()).toBe('/usr/lib/clash-momo/resources')
  })

  it('resolves packaged loose macOS app resources from Contents/Resources', async () => {
    packaged = true
    appPath = '/Applications/Clash Momo.app/Contents/Resources/app'
    vi.stubGlobal(
      'process',
      new Proxy(process, {
        get: (target, key) =>
          key === 'platform'
            ? 'darwin'
            : key === 'resourcesPath'
              ? '/Applications/Clash Momo.app/Contents/Resources'
              : Reflect.get(target, key)
      })
    )
    const { resourcesDir, resourcesFilesDir } = await import('./dirs')
    expect(resourcesDir()).toBe('/Applications/Clash Momo.app/Contents/Resources')
    expect(resourcesFilesDir()).toBe('/Applications/Clash Momo.app/Contents/Resources/files')
  })

  it('resolves every legacy core choice to the sole system binary', async () => {
    const { mihomoCorePath } = await import('./dirs')
    for (const core of ['mihomo', 'mihomo-alpha', 'mihomo-smart', 'mihomo-specific', 'mihomomo']) {
      expect(mihomoCorePath(core)).toBe(
        process.platform === 'darwin'
          ? '/opt/homebrew/opt/mihomomo/bin/mihomomo'
          : '/usr/bin/mihomomo'
      )
    }
  })
})
