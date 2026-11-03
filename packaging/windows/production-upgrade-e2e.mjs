import assert from 'node:assert/strict'
import { execFile, spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { tmpdir } from 'node:os'
import { promisify } from 'node:util'
import { _electron } from 'playwright'
import { parse, stringify } from 'yaml'

if (process.platform !== 'win32' || process.arch !== 'x64')
  throw new Error('Native Windows x64 required')
const execFilePromise = promisify(execFile)
const root = process.cwd()
const work = await mkdtemp(path.join(process.env.RUNNER_TEMP || tmpdir(), 'Momo 真实旧版升级 '))
const installDir = path.join(work, '正式旧版 Clash Momo 中文 安装')
const downloadDir = path.join(work, 'released-4')
const dataDir = path.join(process.env.APPDATA, 'clash-momo')
const oldTag = 'clash-momo-v2.0.4-4'
const oldName = 'clash-momo-2.0.4-4-windows-x64-setup.exe'
const pkg = JSON.parse(await readFile('package.json', 'utf8'))
const revision = Number(
  (await readFile('packaging/arch/PKGBUILD', 'utf8')).match(/^pkgrel=(\d+)$/m)[1]
)
const currentInstaller = path.join(
  root,
  'dist/release',
  `clash-momo-${pkg.version}-${revision}-windows-x64-setup.exe`
)
const ps = path.win32.join(
  process.env.SystemRoot || 'C:\\Windows',
  'System32',
  'WindowsPowerShell',
  'v1.0',
  'powershell.exe'
)
const hash = (data) => createHash('sha256').update(data).digest('hex')
const evidence = { from: oldTag, to: `clash-momo-v${pkg.version}-${revision}`, tests: [] }
let application

async function run(program, args) {
  await new Promise((resolve, reject) => {
    const child = spawn(program, args, { cwd: root, stdio: 'inherit', windowsHide: true })
    child.once('error', reject)
    child.once('exit', (code) =>
      code === 0 ? resolve() : reject(new Error(`${program} failed: ${code}`))
    )
  })
}

async function powershell(script) {
  return execFilePromise(
    ps,
    [
      '-NoProfile',
      '-NonInteractive',
      '-EncodedCommand',
      Buffer.from(script, 'utf16le').toString('base64')
    ],
    { windowsHide: true, timeout: 120000 }
  )
}

async function install(executable) {
  const payload = Buffer.from(JSON.stringify({ executable, installDir })).toString('base64')
  await powershell(
    `$ErrorActionPreference='Stop'; $p=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${payload}')) | ConvertFrom-Json; $i=Start-Process -FilePath $p.executable -ArgumentList ('/S /D=' + $p.installDir) -Wait -PassThru; if ($i.ExitCode -ne 0) { throw ('Installer failed: ' + $i.ExitCode) }`
  )
}

async function invoke(page, channel, ...args) {
  const result = await page.evaluate(
    ({ channel, args }) => window.electron.ipcRenderer.invoke(channel, ...args),
    { channel, args }
  )
  if (result?.invokeError) throw new Error(`${channel}: ${result.invokeError}`)
  return result
}

async function launch() {
  application = await _electron.launch({
    executablePath: path.join(installDir, 'Clash Momo.exe'),
    cwd: installDir,
    timeout: 45000
  })
  const page = await application.firstWindow()
  const deadline = Date.now() + 45000
  while (Date.now() < deadline) {
    const state = await invoke(page, 'trafficHistoryStatus').catch(() => undefined)
    if (state?.ready && state.healthy) return page
    await new Promise((resolve) => setTimeout(resolve, 250))
  }
  throw new Error('Production upgrade client traffic history did not become ready')
}

async function stopOwnedProcesses() {
  const encoded = Buffer.from(JSON.stringify(installDir)).toString('base64')
  await powershell(
    `$dir=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${encoded}')) | ConvertFrom-Json; Get-CimInstance Win32_Process | Where-Object { $_.ExecutablePath -and $_.ExecutablePath.StartsWith($dir + '\\', [StringComparison]::OrdinalIgnoreCase) } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }`
  )
}

try {
  await mkdir(downloadDir, { recursive: true })
  const { stdout } = await execFilePromise(
    'gh',
    ['api', `repos/fansion314/momo/releases/tags/${oldTag}`],
    { encoding: 'utf8', timeout: 30000, windowsHide: true }
  )
  const release = JSON.parse(stdout)
  assert.equal(release.draft, false)
  assert.equal(release.prerelease, false)
  await run('gh', [
    'release',
    'download',
    oldTag,
    '--repo',
    'fansion314/momo',
    '--pattern',
    oldName,
    '--pattern',
    `${oldName}.sha256`,
    '--dir',
    downloadDir
  ])
  for (const name of [oldName, `${oldName}.sha256`]) {
    const metadata = release.assets.find((asset) => asset.name === name)
    const bytes = await readFile(path.join(downloadDir, name))
    assert.equal(bytes.length, metadata.size)
    assert.equal(`sha256:${hash(bytes)}`, metadata.digest)
  }
  const oldBytes = await readFile(path.join(downloadDir, oldName))
  assert.match(
    (await readFile(path.join(downloadDir, `${oldName}.sha256`), 'utf8')).trim(),
    new RegExp(`^${hash(oldBytes)}\\s+\\*?${oldName.replaceAll('.', '\\.')}\\s*$`)
  )
  evidence.oldInstallerSha256 = hash(oldBytes)
  await install(path.join(downloadDir, oldName))
  // Exercise the unmodified, publicly released application and its own bundled
  // core, producing genuine old-code traffic-history rows before upgrading.
  await run(process.execPath, ['packaging/windows/smoke.mjs', '--installed', installDir])
  const marker = path.join(dataDir, 'production-upgrade-retain.txt')
  await writeFile(marker, 'keep real-release upgrade data')
  const profile = {
    current: 'production-upgrade',
    items: [
      {
        id: 'production-upgrade',
        type: 'local',
        name: 'Ordinary local subscription',
        autoUpdate: false
      }
    ]
  }
  const profilePath = path.join(dataDir, 'profile.yaml')
  const sourcePath = path.join(dataDir, 'profiles/production-upgrade.yaml')
  await mkdir(path.dirname(sourcePath), { recursive: true })
  await writeFile(profilePath, stringify(profile))
  await writeFile(
    sourcePath,
    stringify({ proxies: [], 'proxy-groups': [], rules: ['MATCH,DIRECT'] })
  )
  const configPath = path.join(dataDir, 'config.yaml')
  await writeFile(
    configPath,
    stringify({
      ...parse(await readFile(configPath, 'utf8')),
      windowsAutoCheckUpdate: false,
      windowsUpdateSource: 'cnb'
    })
  )
  let page = await launch()
  assert.equal((await invoke(page, 'getCurrentProfileItem')).id, 'production-upgrade')
  const historyQuery = {
    from: Date.now() - 3600000,
    to: Date.now() + 600000,
    include_internal: true
  }
  const historyBefore = await invoke(page, 'queryTrafficHistory', 'summary', historyQuery)
  assert(historyBefore.data.upload + historyBefore.data.download > 0)
  const profileHash = hash(await readFile(profilePath))
  const sourceHash = hash(await readFile(sourcePath))
  const databaseSize = (await stat(path.join(dataDir, 'work/traffic-history.db'))).size
  await application.close()
  application = undefined
  await install(currentInstaller)
  page = await launch()
  assert.equal((await invoke(page, 'windowsUpdateState')).currentRevision, revision)
  assert.equal((await invoke(page, 'getCurrentProfileItem')).id, 'production-upgrade')
  assert.equal(hash(await readFile(profilePath)), profileHash)
  assert.equal(hash(await readFile(sourcePath)), sourceHash)
  assert.equal(await readFile(marker, 'utf8'), 'keep real-release upgrade data')
  assert((await stat(path.join(dataDir, 'work/traffic-history.db'))).size >= databaseSize)
  const historyAfter = await invoke(page, 'queryTrafficHistory', 'summary', historyQuery)
  assert(
    historyAfter.data.upload + historyAfter.data.download >=
      historyBefore.data.upload + historyBefore.data.download
  )
  await application.close()
  application = undefined
  await run(process.execPath, ['packaging/windows/smoke.mjs', '--installed', installDir])
  evidence.tests.push(
    'GitHub digest and checksum verify unmodified public -4 installer',
    'actual public -4 client/core startup, proxy requests and traffic persistence',
    'manual -4 to current installer overwrite retains directory, ordinary profile, configuration and traffic history',
    'actual new client/core startup, proxy and restart after upgrade'
  )
  await mkdir(path.join(root, 'dist/validation'), { recursive: true })
  await writeFile(
    path.join(root, 'dist/validation/windows-production-upgrade.json'),
    JSON.stringify(evidence, null, 2) + '\n'
  )
  console.log(JSON.stringify(evidence, null, 2))
} finally {
  if (application) await application.close().catch(() => {})
  await stopOwnedProcesses().catch(() => {})
  const uninstaller = (await readdir(installDir).catch(() => [])).find((name) =>
    /^Uninstall.*\.exe$/.test(name)
  )
  if (uninstaller) {
    const encoded = Buffer.from(JSON.stringify(path.join(installDir, uninstaller))).toString(
      'base64'
    )
    await powershell(
      `$exe=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${encoded}')) | ConvertFrom-Json; Start-Process -FilePath $exe -ArgumentList '/S' -Wait`
    ).catch(() => {})
  }
  await cpLogs()
  await rm(work, { recursive: true, force: true })
}

async function cpLogs() {
  const { cp } = await import('node:fs/promises')
  await cp(
    path.join(dataDir, 'logs'),
    path.join(root, 'dist/validation/windows-production-upgrade-logs'),
    { recursive: true }
  ).catch(() => {})
}
