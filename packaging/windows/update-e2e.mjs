import assert from 'node:assert/strict'
import { execFile, spawn } from 'node:child_process'
import { createHash, generateKeyPairSync, sign } from 'node:crypto'
import { createServer } from 'node:https'
import {
  cp,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  stat,
  symlink,
  writeFile
} from 'node:fs/promises'
import path from 'node:path'
import { tmpdir } from 'node:os'
import { promisify } from 'node:util'
import { _electron } from 'playwright'
import { parse, stringify } from 'yaml'

if (process.platform !== 'win32' || process.arch !== 'x64')
  throw new Error('Native Windows x64 required for update acceptance')
const execFilePromise = promisify(execFile)
const root = process.cwd()
const work = await mkdtemp(path.join(process.env.RUNNER_TEMP || tmpdir(), 'Momo Windows 更新 '))
const source = path.join(work, 'fixture-source')
const installDir = path.join(work, "中文 O'Brien $() Clash Momo 安装目录")
const portableDir = path.join(work, 'fixture-source/dist/windows/win-unpacked')
const dataDir = path.join(process.env.APPDATA, 'clash-momo')
const pkg = JSON.parse(await readFile('package.json', 'utf8'))
const revision = Number(
  (await readFile('packaging/arch/PKGBUILD', 'utf8')).match(/^pkgrel=(\d+)$/m)[1]
)
assert.equal(revision, 5, 'This acceptance fixture exercises package revision 4 -> 5')
const stem = `clash-momo-${pkg.version}-${revision}-windows-x64`
const installerPath = path.join(root, 'dist/release', `${stem}-setup.exe`)
const portablePath = path.join(root, 'dist/release', `${stem}-portable.zip`)
const packageManifest = JSON.parse(
  await readFile(path.join(root, 'dist/release', `${stem}-manifest.json`), 'utf8')
)
const tag = `clash-momo-v${pkg.version}-${revision}`
const hash = (bytes) => createHash('sha256').update(bytes).digest('hex')
const installerBytes = await readFile(installerPath)
const portableBytes = await readFile(portablePath)
const pair = generateKeyPairSync('ed25519')
const keyId = 'windows-acceptance-fixture'
const publicKey = pair.publicKey.export({ format: 'der', type: 'spki' }).toString('base64')
const payload = Buffer.from(
  JSON.stringify({
    schema: 1,
    product: 'clash-momo',
    platform: 'win32',
    arch: 'x64',
    tag,
    version: pkg.version,
    revision,
    publishedAt: new Date().toISOString(),
    changelog: 'Controlled Windows update acceptance fixture.',
    sourceCommit: packageManifest.source_commit,
    core: {
      tag: packageManifest.core.tag,
      sha256: packageManifest.core.core_sha256,
      sourceCommit: packageManifest.core.source_commit
    },
    assets: {
      installer: {
        name: path.basename(installerPath),
        size: installerBytes.length,
        sha256: hash(installerBytes)
      },
      portable: {
        name: path.basename(portablePath),
        size: portableBytes.length,
        sha256: hash(portableBytes)
      }
    }
  })
)
const envelope = {
  schema: 1,
  keyId,
  payload: payload.toString('base64'),
  signature: sign(null, payload, pair.privateKey).toString('base64')
}
let corruptSignature = false
let corruptDownload = false
let assetRequests = 0
let application
let fixtureServer
const windowsPowerShell = path.win32.join(
  process.env.SystemRoot || 'C:\\Windows',
  'System32',
  'WindowsPowerShell',
  'v1.0',
  'powershell.exe'
)
const evidence = {
  from: `${pkg.version}-4`,
  to: `${pkg.version}-${revision}`,
  productionSource: packageManifest.source_commit,
  tests: [],
  interactiveUac: 'not covered: elevated CI runner'
}

async function run(program, args, cwd = root) {
  await new Promise((resolve, reject) => {
    const child = spawn(program, args, {
      cwd,
      stdio: 'inherit',
      windowsHide: true,
      env: { ...process.env, CSC_IDENTITY_AUTO_DISCOVERY: 'false' }
    })
    child.once('error', reject)
    child.once('exit', (code) =>
      code === 0 ? resolve() : reject(new Error(`${program} exited ${code}`))
    )
  })
}

