$ErrorActionPreference = 'Stop'
$PSNativeCommandUseErrorActionPreference = $true
if ($env:PROCESSOR_ARCHITECTURE -ne 'AMD64') { throw 'Windows x64 required' }
pnpm install --frozen-lockfile --ignore-scripts
pnpm --package=vite-plus@1.4.0 dlx vp exec vitest run src/main/utils/dirs.test.ts src/main/core/admin.test.ts src/main/core/permissions.test.ts src/main/core/windows-elevation.test.ts
if ($LASTEXITCODE) { throw 'Windows runtime unit checks failed' }
node node_modules/electron/install.js
node scripts/prepare.mjs
pnpm --package=vite-plus@1.4.0 dlx vp run build:windows
if ($LASTEXITCODE) { throw 'Windows packaging failed' }
node packaging/windows/smoke.mjs
if ($LASTEXITCODE) { throw 'Windows runtime verification failed' }
$installer = Get-Item dist/release/*-windows-x64-setup.exe
$installDir = Join-Path $env:RUNNER_TEMP 'Clash Momo 安装 验收'
$dataDir = Join-Path $env:APPDATA 'clash-momo'
if (Test-Path $installDir) { throw 'Reserved test installation already exists' }
try {
  $process = Start-Process -FilePath $installer.FullName -ArgumentList "/S /D=$installDir" -Wait -PassThru
  if ($process.ExitCode) { throw 'NSIS installation failed' }
  node packaging/windows/smoke.mjs --installed $installDir
  if ($LASTEXITCODE) { throw 'Installed application verification failed' }
  # Reinstall into the same directory: user data and bundled core must survive.
  $marker = Join-Path $dataDir 'ci-retain-data.txt'
  Set-Content -LiteralPath $marker -Value 'preserve on reinstall and uninstall'
  $process = Start-Process -FilePath $installer.FullName -ArgumentList "/S /D=$installDir" -Wait -PassThru
  if ($process.ExitCode -or !(Test-Path $marker)) { throw 'Reinstall lost user data' }
  $uninstaller = Get-ChildItem -LiteralPath $installDir -Filter 'Uninstall*.exe' | Select-Object -First 1
  if (!$uninstaller) { throw 'NSIS uninstaller missing' }
  $process = Start-Process -FilePath $uninstaller.FullName -ArgumentList '/S' -Wait -PassThru
  if ($process.ExitCode -or !(Test-Path $marker)) { throw 'Uninstall lost user data' }
  # NSIS copies itself before uninstalling; wait for its child to remove the executable.
  $deadline = (Get-Date).AddSeconds(30)
  while ((Test-Path (Join-Path $installDir 'Clash Momo.exe')) -and (Get-Date) -lt $deadline) { Start-Sleep -Milliseconds 250 }
  if (Test-Path (Join-Path $installDir 'Clash Momo.exe')) { throw 'Uninstall did not remove application' }
} finally {
  Get-CimInstance Win32_Process | Where-Object { $_.ExecutablePath -and $_.ExecutablePath.StartsWith($installDir, [System.StringComparison]::OrdinalIgnoreCase) } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
  Remove-Item -LiteralPath $installDir -Recurse -Force -ErrorAction SilentlyContinue
}
Write-Host 'Native Windows install, reinstall, uninstall, portable and bundled-core verification passed.'
Write-Host 'Interactive UAC acceptance/cancellation requires a desktop test; an elevated CI runner does not cover that interaction.'
