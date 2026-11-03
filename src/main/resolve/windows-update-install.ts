import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { gzipSync } from 'node:zlib'
import { quoteWindowsArgument } from '../core/windows-elevation'
import type { WindowsUpdateAsset } from '../../shared/windows-update'

function encode(script: string): string {
  return Buffer.from(script, 'utf16le').toString('base64')
}

function compactLauncher(script: string): string {
  const payload = gzipSync(Buffer.from(script, 'utf8')).toString('base64')
  // Two nested UTF-16 encoded commands can exceed CreateProcess's 32K command
  // limit for ordinary Unicode paths. Compress only this generated fixed code.
  return encode(`
$bytes = [Convert]::FromBase64String('${payload}')
$memory = New-Object IO.MemoryStream(,$bytes)
$gzip = New-Object IO.Compression.GZipStream($memory, [IO.Compression.CompressionMode]::Decompress)
$reader = New-Object IO.StreamReader($gzip, [Text.Encoding]::UTF8)
try { & ([ScriptBlock]::Create($reader.ReadToEnd())) } finally { $reader.Dispose(); $gzip.Dispose(); $memory.Dispose() }
`)
}

export function windowsUpdateInstallCommand(
  executable: string,
  asset: WindowsUpdateAsset,
  parentPid: number,
  installDirectory: string
): { program: string; args: string[] } {
  if (
    !Number.isSafeInteger(parentPid) ||
    parentPid <= 0 ||
    !/^[a-f0-9]{64}$/.test(asset.sha256) ||
    !Number.isSafeInteger(asset.size) ||
    asset.size <= 0 ||
    !path.win32.isAbsolute(executable) ||
    !path.win32.isAbsolute(installDirectory) ||
    /["\r\n\0]/.test(installDirectory)
  )
    throw new Error('Invalid Windows update installation request')
  const payload = Buffer.from(
    JSON.stringify({
      executable,
      pipeName: `clash-momo-update-${randomUUID()}`,
      size: asset.size,
      sha256: asset.sha256,
      // NSIS consumes the final /D= argument through the end of the command line.
      arguments: `${['/S', '--updated', '--force-run'].map(quoteWindowsArgument).join(' ')} /D=${installDirectory}`
    }),
    'utf8'
  ).toString('base64')
  const launcher = compactLauncher(`
$ErrorActionPreference = 'Stop'
$payload = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${payload}')) | ConvertFrom-Json
$receiptPipe = $null
$receiptWriter = $null
$stage = Join-Path ([Environment]::GetFolderPath('CommonApplicationData')) ('ClashMomoUpdate-' + [Guid]::NewGuid().ToString('N'))
$stageCreated = $false
try {
  $receiptPipe = New-Object IO.Pipes.NamedPipeClientStream('.', $payload.pipeName, [IO.Pipes.PipeDirection]::Out)
  $receiptPipe.Connect(10000)
  $receiptWriter = New-Object IO.StreamWriter($receiptPipe)
  $receiptWriter.AutoFlush = $true
  $security = New-Object Security.AccessControl.DirectorySecurity
  $security.SetAccessRuleProtection($true, $false)
  $admins = New-Object Security.Principal.SecurityIdentifier('S-1-5-32-544')
  $system = New-Object Security.Principal.SecurityIdentifier('S-1-5-18')
  $security.SetOwner($admins)
  foreach ($identity in @($admins, $system)) {
    $rule = New-Object Security.AccessControl.FileSystemAccessRule($identity, 'FullControl', 'ContainerInherit,ObjectInherit', 'None', 'Allow')
    $security.AddAccessRule($rule)
  }
  [IO.Directory]::CreateDirectory($stage, $security) | Out-Null
  $stageCreated = $true
  $protected = Join-Path $stage 'setup.exe'
  $item = Get-Item -LiteralPath $payload.executable -ErrorAction Stop
  if (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0 -or $item.Length -ne $payload.size) { throw 'Update size or file type changed' }
  $inputFile = [IO.File]::Open($payload.executable, [IO.FileMode]::Open, [IO.FileAccess]::Read, [IO.FileShare]::Read)
  try {
    $outputFile = [IO.File]::Open($protected, [IO.FileMode]::CreateNew, [IO.FileAccess]::Write, [IO.FileShare]::None)
    try { $inputFile.CopyTo($outputFile) } finally { $outputFile.Dispose() }
  } finally { $inputFile.Dispose() }
  if ((Get-Item -LiteralPath $protected).Length -ne $payload.size) { throw 'Protected update size changed' }
  $actual = (Get-FileHash -LiteralPath $protected -Algorithm SHA256 -ErrorAction Stop).Hash.ToLowerInvariant()
  if ($actual -ne $payload.sha256) { throw 'Protected update checksum changed' }
  $receiptWriter.WriteLine('{"status":"ready"}')
  if (Get-Process -Id ${parentPid} -ErrorAction SilentlyContinue) {
    Wait-Process -Id ${parentPid} -Timeout 60 -ErrorAction Stop
  }
  $installer = Start-Process -FilePath $protected -ArgumentList $payload.arguments -Wait -PassThru -ErrorAction Stop
  if ($installer.ExitCode -ne 0) { throw ('Installer failed with code ' + $installer.ExitCode) }
} catch {
  if ($receiptWriter) { $receiptWriter.WriteLine((@{status='error'; error=$_.Exception.Message} | ConvertTo-Json -Compress)) }
  exit 1
} finally {
  if ($receiptWriter) { $receiptWriter.Dispose() }
  if ($receiptPipe) { $receiptPipe.Dispose() }
  if ($stageCreated) { Remove-Item -LiteralPath $stage -Recurse -Force -ErrorAction SilentlyContinue }
}
`)
  const request = compactLauncher(`
$ErrorActionPreference = 'Stop'
$payload = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${payload}')) | ConvertFrom-Json
$receiptPipe = New-Object IO.Pipes.NamedPipeServerStream($payload.pipeName, [IO.Pipes.PipeDirection]::In, 1, [IO.Pipes.PipeTransmissionMode]::Byte, [IO.Pipes.PipeOptions]::Asynchronous)
try {
  Start-Process -FilePath ([Environment]::GetFolderPath('System') + '\\WindowsPowerShell\\v1.0\\powershell.exe') -Verb RunAs -WindowStyle Hidden -ArgumentList @('-NoProfile', '-NonInteractive', '-EncodedCommand', '${launcher}') -ErrorAction Stop | Out-Null
  $wait = $receiptPipe.BeginWaitForConnection($null, $null)
  if (!$wait.AsyncWaitHandle.WaitOne(45000)) { throw 'Timed out preparing the protected Windows update' }
  $receiptPipe.EndWaitForConnection($wait)
  $reader = New-Object IO.StreamReader($receiptPipe)
  $line = $reader.ReadLineAsync()
  if (!$line.Wait(45000)) { throw 'Timed out verifying the protected Windows update' }
  $receipt = $line.Result | ConvertFrom-Json
  if ($receipt.status -ne 'ready') { throw $receipt.error }
} catch {
  [Console]::Error.WriteLine($_.Exception.Message)
  exit 1
} finally {
  $receiptPipe.Dispose()
}
`)
  return {
    program: path.win32.join(
      process.env.SystemRoot || 'C:\\Windows',
      'System32',
      'WindowsPowerShell',
      'v1.0',
      'powershell.exe'
    ),
    args: ['-NoProfile', '-NonInteractive', '-EncodedCommand', request]
  }
}
