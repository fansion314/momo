import path from 'node:path'

function encodedCommand(script: string): string {
  return Buffer.from(script, 'utf16le').toString('base64')
}

// Start-Process joins ArgumentList before CreateProcess, so quote for Windows
// command-line parsing rather than interpolating paths into PowerShell source.
export function quoteWindowsArgument(value: string): string {
  return `"${value.replace(/(\\*)"/g, '$1$1\\"').replace(/(\\+)$/g, '$1$1')}"`
}

export function windowsElevationCommand(
  executable: string,
  args: string[],
  parentPid: number
): { program: string; args: string[] } {
  if (!Number.isSafeInteger(parentPid) || parentPid <= 0) throw new Error('Invalid parent PID')
  const payload = Buffer.from(
    JSON.stringify({ executable, arguments: args.map(quoteWindowsArgument).join(' ') }),
    'utf8'
  ).toString('base64')
  const launcher = encodedCommand(`
$ErrorActionPreference = 'Stop'
$payload = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${payload}')) | ConvertFrom-Json
if (Get-Process -Id ${parentPid} -ErrorAction SilentlyContinue) {
  Wait-Process -Id ${parentPid} -Timeout 30 -ErrorAction Stop
}
if ($payload.arguments) {
  Start-Process -FilePath $payload.executable -ArgumentList $payload.arguments -ErrorAction Stop
} else {
  Start-Process -FilePath $payload.executable -ErrorAction Stop
}
`)
  const program = path.win32.join(
    process.env.SystemRoot || 'C:\\Windows',
    'System32',
    'WindowsPowerShell',
    'v1.0',
    'powershell.exe'
  )
  const request = encodedCommand(`
$ErrorActionPreference = 'Stop'
try {
  Start-Process -FilePath ([Environment]::GetFolderPath('System') + '\\WindowsPowerShell\\v1.0\\powershell.exe') -Verb RunAs -WindowStyle Hidden -ArgumentList @('-NoProfile', '-NonInteractive', '-EncodedCommand', '${launcher}') -ErrorAction Stop | Out-Null
} catch {
  [Console]::Error.WriteLine($_.Exception.Message)
  exit 1
}
`)
  return { program, args: ['-NoProfile', '-NonInteractive', '-EncodedCommand', request] }
}