async function powerShell(script) {
  return execFilePromise(
    windowsPowerShell,
    [
      '-NoProfile',
      '-NonInteractive',
      '-EncodedCommand',
      Buffer.from(script, 'utf16le').toString('base64')
    ],
    { windowsHide: true, timeout: 120000 }
  )
}

async function waitFor(read, predicate, description, timeout = 60000) {
  const deadline = Date.now() + timeout
  let last
  while (Date.now() < deadline) {
    try {
      last = await read()
      if (predicate(last)) return last
    } catch (error) {
      last = String(error)
    }
    await new Promise((resolve) => setTimeout(resolve, 250))
  }
  throw new Error(`${description}: ${JSON.stringify(last)}`)
}

async function invoke(page, channel, ...args) {
  const result = await page.evaluate(
    ({ name, args }) => window.electron.ipcRenderer.invoke(name, ...args),
    { name: channel, args }
  )
  if (result?.invokeError) throw new Error(`${channel}: ${result.invokeError}`)
  return result
}

async function attachFixture(executable, sourceName = 'cnb') {
  application = await _electron.launch({
    executablePath: executable,
    cwd: path.dirname(executable),
    timeout: 45000
  })
  const page = await application.firstWindow()
  await application.evaluate(
    ({ session, dialog }, { base, sourceName, savePath }) => {
      const updates = session.fromPartition('windows-updates', { cache: false })
      updates.setCertificateVerifyProc((request, callback) =>
        callback(request.hostname === '127.0.0.1' ? 0 : -3)
      )
      updates.webRequest.onBeforeRequest(
        {
          urls: [
            'https://cnb.cool/fansionia/packages/*',
            'https://api.github.com/repos/fansion314/momo/releases*',
            'https://github.com/fansion314/momo/releases/download/*'
          ]
        },
        (request, callback) =>
          callback({ redirectURL: `${base}/fixture?original=${encodeURIComponent(request.url)}` })
      )
      globalThis.__momoUpdateConfirmation = 1
      globalThis.__momoUpdateDialogCalls = 0
      dialog.showMessageBox = async () => {
        globalThis.__momoUpdateDialogCalls++
        return { response: globalThis.__momoUpdateConfirmation, checkboxChecked: false }
      }
      dialog.showSaveDialog = async () => ({ canceled: false, filePath: savePath })
      globalThis.__momoUpdateSourceName = sourceName
    },
    {
      base: `https://127.0.0.1:${fixtureServer.address().port}`,
      sourceName,
      savePath: path.join(work, 'downloaded-portable.zip')
    }
  )
  await waitFor(
    () => invoke(page, 'windowsUpdateState'),
    (value) => value.currentRevision === 4,
    'Fixture revision'
  )
  return page
}

async function scopedProcesses(stop = false) {
  const encoded = Buffer.from(JSON.stringify(installDir)).toString('base64')
  const script = `$dir=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${encoded}')) | ConvertFrom-Json; $items=@(Get-CimInstance Win32_Process | Where-Object { $_.ExecutablePath -and $_.ExecutablePath.StartsWith($dir + '\\', [StringComparison]::OrdinalIgnoreCase) }); ${stop ? '$items | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue };' : ''} [Console]::OutputEncoding=[Text.UTF8Encoding]::new($false); ConvertTo-Json -InputObject @($items | Select-Object ExecutablePath,ProcessId) -Compress`
  return JSON.parse((await powerShell(script)).stdout || '[]')
}

