import { describe, expect, it } from 'vitest'
import { quoteWindowsArgument, windowsElevationCommand } from './windows-elevation'

describe('Windows elevation command arguments', () => {
  it('quotes paths, embedded quotes and trailing directory separators', () => {
    expect(quoteWindowsArgument('')).toBe('""')
    expect(quoteWindowsArgument('D:\\中文 目录\\')).toBe('"D:\\中文 目录\\\\"')
    expect(quoteWindowsArgument('a"b')).toBe('"a\\"b"')
    expect(quoteWindowsArgument('a\\"b')).toBe('"a\\\\\\"b"')
  })

  it('keeps arbitrary executable and argument text out of PowerShell source', () => {
    const executable = "D:\\中文 O'Brien $()\\Clash Momo.exe"
    const value = '"; Stop-Process -Id 123; #'
    const command = windowsElevationCommand(executable, [value], 12345)
    const request = Buffer.from(command.args.at(-1) || '', 'base64').toString('utf16le')
    expect(request).not.toContain(executable)
    expect(request).not.toContain(value)
    expect(request).toContain('-Verb RunAs')
    const launcherEncoding = request.match(/'-EncodedCommand', '([A-Za-z0-9+/=]+)'/)?.[1]
    expect(launcherEncoding).toBeTruthy()
    const launcher = Buffer.from(launcherEncoding || '', 'base64').toString('utf16le')
    expect(launcher).toContain('Wait-Process -Id 12345 -Timeout 30')
    expect(launcher).not.toContain(executable)
    const payloadEncoding = launcher.match(/FromBase64String\('([A-Za-z0-9+/=]+)'\)/)?.[1]
    expect(payloadEncoding).toBeTruthy()
    const payload = JSON.parse(Buffer.from(payloadEncoding || '', 'base64').toString('utf8'))
    expect(payload.executable).toBe(executable)
    expect(payload.arguments).toBe(quoteWindowsArgument(value))
  })
})
