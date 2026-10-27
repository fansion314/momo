import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { cleanupWindowsNamedPipes } from './process'

const mocks = vi.hoisted(() => ({
  execFile: vi.fn()
}))

vi.mock('child_process', () => ({
  execFile: mocks.execFile
}))

vi.mock('../utils/dirs', () => ({
  mihomoCoreDir: () => 'C:\\Program Files\\Clash Party\\resources\\sidecar'
}))

vi.mock('../utils/logger', () => ({
  managerLogger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() }
}))

vi.mock('./mihomoApi', () => ({
  getAxios: vi.fn()
}))

const tasklistOutput = [
  '"MihomoTray.exe","1001","Console","1","10,000 K"',
  '"mihomo.exe","1002","Console","1","20,000 K"',
  '"mihomo.exe","1003","Console","1","20,000 K"',
  '"Mihomo-Smart.exe","1004","Console","1","20,000 K"',
  '"mihomo-helper.exe","1005","Console","1","20,000 K"',
  '"mihomo.exe","1006","Services","0","20,000 K"'
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

  it('only terminates bundled core executables', async () => {
    mockExecFile([
      { Id: 1002, Path: 'C:\\Program Files\\Clash Party\\resources\\sidecar\\mihomo.exe' },
      { Id: 1003, Path: 'D:\\tools\\mihomo\\mihomo.exe' },
      { Id: 1004, Path: 'c:\\program files\\clash party\\resources\\sidecar\\MIHOMO-SMART.EXE' },
      { Id: 1006, Path: null }
    ])

    await cleanupWindowsNamedPipes()

    expect(terminatedPids()).toEqual([1002, 1004, 1006])
    const powershellArgs = mocks.execFile.mock.calls.find(([file]) => file === 'powershell')?.[1]
    expect(powershellArgs?.join(' ')).toContain('Get-Process -Id 1002,1003,1004,1006')
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

    expect(terminatedPids()).toEqual([1002, 1003, 1004, 1006])
  })
})
