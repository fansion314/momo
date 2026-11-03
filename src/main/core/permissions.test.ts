import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  checkMihomoCorePermissions,
  grantTunPermissions,
  hasLinuxTunCapabilities,
  restartAsAdmin,
  setStopCoreBeforeAdminRestart,
  validateCorePath
} from './permissions'

const { execFile, exit, checkAdmin, exists } = vi.hoisted(() => ({
  execFile: vi.fn(),
  exit: vi.fn(),
  checkAdmin: vi.fn(),
  exists: vi.fn(() => true)
}))
vi.mock('child_process', () => ({ execFile, exec: vi.fn() }))
vi.mock('electron', () => ({ app: { exit }, dialog: {}, ipcMain: {} }))
vi.mock('fs', async (importOriginal) => ({
  ...(await importOriginal<typeof import('fs')>()),
  existsSync: exists
}))
vi.mock('../config', () => ({
  getControledMihomoConfig: vi.fn(),
  patchControledMihomoConfig: vi.fn()
}))
vi.mock('../utils/dirs', () => ({ mihomoCorePath: () => '/usr/bin/mihomomo' }))
vi.mock('../utils/logger', () => ({
  managerLogger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() }
}))
vi.mock('../sys/autoRun', () => ({ checkAutoRun: vi.fn(), enableAutoRun: vi.fn() }))
vi.mock('../../shared/i18n', () => ({ default: { t: (key: string) => key } }))
vi.mock('./admin', () => ({ checkAdminPrivileges: checkAdmin }))

beforeEach(() => {
  vi.stubGlobal(
    'process',
    new Proxy(process, {
      get: (target, key) => (key === 'platform' ? 'linux' : Reflect.get(target, key))
    })
  )
  execFile.mockReset()
  exit.mockReset()
  checkAdmin.mockReset()
  exists.mockReturnValue(true)
  setStopCoreBeforeAdminRestart(null)
})

describe('Windows permissions and administrator restart', () => {
  beforeEach(() => {
    vi.stubGlobal(
      'process',
      new Proxy(process, {
        get: (target, key) => (key === 'platform' ? 'win32' : Reflect.get(target, key))
      })
    )
  })

  it('checks Windows token elevation without invoking getcap', async () => {
    checkAdmin.mockResolvedValue(true)
    expect(await checkMihomoCorePermissions()).toBe(true)
    checkAdmin.mockResolvedValue(false)
    expect(await checkMihomoCorePermissions()).toBe(false)
    expect(execFile).not.toHaveBeenCalled()
  })

  it('keeps the running client and core when UAC is cancelled', async () => {
    const stop = vi.fn()
    setStopCoreBeforeAdminRestart(stop)
    execFile.mockImplementation((_file, _args, _options, callback) =>
      callback(new Error('The operation was canceled by the user'))
    )
    await expect(restartAsAdmin()).rejects.toThrow('canceled')
    expect(stop).not.toHaveBeenCalled()
    expect(exit).not.toHaveBeenCalled()
  })

  it('stops the old core and exits only after elevation is accepted', async () => {
    const events: string[] = []
    const stop = vi.fn(async () => {
      events.push('stop')
    })
    setStopCoreBeforeAdminRestart(stop)
    execFile.mockImplementation((_file, _args, _options, callback) => {
      events.push('authorized')
      callback(null, { stdout: '', stderr: '' })
    })
    exit.mockImplementation(() => {
      events.push('exit')
    })
    await restartAsAdmin()
    expect(events).toEqual(['authorized', 'stop', 'exit'])
    expect(stop).toHaveBeenCalledWith(true)
    expect(execFile.mock.calls[0][1]).toContain('-EncodedCommand')
  })
})

afterEach(() => vi.unstubAllGlobals())

describe('system kernel capabilities', () => {
  it('requires effective and permitted capabilities on the exact installed binary', () => {
    expect(
      hasLinuxTunCapabilities(
        '/usr/bin/mihomomo cap_net_bind_service,cap_net_admin,cap_net_raw=ep\n'
      )
    ).toBe(true)
    expect(
      hasLinuxTunCapabilities(
        '/usr/bin/mihomomo cap_net_raw=ep cap_net_admin,cap_net_bind_service=eip'
      )
    ).toBe(true)
    for (const output of [
      '/usr/bin/mihomomo cap_net_admin,cap_net_raw=ep',
      '/usr/bin/mihomomo cap_net_admin,cap_net_raw,cap_net_bind_service=p',
      '/usr/bin/mihomo cap_net_admin,cap_net_raw,cap_net_bind_service=ep',
      ''
    ])
      expect(hasLinuxTunCapabilities(output)).toBe(false)
  })

  it('uses getcap and reports pacman repair without any privilege mutation', async () => {
    execFile.mockImplementation((_file, _args, _options, callback) =>
      callback(null, { stdout: '', stderr: '' })
    )
    expect(await checkMihomoCorePermissions()).toBe(false)
    await expect(grantTunPermissions()).rejects.toThrow('sudo pacman -S mihomomo')
    expect(
      execFile.mock.calls.every(
        ([file, args]) => file === '/usr/bin/getcap' && args[0] === '/usr/bin/mihomomo'
      )
    ).toBe(true)
  })

  it('accepts the kernel package capability installation', async () => {
    execFile.mockImplementation((_file, _args, _options, callback) =>
      callback(null, {
        stdout: '/usr/bin/mihomomo cap_net_bind_service,cap_net_admin,cap_net_raw=ep',
        stderr: ''
      })
    )
    expect(await checkMihomoCorePermissions()).toBe(true)
    await expect(grantTunPermissions()).resolves.toBeUndefined()
  })

  it('rejects alternate and traversal core paths', () => {
    expect(() => validateCorePath('/usr/bin/mihomomo')).not.toThrow()
    for (const path of ['/usr/bin/mihomo', '/tmp/mihomomo', '/usr/bin/../bin/mihomomo']) {
      expect(() => validateCorePath(path)).toThrow()
    }
  })
})