try {
  await mkdir(source, { recursive: true })
  for (const name of [
    'src',
    'resources',
    'extra',
    'build',
    'packaging',
    'electron-builder.windows.cjs',
    'electron.vite.config.ts',
    'package.json',
    'pnpm-lock.yaml',
    'pnpm-workspace.yaml',
    'tsconfig.json',
    'tsconfig.node.json',
    'tsconfig.web.json',
    'LICENSE'
  ]) {
    await cp(path.join(root, name), path.join(source, name), {
      recursive: true,
      filter: (file) =>
        !file
          .split(path.sep)
          .some((part) => ['target', '.git', 'node_modules', '.cache'].includes(part))
    })
  }
  await symlink(path.join(root, 'node_modules'), path.join(source, 'node_modules'), 'junction')
  await writeFile(
    path.join(source, 'src/shared/windows-update-keys.json'),
    JSON.stringify({ [keyId]: publicKey })
  )
  const recipe = path.join(source, 'packaging/arch/PKGBUILD')
  await writeFile(recipe, (await readFile(recipe, 'utf8')).replace(/^pkgrel=\d+$/m, 'pkgrel=4'))
  await run(
    process.execPath,
    [path.join(root, 'node_modules/electron-vite/bin/electron-vite.js'), 'build'],
    source
  )
  await run(
    process.execPath,
    [
      path.join(root, 'node_modules/electron-builder/cli.js'),
      '--win',
      '--x64',
      '--config',
      'electron-builder.windows.cjs'
    ],
    source
  )

  const openssl = path.join(
    process.env.ProgramFiles || 'C:\\Program Files',
    'Git',
    'usr',
    'bin',
    'openssl.exe'
  )
  const tlsKey = path.join(work, 'tls-key.pem')
  const tlsCertificate = path.join(work, 'tls-cert.pem')
  await execFilePromise(
    openssl,
    [
      'req',
      '-x509',
      '-newkey',
      'rsa:2048',
      '-nodes',
      '-keyout',
      tlsKey,
      '-out',
      tlsCertificate,
      '-days',
      '1',
      '-subj',
      '/CN=localhost',
      '-addext',
      'subjectAltName=IP:127.0.0.1,DNS:localhost'
    ],
    { timeout: 30000, windowsHide: true, env: { ...process.env, MSYS_NO_PATHCONV: '1' } }
  )
  fixtureServer = createServer(
    { key: await readFile(tlsKey), cert: await readFile(tlsCertificate) },
    (request, response) => {
      const original =
        new URL(request.url, 'https://fixture.test').searchParams.get('original') || ''
      if (original.startsWith('https://api.github.com/repos/fansion314/momo/releases?')) {
        response.setHeader('content-type', 'application/json')
        response.end(
          JSON.stringify([
            { tag_name: 'mihomomo-v99.0.0-1', draft: false, prerelease: false, assets: [] },
            {
              tag_name: tag,
              draft: false,
              prerelease: false,
              assets: [{ name: 'clash-momo-windows-x64-update.json' }]
            }
          ])
        )
      } else if (
        original.endsWith('/latest.json') ||
        original.endsWith('/clash-momo-windows-x64-update.json')
      ) {
        response.setHeader('content-type', 'application/json')
        response.end(
          JSON.stringify(
            corruptSignature
              ? { ...envelope, signature: Buffer.alloc(64).toString('base64') }
              : envelope
          )
        )
      } else if (original.endsWith('-setup.exe') || original.endsWith('-portable.zip')) {
        assetRequests++
        const bytes = original.endsWith('-setup.exe') ? installerBytes : portableBytes
        response.setHeader('content-length', bytes.length)
        response.end(corruptDownload ? Buffer.alloc(bytes.length) : bytes)
      } else {
        response.writeHead(404)
        response.end()
      }
    }
  )
  await new Promise((resolve) => fixtureServer.listen(0, '127.0.0.1', resolve))

  const configPath = path.join(dataDir, 'config.yaml')
  const config = parse(await readFile(configPath, 'utf8'))
  await writeFile(
    configPath,
    stringify({
      ...config,
      windowsAutoCheckUpdate: false,
      windowsUpdateSource: 'cnb',
      sysProxy: { enable: false }
    })
  )
  const fixtureInstaller = path.join(
    source,
    'dist/windows',
    `clash-momo-${pkg.version}-4-windows-x64-setup.exe`
  )
  const encodedInstall = Buffer.from(
    JSON.stringify({ installer: fixtureInstaller, directory: installDir })
  ).toString('base64')
  await powerShell(
    `$p=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${encodedInstall}')) | ConvertFrom-Json; $process=Start-Process -FilePath $p.installer -ArgumentList ('/S /D=' + $p.directory) -Wait -PassThru; if ($process.ExitCode) { throw 'Fixture installation failed' }`
  )
  const marker = path.join(dataDir, 'update-e2e-retain-data.txt')
  await writeFile(marker, 'preserve through application update')
  const historyPath = path.join(dataDir, 'work/traffic-history.db')
  const historySize = (await stat(historyPath)).size
  let page = await attachFixture(path.join(installDir, 'Clash Momo.exe'))
  await waitFor(
    () => invoke(page, 'trafficHistoryStatus'),
    (value) => value.ready && value.healthy,
    'Old-client history readiness'
  )
  const historyQuery = {
    from: Date.now() - 3600000,
    to: Date.now() + 600000,
    include_internal: true
  }
  const historyBefore = await invoke(page, 'queryTrafficHistory', 'summary', historyQuery)
  const ordinaryProfiles = hash(await readFile(path.join(dataDir, 'profile.yaml')))
  corruptSignature = true
  await assert.rejects(invoke(page, 'checkWindowsUpdate'), /signature/)
  assert.equal(assetRequests, 0)
  corruptSignature = false
  assert.equal((await invoke(page, 'checkWindowsUpdate')).update.tag, tag)
  await page.evaluate(() => {
    window.location.hash = '/settings'
  })
  const checkButton = page.getByRole('button', { name: /^(检查更新|檢查更新|Check for updates)$/ })
  await checkButton.waitFor({ state: 'visible', timeout: 15000 })
  await application.evaluate(({ BrowserWindow }) => {
    const window = BrowserWindow.getAllWindows()[0]
    window.setMinimumSize(700, 500)
    window.setSize(800, 700)
  })
  await checkButton.scrollIntoViewIfNeeded()
  const overflow = await page.evaluate(() => {
    const button = [...document.querySelectorAll('button')].find((element) =>
      /^(检查更新|檢查更新|Check for updates)$/.test(element.textContent?.trim() || '')
    )
    const card =
      button?.closest('.setting-card') || button?.parentElement?.parentElement?.parentElement
    return {
      page: document.documentElement.scrollWidth - window.innerWidth,
      card: card ? card.scrollWidth - card.clientWidth : 0
    }
  })
  assert(
    overflow.page <= 1 && overflow.card <= 1,
    `Settings horizontal overflow: ${JSON.stringify(overflow)}`
  )
  await mkdir(path.join(root, 'dist/validation'), { recursive: true })
  await page.screenshot({ path: path.join(root, 'dist/validation/windows-settings.png') })
  evidence.tests.push('actual fixture client verifies signed CNB metadata and rejects tampering')
  await application.evaluate(() => {
    globalThis.__momoUpdateConfirmation = 0
  })
  await invoke(page, 'downloadWindowsUpdate')
  assert.equal(assetRequests, 0)
  await application.evaluate(() => {
    globalThis.__momoUpdateConfirmation = 1
  })
  corruptDownload = true
  await assert.rejects(invoke(page, 'downloadWindowsUpdate'), /SHA-256/)
  corruptDownload = false
  assert.equal((await invoke(page, 'downloadWindowsUpdate')).phase, 'downloaded')
  await application.evaluate(() => {
    globalThis.__momoUpdateConfirmation = 0
  })
  assert.equal((await invoke(page, 'installWindowsUpdate')).phase, 'downloaded')
  await application.evaluate(() => {
    globalThis.__momoUpdateConfirmation = 1
  })
  evidence.tests.push(
    'download and installation require separate confirmations; corrupt installer rejected'
  )
  const originalAsarHash = hash(await readFile(path.join(installDir, 'resources/app.asar')))
  await invoke(page, 'installWindowsUpdate').catch((error) => {
    if (!/closed|Target/.test(String(error))) throw error
  })
  await waitFor(
    async () => hash(await readFile(path.join(installDir, 'resources/app.asar'))),
    (value) => value !== originalAsarHash,
    'Real N+1 installation',
    120000
  )
  await waitFor(
    () => scopedProcesses(),
    (items) =>
      items.some(
        (item) =>
          item.ExecutablePath.toLowerCase() ===
          path.join(installDir, 'Clash Momo.exe').toLowerCase()
      ),
    'NSIS user-session restart',
    45000
  )
  assert.equal(
    hash(await readFile(path.join(installDir, 'resources/app.asar'))),
    hash(await readFile(path.join(root, 'dist/windows/win-unpacked/resources/app.asar')))
  )
  await scopedProcesses(true)
  application = undefined
  application = await _electron.launch({
    executablePath: path.join(installDir, 'Clash Momo.exe'),
    cwd: installDir,
    timeout: 45000
  })
  page = await application.firstWindow()
  assert.equal((await invoke(page, 'windowsUpdateState')).currentRevision, revision)
  await waitFor(
    () => invoke(page, 'trafficHistoryStatus'),
    (value) => value.ready && value.healthy,
    'Updated-client history readiness'
  )
  const historyAfter = await invoke(page, 'queryTrafficHistory', 'summary', historyQuery)
  assert(
    historyAfter.data.upload + historyAfter.data.download >=
      historyBefore.data.upload + historyBefore.data.download
  )
  assert.equal(hash(await readFile(path.join(dataDir, 'profile.yaml'))), ordinaryProfiles)
  const retainedConfig = parse(await readFile(configPath, 'utf8'))
  assert.equal(retainedConfig.windowsAutoCheckUpdate, false)
  assert.equal(retainedConfig.windowsUpdateSource, 'cnb')
  assert.equal(await readFile(marker, 'utf8'), 'preserve through application update')
  assert((await stat(historyPath)).size >= historySize)
  await application.close()
  application = undefined
  evidence.tests.push(
    'real NSIS 4 -> 5 update preserves original directory, app data, history and restarts paired client'
  )

  await writeFile(path.join(portableDir, 'PORTABLE'), '')
  await cp(dataDir, path.join(portableDir, 'data'), { recursive: true })
  const portableConfigPath = path.join(portableDir, 'data/config.yaml')
  await writeFile(
    portableConfigPath,
    stringify({
      ...parse(await readFile(portableConfigPath, 'utf8')),
      windowsUpdateSource: 'github'
    })
  )
  page = await attachFixture(path.join(portableDir, 'Clash Momo.exe'), 'github')
  const portableState = await invoke(page, 'checkWindowsUpdate')
  assert.equal(portableState.portable, true)
  assert.equal(portableState.update.tag, tag)
  assert.equal((await invoke(page, 'downloadWindowsUpdate')).phase, 'downloaded')
  assert.equal(
    hash(await readFile(path.join(work, 'downloaded-portable.zip'))),
    hash(portableBytes)
  )
  await assert.rejects(invoke(page, 'installWindowsUpdate'), /installer/)
  assert.equal((await invoke(page, 'windowsUpdateState')).currentRevision, 4)
  await application.close()
  application = undefined
  evidence.tests.push(
    'real portable client discovers GitHub updates and saves verified ZIP without installing'
  )
  await mkdir(path.join(root, 'dist/validation'), { recursive: true })
  await writeFile(
    path.join(root, 'dist/validation/windows-update-e2e.json'),
    JSON.stringify(evidence, null, 2) + '\n'
  )
  console.log(JSON.stringify(evidence, null, 2))
} finally {
  if (application) await application.close().catch(() => {})
  await scopedProcesses(true).catch(() => {})
  if (fixtureServer) await new Promise((resolve) => fixtureServer.close(resolve))
  const uninstaller = (await readdir(installDir).catch(() => [])).find((name) =>
    /^Uninstall.*\.exe$/.test(name)
  )
  if (uninstaller) {
    const installer = Buffer.from(JSON.stringify(path.join(installDir, uninstaller))).toString(
      'base64'
    )
    await powerShell(
      `$exe=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${installer}')) | ConvertFrom-Json; Start-Process -FilePath $exe -ArgumentList '/S' -Wait`
    ).catch(() => {})
  }
  for (const [name, directory] of [
    ['installed', dataDir],
    ['portable', path.join(portableDir, 'data')]
  ]) {
    await cp(
      path.join(directory, 'logs'),
      path.join(root, 'dist/validation/windows-update-e2e-logs', name),
      { recursive: true }
    ).catch(() => {})
  }
  await rm(work, { recursive: true, force: true })
}
