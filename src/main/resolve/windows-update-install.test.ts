import { gunzipSync } from 'node:zlib'
import { describe, expect, it } from 'vitest'
import { windowsUpdateInstallCommand } from './windows-update-install'

function decodeGeneratedCommand(encoded: string): string {
  const loader = Buffer.from(encoded, 'base64').toString('utf16le')
  const compressed = loader.match(/FromBase64String\('([A-Za-z0-9+/=]+)'\)/)?.[1]
  return gunzipSync(Buffer.from(compressed || '', 'base64')).toString('utf8')
}

describe('Windows update elevation launcher', () => {
  it('keeps Chinese, space, quote and PowerShell metacharacters in encoded data and waits for graceful exit', () => {
    const executable = "D:\\中文 O'Brien $()\\Clash Momo setup.exe"
    const command = windowsUpdateInstallCommand(
      executable,
      { name: 'setup.exe', size: 123, sha256: 'a'.repeat(64) },
      1234,
      'D:\\中文 目录\\Clash Momo'
    )
    const request = decodeGeneratedCommand(command.args.at(-1) || '')
    expect(request).not.toContain(executable)
    expect(request).toContain('-Verb RunAs')
    const compressed = [...request.matchAll(/Launcher-Arguments '([A-Za-z0-9+/=]+)'/g)]
    const launcher = gunzipSync(Buffer.from(compressed[0]?.[1] || '', 'base64')).toString('utf8')
    expect(command.args.join(' ').length).toBeLessThan(20000)
    expect(launcher).toContain('Wait-Process -Id 1234 -Timeout 60')
    expect(launcher).toContain('[Security.Cryptography.SHA256]::Create()')
    expect(launcher).toContain('SetAccessRuleProtection($true, $false)')
    expect(launcher).toContain("'S-1-5-32-544'")
    expect(launcher).toContain('[IO.FileMode]::CreateNew')
    expect(launcher).toContain("Notify-UpdateCompletion 'installed'")
    expect(launcher).toContain("Notify-UpdateCompletion 'error'")
    expect(launcher).toContain('$installer.WaitForExit(300000)')
    expect(launcher).toContain('$installer.Kill()')
    expect(launcher.indexOf('ComputeHash')).toBeLessThan(launcher.indexOf('\'{"status":"ready"}\''))
    expect(launcher).not.toContain(executable)
    const payload = launcher.match(/FromBase64String\('([A-Za-z0-9+/=]+)'\)/)?.[1]
    expect(JSON.parse(Buffer.from(payload || '', 'base64').toString('utf8'))).toMatchObject({
      executable,
      size: 123,
      sha256: 'a'.repeat(64),
      arguments: '"/S" "--updated" /D=D:\\中文 目录\\Clash Momo',
      application: 'D:\\中文 目录\\Clash Momo\\Clash Momo.exe'
    })
    const restarter = gunzipSync(Buffer.from(compressed[1]?.[1] || '', 'base64')).toString('utf8')
    expect(restarter).not.toContain('-Verb RunAs')
    expect(restarter).toContain("$result.status -ne 'installed'")
    expect(restarter).toContain('$wait.AsyncWaitHandle.WaitOne(480000)')
    expect(restarter).toContain('Start-Process -FilePath $payload.application')
    expect(request.indexOf("$receipt.status -ne 'ready'")).toBeLessThan(
      request.indexOf('$waiter = Start-Process')
    )
    expect(request).toContain('Stop-Process -Id $waiter.Id')
  })

  it('rejects invalid process and integrity metadata', () => {
    expect(() =>
      windowsUpdateInstallCommand(
        'setup.exe',
        { name: 'setup.exe', size: 123, sha256: 'x' },
        1234,
        'C:\\App'
      )
    ).toThrow()
    expect(() =>
      windowsUpdateInstallCommand(
        'setup.exe',
        { name: 'setup.exe', size: 123, sha256: 'a'.repeat(64) },
        0,
        'C:\\App'
      )
    ).toThrow()
  })
})
