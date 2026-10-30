import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
const mocks = vi.hoisted(() => ({ request: vi.fn(), execFile: vi.fn(), transition: vi.fn() }))
vi.mock('axios', () => ({
  default: {
    request: mocks.request,
    isAxiosError: (error: { isAxiosError?: boolean }) => error.isAxiosError === true
  }
}))
vi.mock('child_process', () => ({ execFile: mocks.execFile }))
vi.mock('../utils/dirs', () => ({
  resourcesFilesDir: () => '/Applications/Clash Momo.app/Contents/Resources/files'
}))
vi.mock('../utils/logger', () => ({ managerLogger: { warn: vi.fn() } }))
vi.mock('fs/promises', () => ({ readFile: vi.fn(async () => Buffer.from('binary')) }))

beforeEach(() => {
  vi.resetModules()
  vi.useFakeTimers()
  vi.stubGlobal(
    'process',
    new Proxy(process, {
      get: (target, key) => (key === 'platform' ? 'darwin' : Reflect.get(target, key))
    })
  )
  mocks.request.mockReset()
  mocks.execFile.mockReset()
  mocks.transition.mockReset()
})
afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

describe('macOS service session', () => {
  it('never connects to or modifies the installed privileged service in an isolated test build', async () => {
    vi.stubGlobal('__TIZI_TEST_BUILD__', true)
    const service = await import('./macos-service')
    expect(await service.connectMacService()).toBe(false)
    expect(await service.macServiceStatus()).toEqual({ installed: false, compatible: false })
    await expect(service.installMacService()).rejects.toThrow('测试版')
    await expect(service.uninstallMacService()).rejects.toThrow('测试版')
    expect(mocks.request).not.toHaveBeenCalled()
    expect(mocks.execFile).not.toHaveBeenCalled()
  })
  it('keeps its token in main and renews the lease independently of renderer lifetime', async () => {
    const { createHash } = await import('crypto')
    const hash = createHash('sha256').update('binary').digest('hex')
    mocks.request.mockImplementation(async ({ url }) => ({
      data:
        url === '/v1/status'
          ? {
              protocol: 1,
              uid: process.getuid?.(),
              helperHash: hash,
              coreHash: hash,
              coreVersion: '1.19.33'
            }
          : url === '/v1/session'
            ? { token: 'private-session' }
            : { ok: true }
    }))
    const service = await import('./macos-service')
    expect(await service.connectMacService()).toBe(true)
    await vi.advanceTimersByTimeAsync(4000)
    const leases = mocks.request.mock.calls.filter(([request]) => request.url === '/v1/lease')
    expect(leases).toHaveLength(2)
    expect(leases[0][0].headers).toEqual({ 'X-Momo-Session': 'private-session' })
    service.clearMacServiceSession()
    expect(service.macServiceHeaders()).toEqual({})
    await vi.advanceTimersByTimeAsync(4000)
    expect(
      mocks.request.mock.calls.filter(([request]) => request.url === '/v1/lease')
    ).toHaveLength(2)
  })
  it('renews leases while recovering an expired session and restarting the core', async () => {
    const { createHash } = await import('crypto')
    const hash = createHash('sha256').update('binary').digest('hex')
    let sessions = 0
    let leases = 0
    mocks.request.mockImplementation(async ({ url }) => {
      if (url === '/v1/status')
        return {
          data: {
            protocol: 1,
            uid: process.getuid?.(),
            helperHash: hash,
            coreHash: hash,
            coreVersion: '1.19.33'
          }
        }
      if (url === '/v1/session') return { data: { token: `session-${++sessions}` } }
      if (url === '/v1/lease' && ++leases === 1)
        throw { isAxiosError: true, response: { status: 401 } }
      return { data: { ok: true, running: true } }
    })
    mocks.transition.mockImplementation(() => new Promise(() => {}))
    const service = await import('./macos-service')
    service.setMacServiceTransition(mocks.transition)
    await service.connectMacService()
    service.expectMacServiceCore(true)
    await vi.advanceTimersByTimeAsync(8000)
    expect(sessions).toBe(2)
    expect(leases).toBe(4)
    expect(mocks.transition).toHaveBeenCalledTimes(1)
    expect(service.macServiceHeaders()).toEqual({ 'X-Momo-Session': 'session-2' })
    service.clearMacServiceSession()
  })
  it('requires authorization again when the Formula core bytes change', async () => {
    const { createHash } = await import('crypto')
    const hash = createHash('sha256').update('binary').digest('hex')
    mocks.request.mockResolvedValue({
      data: {
        protocol: 1,
        uid: process.getuid?.(),
        helperHash: hash,
        coreHash: 'old-core-hash',
        coreVersion: '1.19.33'
      }
    })
    const service = await import('./macos-service')
    await expect(service.macServiceStatus()).resolves.toMatchObject({
      installed: true,
      compatible: false
    })
    await expect(service.connectMacService()).rejects.toThrow('needs an update')
    expect(mocks.request.mock.calls.every(([request]) => request.url === '/v1/status')).toBe(true)
  })
  it('does not stop the ordinary core when administrator authorization is cancelled', async () => {
    mocks.execFile.mockImplementation((file, _args, _opts, callback) => {
      if (file === '/usr/bin/osascript') callback(new Error('User canceled. (-128)'))
      else
        callback(null, {
          stdout: JSON.stringify({ protocol: 1, version: '1.19.33', managedMode: true }),
          stderr: ''
        })
    })
    const service = await import('./macos-service')
    service.setMacServiceTransition(mocks.transition)
    await expect(service.installMacService()).rejects.toThrow('User canceled')
    expect(mocks.transition).not.toHaveBeenCalled()
    expect(service.isMacServiceActive()).toBe(false)
    const call = mocks.execFile.mock.calls.find(([file]) => file === '/usr/bin/osascript')
    if (!call) throw new Error('Authorization invocation missing')
    const script = call[1][1]
    expect(script).toContain('install')
    expect(script).toContain('/opt/homebrew/opt/mihomomo/bin/mihomomo')
    expect(script).not.toContain('chmod')
  })
  it('rejects kernels without managed mode before requesting authorization', async () => {
    mocks.execFile.mockImplementation((_file, _args, _opts, callback) =>
      callback(null, {
        stdout: JSON.stringify({ protocol: 1, version: '1.19.32', managedMode: false }),
        stderr: ''
      })
    )
    const service = await import('./macos-service')
    await expect(service.installMacService()).rejects.toThrow('>= 1.19.33')
    expect(mocks.execFile).toHaveBeenCalledTimes(1)
  })
})
