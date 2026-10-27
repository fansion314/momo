import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  checkMihomoCorePermissions,
  grantTunPermissions,
  hasLinuxTunCapabilities,
  validateCorePath
} from './permissions'

const { execFile } = vi.hoisted(() => ({ execFile: vi.fn() }))
vi.mock('child_process', () => ({ execFile, exec: vi.fn() }))
vi.mock('electron', () => ({ app: {}, dialog: {}, ipcMain: {} }))
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
vi.mock('./admin', () => ({ checkAdminPrivileges: vi.fn() }))

beforeEach(() => {
  execFile.mockReset()
})

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
