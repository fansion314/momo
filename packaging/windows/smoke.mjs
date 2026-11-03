import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { createServer, request } from 'node:http'
import { mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { _electron } from 'playwright'
import AdmZip from 'adm-zip'

if (process.platform !== 'win32' || process.arch !== 'x64')
  throw new Error('Native Windows x64 required')
const root = path.resolve(process.env.RUNNER_TEMP || 'dist', 'clash-momo-windows-smoke')
const installed = process.argv[2] === '--installed'
let appDir
if (installed) appDir = path.resolve(process.argv[3])
else {
  await rm(root, { recursive: true, force: true })
  appDir = path.join(root, '便携 客户端')
  await mkdir(appDir, { recursive: true })
  const pkg = JSON.parse(await readFile('package.json', 'utf8'))
  const revision = (await readFile('packaging/arch/PKGBUILD', 'utf8')).match(/^pkgrel=(\d+)$/m)[1]
  const archive = `dist/release/clash-momo-${pkg.version}-${revision}-windows-x64-portable.zip`
  new AdmZip(archive).extractAllTo(appDir, true)
  await stat(path.join(appDir, 'PORTABLE'))
}
const dataDir = installed ? path.join(process.env.APPDATA, 'clash-momo') : path.join(appDir, 'data')
await mkdir(dataDir, { recursive: true })
await writeFile(
  path.join(dataDir, 'config.yaml'),
  JSON.stringify({
    modeSelected: true,
    operationMode: 'standard',
    core: 'mihomomo',
    silentStart: false,
    useSubStore: false,
    autoUpdateProfileOnStart: false,
    autoCheckUpdate: false,
    enableSmartOverride: false,
    enableTrafficLogger: true,
    sysProxy: { enable: false }
  })
)
await writeFile(
  path.join(dataDir, 'profile.yaml'),
  JSON.stringify({ current: 'default', items: [] })
)
await writeFile(
  path.join(dataDir, 'mihomo.yaml'),
  JSON.stringify({
    mode: 'rule',
    'mixed-port': 17890,
    'socks-port': 0,
    port: 0,
    dns: { enable: false },
    tun: { enable: false }
  })
)
const payload = Buffer.alloc(32768, 77)
const server = createServer((_req, res) => {
  res.writeHead(200)
  res.end(payload)
})
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
const destinationPort = server.address().port
const waitFor = async (read, predicate, description) => {
  const deadline = Date.now() + 45000
  let value
  while (Date.now() < deadline) {
    try {
      value = await read()
      if (predicate(value)) return value
    } catch (error) {
      value = String(error)
    }
    await new Promise((resolve) => setTimeout(resolve, 250))
  }
  throw new Error(`${description}: ${JSON.stringify(value)}`)
}
const invoke = async (page, channel, ...args) => {
  const result = await page.evaluate(
    ({ channel, args }) => window.electron.ipcRenderer.invoke(channel, ...args),
    { channel, args }
  )
  if (result?.invokeError) throw new Error(`${channel}: ${result.invokeError}`)
  return result
}
const summary = (page) =>
  invoke(page, 'queryTrafficHistory', 'summary', {
    from: Date.now() - 3600000,
    to: Date.now() + 1000,
    include_internal: true
  })
const total = (result) => result.data.upload + result.data.download
let application
async function launch() {
  application = await _electron.launch({
    executablePath: path.join(appDir, 'Clash Momo.exe'),
    cwd: appDir,
    timeout: 45000
  })
  const page = await application.firstWindow()
  await waitFor(
    () => invoke(page, 'trafficHistoryStatus'),
    (v) => v.ready && v.healthy,
    'History readiness'
  )
  const actualDataDir = await application.evaluate(({ app }) => app.getPath('userData'))
  // Playwright launches through cmd.exe on Windows; process().pid is that shell.
  const appPid = await application.evaluate(() => process.pid)
  assert.equal(
    path.resolve(actualDataDir),
    path.resolve(installed ? dataDir : path.join(appDir, 'data'))
  )
  const version = await invoke(page, 'mihomoVersion')
  assert.match(JSON.stringify(version), /1\.19\.33/)
  const corePath = path.join(appDir, 'resources/sidecar/mihomomo.exe')
  assert.equal(
    await readFile(path.join(appDir, 'resources/files/licenses/clash-momo.txt'), 'utf8'),
    await readFile('LICENSE', 'utf8'),
    'Both Windows packages must include the complete client license'
  )
  const manifest = JSON.parse(
    await readFile(path.join(appDir, 'resources/files/mihomomo-manifest.json'), 'utf8')
  )
  const { coreTag } = JSON.parse(await readFile('packaging/macos/release.json', 'utf8'))
  assert.equal(manifest.tag, coreTag)
  assert.equal(
    createHash('sha256')
      .update(await readFile(corePath))
      .digest('hex'),
    manifest.core_sha256
  )
  const processes = JSON.parse(
    execFileSync(
      'powershell.exe',
      [
        '-NoProfile',
        '-Command',
        '[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false); $p=@(Get-CimInstance Win32_Process -Filter "Name=\'mihomomo.exe\'" | Select-Object ExecutablePath,ParentProcessId); ConvertTo-Json -InputObject $p -Compress'
      ],
      { encoding: 'utf8' }
    )
  )
  assert(
    processes.some(
      (p) =>
        p.ExecutablePath?.toLowerCase() === corePath.toLowerCase() && p.ParentProcessId === appPid
    ),
    `Actual app must launch its bundled core: ${JSON.stringify({ appPid, corePath, processes })}`
  )
  return page
}
async function close() {
  await application.close()
  application = undefined
  await waitFor(
    () =>
      execFileSync(
        'powershell.exe',
        [
          '-NoProfile',
          '-Command',
          '[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false); $p=@(Get-CimInstance Win32_Process -Filter "Name=\'mihomomo.exe\'" | Select-Object -ExpandProperty ExecutablePath); ConvertTo-Json -InputObject $p -Compress'
        ],
        { encoding: 'utf8' }
      ),
    (value) =>
      !JSON.parse(value).some(
        (file) => file && path.dirname(file).toLowerCase().startsWith(appDir.toLowerCase())
      ),
    'Bundled core cleanup'
  )
}
try {
  let page = await launch()
  const before = total(await summary(page))
  for (let i = 0; i < 4; i++)
    await new Promise((resolve, reject) => {
      const req = request(
        {
          hostname: '127.0.0.1',
          port: 17890,
          path: `http://127.0.0.1:${destinationPort}/traffic`,
          headers: { Host: `127.0.0.1:${destinationPort}` }
        },
        (res) => {
          let bytes = 0
          res.on('data', (data) => {
            bytes += data.length
          })
          res.on('end', () => {
            try {
              assert.equal(res.statusCode, 200)
              assert.equal(bytes, payload.length)
              resolve()
            } catch (error) {
              reject(error)
            }
          })
        }
      )
      req.on('error', reject)
      req.setTimeout(10000, () => req.destroy(new Error('Local proxy response timed out')))
      req.end()
    })
  const recorded = await waitFor(
    () => summary(page),
    (v) => total(v) >= before + payload.length,
    'Proxy traffic recording'
  )
  await close()
  const database = await stat(path.join(dataDir, 'work/traffic-history.db'))
  assert(database.size > 0)
  if (!installed) {
    const moved = path.join(root, '移动后的 便携版')
    await rename(appDir, moved)
    appDir = moved
  }
  page = await launch()
  const retained = await summary(page)
  assert(total(retained) >= total(recorded), 'History must survive restart and portable relocation')
  await close()
  console.log(
    'Actual client, bundled core, named-pipe API, local proxy, traffic history and restart passed'
  )
} finally {
  if (application) await application.close().catch(() => {})
  await new Promise((resolve) => server.close(resolve))
}
