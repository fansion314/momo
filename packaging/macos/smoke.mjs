// Disposable hosted macOS runner only; never replace a user's configuration.
import assert from 'node:assert/strict'
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import http from 'node:http'
import net from 'node:net'
import path from 'node:path'
import os from 'node:os'
import { _electron } from 'playwright'

assert.equal(process.env.GITHUB_ACTIONS, 'true')
assert.equal(process.platform, 'darwin')
assert.equal(process.arch, 'arm64')
const dataDir = path.join(os.homedir(), 'Library/Application Support/clash-momo')
assert(!existsSync(dataDir), 'Refusing to alter existing app data')
const helperSocket = '/Library/PrivilegedHelperTools/world.fansionia.clash-momo.ipc/helper.sock'
const group = '🚀 节点/选择'
const secret = 'disposable-ci-controller-token'
let application
let panelServer
async function availablePort() {
  const server = net.createServer()
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const port = server.address().port
  await new Promise((resolve) => server.close(resolve))
  return port
}
async function waitFor(fn, predicate, label) {
  const deadline = Date.now() + 120000
  let last
  while (Date.now() < deadline) {
    try {
      last = await fn()
      if (predicate(last)) return last
    } catch (error) {
      last = String(error)
    }
    await new Promise((resolve) => setTimeout(resolve, 250))
  }
  throw new Error(`${label}: ${JSON.stringify(last)}`)
}
const invoke = async (page, name, ...args) => {
  const value = await page.evaluate(
    ({ name, args }) => window.electron.ipcRenderer.invoke(name, ...args),
    { name, args }
  )
  if (value?.invokeError) throw new Error(`${name}: ${value.invokeError}`)
  return value
}
try {
  const port = await availablePort()
  const controller = `http://127.0.0.1:${port}`
  await mkdir(path.join(dataDir, 'profiles'), { recursive: true })
  await writeFile(
    path.join(dataDir, 'config.yaml'),
    `modeSelected: true
operationMode: standard
language: en-US
sysProxy: {enable: false, mode: manual}
autoSetDNS: false
enableSmartOverride: false
enableTrafficLogger: true
enableMixedPort: false
enableSocksPort: false
enableHttpPort: false
enableRedirPort: false
enableTproxyPort: false
autoUpdateProfileOnStart: false
autoCheckUpdate: false
useSubStore: false
autoCloseConnection: false
`
  )
  await writeFile(
    path.join(dataDir, 'mihomo.yaml'),
    `external-controller: 127.0.0.1:${port}
secret: ${secret}
tun: {enable: false}
dns: {enable: false}
mixed-port: 0
port: 0
socks-port: 0
redir-port: 0
tproxy-port: 0
`
  )
  await writeFile(
    path.join(dataDir, 'profile.yaml'),
    'current: fixture\nitems:\n  - id: fixture\n    type: local\n    name: macOS regression fixture\n'
  )
  await writeFile(
    path.join(dataDir, 'profiles/fixture.yaml'),
    `proxies:
  - {name: 节点 A, type: direct}
  - {name: 节点 B, type: direct}
proxy-groups:
  - name: ${JSON.stringify(group)}
    type: select
    proxies: [节点 A, 节点 B]
rules: ["MATCH,DIRECT"]
`
  )
  const executable = path.resolve('dist/macos/Clash Momo.app/Contents/MacOS/Clash Momo')
  application = await _electron.launch({ executablePath: executable, timeout: 45000 })
  const page = await application.firstWindow()
  const service = await waitFor(
    () => invoke(page, 'macServiceStatus'),
    (value) => value.running && value.compatible,
    'Managed service readiness'
  )
  assert.equal(service.helperVersion, '3')
  await waitFor(
    () => invoke(page, 'mihomoProxies'),
    (value) => value.proxies?.[group],
    'Proxy group readiness'
  )
  // Click the actual renderer card. This catches pointer/event regressions as
  // well as IPC transport failures with non-ASCII and escaped group names.
  await page.getByText(group, { exact: true }).first().click({ timeout: 30000 })
  await page.getByText('节点 B', { exact: true }).first().click({ timeout: 30000 })
  await waitFor(
    () => invoke(page, 'mihomoProxies'),
    (value) => value.proxies[group].now === '节点 B',
    'Renderer node selection'
  )
  await mkdir('dist/validation', { recursive: true })
  await page.screenshot({ path: 'dist/validation/macos-proxy-selection.png' })
  const headers = { Authorization: `Bearer ${secret}`, 'Content-Type': 'application/json' }
  assert.equal((await fetch(`${controller}/version`)).status, 401)
  assert.equal((await fetch(`${controller}/version`, { headers })).status, 200)
  // A separate Chromium window has no Electron preload or Node integration. Its
  // different HTTP origin exercises a real external panel's CORS and WebSocket.
  panelServer = http.createServer((_req, res) => {
    res.setHeader('Content-Type', 'text/html; charset=utf-8')
    res.end(`<title>External WebUI regression</title><body>Connecting…<script>
      (async () => {
        const base=${JSON.stringify(controller)}, secret=${JSON.stringify(secret)}, group=${JSON.stringify(group)};
        const headers={Authorization:'Bearer '+secret,'Content-Type':'application/json'};
        const changed=await fetch(base+'/proxies/'+encodeURIComponent(group),{method:'PUT',headers,body:JSON.stringify({name:'节点 A'})});
        if(!changed.ok) throw Error('switch: '+changed.status);
        const info=await (await fetch(base+'/proxies',{headers})).json();
        if(info.proxies[group].now!=='节点 A') throw Error('selection not applied');
        const ws=new WebSocket(base.replace('http:','ws:')+'/traffic?token='+secret);
        ws.onmessage=()=>{document.body.textContent='External WebUI connected; selection and WebSocket passed';document.body.dataset.ready='true';ws.close()};
        ws.onerror=()=>{document.body.textContent='WebSocket failed'};
      })().catch(error=>document.body.textContent=String(error));
    </script>`)
  })
  await new Promise((resolve) => panelServer.listen(0, '127.0.0.1', resolve))
  const panelURL = `http://127.0.0.1:${panelServer.address().port}/`
  const opened = application.context().waitForEvent('page')
  await application.evaluate(({ BrowserWindow }, url) => {
    const panel = new BrowserWindow({
      width: 900,
      height: 600,
      webPreferences: { sandbox: true, nodeIntegration: false, contextIsolation: true }
    })
    globalThis.momoRegressionPanel = panel
    void panel.loadURL(url)
  }, panelURL)
  const panel = await opened
  await panel.locator('body[data-ready="true"]').waitFor({ timeout: 30000 })
  await panel.screenshot({ path: 'dist/validation/macos-external-webui.png' })
  await panel.close()
  const storage = `${controller}/storage/ci-panel`
  assert.equal(
    (await fetch(storage, { method: 'PUT', headers, body: JSON.stringify({ tab: 'proxies' }) }))
      .status,
    204
  )
  assert.deepEqual(await (await fetch(storage, { headers })).json(), { tab: 'proxies' })
  assert.equal((await fetch(storage, { method: 'DELETE', headers })).status, 204)
  assert.equal(
    (
      await fetch(`${controller}/configs`, {
        method: 'PUT',
        headers,
        body: JSON.stringify({
          payload: await readFile(path.join(dataDir, 'profiles/fixture.yaml'), 'utf8')
        })
      })
    ).status,
    204
  )
  const previousPID = (await invoke(page, 'macServiceStatus')).pid
  assert.equal((await fetch(`${controller}/restart`, { method: 'POST', headers })).status, 200)
  await waitFor(
    () => invoke(page, 'macServiceStatus'),
    (value) => value.running && value.pid !== previousPID,
    'Service PID changed after restart'
  )
  await waitFor(
    async () => (await fetch(`${controller}/version`, { headers })).status,
    (status) => status === 200,
    'Public listener after restart'
  )
  await application.close()
  application = undefined
  await waitFor(
    () =>
      new Promise((resolve, reject) => {
        http
          .get({ socketPath: helperSocket, path: '/v1/status' }, (res) => {
            let data = ''
            res.on('data', (chunk) => {
              data += chunk
            })
            res.on('end', () => {
              try {
                resolve(JSON.parse(data))
              } catch (error) {
                reject(error)
              }
            })
          })
          .on('error', reject)
      }),
    (value) => value.running === false,
    'Privileged core cleanup'
  )
  await writeFile(
    'dist/validation/macos-controller.json',
    JSON.stringify(
      {
        rendererSelection: true,
        externalPanelSelection: true,
        cors: true,
        websocket: true,
        storage: true,
        configReload: true,
        restart: true,
        shutdown: true
      },
      null,
      2
    ) + '\n'
  )
  console.log(
    'Packaged macOS renderer, privileged core, external WebUI, reload and cleanup checks passed'
  )
} finally {
  await application?.close().catch(() => {})
  await new Promise((resolve) => (panelServer ? panelServer.close(resolve) : resolve()))
  await rm(dataDir, { recursive: true, force: true })
}
