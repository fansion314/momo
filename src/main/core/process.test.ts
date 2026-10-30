import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { cleanupWindowsNamedPipes, waitForCoreReady } from './process'
import { getAxios } from './mihomoApi'

const mocks = vi.hoisted(() => ({
  execFile: vi.fn()
}))

vi.mock('child_process', () => ({
  execFile: mocks.execFile
}))

vi.mock('../utils/dirs', () => ({
  mihomoCoreDir: () => 'C:\\Program Files\\Clash Momo\\resources\\sidecar'
}))

vi.mock('../utils/logger', () => ({
  managerLogger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() }
}))

vi.mock('./mihomoApi', () => ({
  getAxios: vi.fn()
}))

describe('silent managed core readiness', () => {
  it('waits for real managed outbounds rather than an early API greeting or default GLOBAL group', async () => {
    vi.useFakeTimers()
    let snapshots = 0
    const get = vi.fn(async (endpoint: string) => {
      if (endpoint !== '/proxies') return {}
      snapshots++
      return {
        proxies:
          snapshots === 1
            ? {
                DIRECT: { type: 'Direct' },
                GLOBAL: { type: 'Selector' },
                'PASS-RULE': { type: 'PassRule' }
              }
            : { managed: { type: 'VLESS' } }
      }
    })
    vi.mocked(getAxios).mockResolvedValue({ get } as unknown as Awaited<
      ReturnType<typeof getAxios>
    >)
    try {
      const ready = waitForCoreReady(1000, true)
      await vi.advanceTimersByTimeAsync(100)
      await ready
      expect(snapshots).toBe(2)
      expect(get).toHaveBeenCalledWith('/configs')
    } finally {
      vi.useRealTimers()
    }
  })
})

const tasklistOutput = [
  '"MihomoTray.exe","1001","Console","1","10,000 K"',
  '"mihomomo.exe","1002","Console","1","20,000 K"',
  '"mihomomo.exe","1003","Console","1","20,000 K"',
  '"mihomo-smart.exe","1004","Console","1","20,000 K"',
  '"mihomo.exe","1005","Console","1","20,000 K"',
  '"mihomomo.exe","1006","Services","0","20,000 K"'
].join('\r\n')

function mockExecFile(processInfo: unknown, powershellError?: Error): void {
  mocks.execFile.mockImplementation(
    (file: string, _args: string[], _options: unknown, callback) => {
      if (file === 'tasklist') {
        callback(null, { stdout: tasklistOutput, stderr: '' })
      } else if (powershellError) {
        callback(powershellError)
      } else {
        callback(null, { stdout: JSON.stringify(processInfo), stderr: '' })
      }
    }
  )
}

describe('cleanupWindowsNamedPipes', () => {
  let killSpy: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
    vi.clearAllMocks()
    killSpy = vi.spyOn(process, 'kill').mockImplementation(() => true)
  })

  afterEach(() => {
    killSpy.mockRestore()
  })

  function terminatedPids(): number[] {
    return killSpy.mock.calls
      .filter(([, signal]) => signal === 'SIGTERM')
      .map(([pid]) => pid as number)
  }

  it('only terminates this client core and preserves original Mihomo executables', async () => {
    mockExecFile([
      { Id: 1002, Path: 'C:\\Program Files\\Clash Momo\\resources\\sidecar\\mihomomo.exe' },
      { Id: 1003, Path: 'D:\\tools\\mihomo\\mihomomo.exe' },
      { Id: 1004, Path: 'c:\\program files\\clash momo\\resources\\sidecar\\MIHOMO-SMART.EXE' },
      { Id: 1006, Path: null }
    ])

    await cleanupWindowsNamedPipes()

    expect(terminatedPids()).toEqual([1002, 1006])
    const powershellArgs = mocks.execFile.mock.calls.find(([file]) => file === 'powershell')?.[1]
    expect(powershellArgs?.join(' ')).toContain('Get-Process -Id 1002,1003,1006')
  })

  it('skips process inspection when no core executable is running', async () => {
    mocks.execFile.mockImplementation(
      (_file: string, _args: string[], _options: unknown, callback) =>
        callback(null, { stdout: '"MihomoTray.exe","1001","Console","1","10,000 K"', stderr: '' })
    )

    await cleanupWindowsNamedPipes(true)

    expect(mocks.execFile).toHaveBeenCalledTimes(1)
    expect(terminatedPids()).toEqual([])
  })

  it('falls back to exact executable names when paths cannot be inspected', async () => {
    mockExecFile(null, new Error('powershell unavailable'))

    await cleanupWindowsNamedPipes()

    expect(terminatedPids()).toEqual([1002, 1003, 1006])
  })
})
