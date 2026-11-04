import { existsSync } from 'fs'
import { mkdir, mkdtemp, readFile, rename, rm, writeFile } from 'fs/promises'
import { execFile } from 'child_process'
import { promisify } from 'util'
import path from 'path'
import type { IncomingMessage } from 'http'
import AdmZip from 'adm-zip'
import { mihomoWorkDir } from '../utils/dirs'
import { managerLogger as logger } from '../utils/logger'
import * as chromeRequest from '../utils/chromeRequest'
import { parse } from '../utils/yaml'
import { getRuntimeConfig, setAppliedRuntimeConfig } from './factory'
import {
  createExternalController,
  readControllerJSON,
  type ControllerReply
} from './external-controller'
import {
  MAC_HELPER_SOCKET,
  macServiceHeaders,
  macServiceRequest,
  macServiceStatus,
  installMacService
} from './macos-service'
import { createMacCoreSnapshot } from './macos-snapshot'
import { rememberMacResources } from './macos-resources'

let controllers: Awaited<ReturnType<typeof createExternalController>>[] = []
let download: Promise<void> | undefined
const execFileAsync = promisify(execFile)
let controllerBaseDir: string | undefined
const uiDirectory = (config: IMihomoConfig): string =>
  path.resolve(controllerBaseDir || mihomoWorkDir(), config['external-ui'])

export async function stopMacExternalController(): Promise<void> {
  const previous = controllers
  controllers = []
  await Promise.all(previous.map((controller) => controller.stop()))
}

export async function startMacExternalController(baseDir = mihomoWorkDir()): Promise<void> {
  await stopMacExternalController()
  controllerBaseDir = baseDir
  const config = await getRuntimeConfig()
  const common = {
    secret: config.secret,
    cors: config['external-controller-cors'],
    socketPath: MAC_HELPER_SOCKET,
    headers: macServiceHeaders,
    uiDirectory: config['external-ui'] ? uiDirectory(config) : undefined,
    handle: handleMacControllerRequest,
    onError: (error: unknown) => {
      void logger.warn('External controller operation failed', error)
    }
  }
  try {
    if (config['external-controller'])
      controllers.push(
        await createExternalController({ ...common, address: config['external-controller'] })
      )
    if (config['external-controller-tls']) {
      const certificate = config.tls?.certificate
      const key = config.tls?.['private-key']
      if (!certificate || !key)
        throw new Error('TLS controller requires a certificate and private key')
      const pem = async (value: string): Promise<string | Buffer> =>
        value.includes('-----BEGIN') ? value : readFile(path.resolve(baseDir, value))
      const clientCert = config.tls?.['client-auth-cert']
      const auth = config.tls?.['client-auth-type'] || 'no-client-cert'
      controllers.push(
        await createExternalController({
          ...common,
          address: config['external-controller-tls'],
          requireClientCertificate: auth === 'require-any-client-cert',
          verifyClientCertificateIfGiven: auth === 'verify-client-cert-if-given',
          tls: {
            cert: await pem(certificate),
            key: await pem(key),
            ca: clientCert ? await pem(clientCert) : undefined,
            requestCert: auth !== 'no-client-cert',
            rejectUnauthorized: auth === 'require-and-verify-client-cert'
          }
        })
      )
    }
    if (config['external-controller-unix'])
      controllers.push(
        await createExternalController({
          ...common,
          unixPath: path.resolve(baseDir, config['external-controller-unix'])
        })
      )
  } catch (error) {
    await stopMacExternalController()
    throw error
  }
  if (config['external-ui'] && !existsSync(path.join(uiDirectory(config), 'index.html'))) {
    void upgradeMacExternalUI().catch((error) => logger.warn('WebUI download failed', error))
  }
}

export async function handleMacControllerRequest(
  req: IncomingMessage
): Promise<ControllerReply | undefined> {
  const endpoint = (req.url || '/').split('?')[0].replace(/\/$/, '')
  if (req.method === 'POST' && endpoint === '/upgrade/ui') {
    await upgradeMacExternalUI()
    return { body: { status: 'ok' } }
  }
  if (req.method === 'POST' && endpoint === '/restart') {
    return {
      body: { status: 'ok' },
      afterResponse: async () => {
        const { restartCore } = await import('./manager')
        await restartCore()
      }
    }
  }
  if (req.method === 'POST' && endpoint === '/upgrade') {
    // Homebrew owns the installed executable. It runs as the user; replacing
    // the protected copy uses the application's normal native authorization.
    await execFileAsync('/opt/homebrew/bin/brew', ['update'], { timeout: 300000 })
    await execFileAsync(
      '/opt/homebrew/bin/brew',
      ['upgrade', '--formula', 'fansionia/tap/mihomomo'],
      { timeout: 600000 }
    )
    return { body: { status: 'ok' }, afterResponse: installMacService }
  }
  if (req.method === 'PUT' && endpoint === '/configs') {
    const body = await readControllerJSON<{ path?: string; payload?: string }>(req)
    if (!body.payload && !body.path) {
      return {
        status: 204,
        afterResponse: async () => {
          const { mihomoHotReloadConfig } = await import('./mihomoApi')
          await mihomoHotReloadConfig()
        }
      }
    }
    const baseDir = body.path ? path.dirname(path.resolve(body.path)) : mihomoWorkDir()
    const text = body.payload || (await readFile(path.resolve(body.path || ''), 'utf8'))
    const profile = parse<IMihomoConfig>(text)
    if (!profile || typeof profile !== 'object' || Array.isArray(profile))
      throw new Error('Invalid configuration')
    const staging = await mkdtemp(path.join(mihomoWorkDir(), '.controller-config-'))
    try {
      const file = path.join(staging, 'config.yaml')
      await writeFile(file, text, { mode: 0o600 })
      const { checkProfileConfig } = await import('./manager')
      await checkProfileConfig(file, 'mihomomo', undefined, { workDir: baseDir })
      const status = await macServiceStatus()
      if (!status.workDir) throw new Error('Service work directory is unavailable')
      const snapshot = await createMacCoreSnapshot(
        mihomoWorkDir(),
        file,
        status.workDir,
        undefined,
        status.dataMigrated,
        baseDir
      )
      await macServiceRequest('/v1/core/config', snapshot, 60000)
      rememberMacResources(snapshot)
      const current = await getRuntimeConfig()
      // Full core reload does not recreate controller listeners in Mihomo.
      for (const key of [
        'external-controller',
        'external-controller-tls',
        'external-controller-unix',
        'external-controller-cors',
        'external-ui',
        'external-ui-url',
        'secret'
      ] as const) {
        if (Object.hasOwn(current, key)) Object.assign(profile, { [key]: current[key] })
      }
      setAppliedRuntimeConfig(profile)
    } finally {
      await rm(staging, { recursive: true, force: true })
    }
    return { status: 204 }
  }
  return undefined
}

export async function upgradeMacExternalUI(): Promise<void> {
  if (download) return download
  download = (async () => {
    const config = await getRuntimeConfig()
    if (!config['external-ui'] || !config['external-ui-url'])
      throw new Error('Enable the WebUI and configure its download URL first')
    const targetDirectory = uiDirectory(config)
    const result = await chromeRequest.get(config['external-ui-url'], {
      responseType: 'arraybuffer',
      proxy: config['mixed-port']
        ? { protocol: 'http', host: '127.0.0.1', port: config['mixed-port'] }
        : undefined
    })
    if (result.status < 200 || result.status >= 300)
      throw new Error(`WebUI download failed: HTTP ${result.status}`)
    const zip = new AdmZip(Buffer.from(result.data as Buffer))
    const entries = zip.getEntries()
    const index = entries
      .filter((entry) => !entry.isDirectory && /(^|\/)index\.html$/.test(entry.entryName))
      .sort((a, b) => a.entryName.length - b.entryName.length)[0]
    if (!index) throw new Error('WebUI archive has no index.html')
    const prefix = index.entryName.slice(0, -'index.html'.length)
    await mkdir(path.dirname(targetDirectory), { recursive: true })
    const staging = await mkdtemp(path.join(path.dirname(targetDirectory), '.webui-'))
    const backup = `${staging}-previous`
    let saved = false
    let installed = false
    try {
      let total = 0
      for (const entry of entries) {
        if (entry.isDirectory || !entry.entryName.startsWith(prefix)) continue
        const relative = entry.entryName.slice(prefix.length)
        const target = path.resolve(staging, relative)
        if (!relative || !target.startsWith(`${staging}${path.sep}`))
          throw new Error('Invalid WebUI archive path')
        total += entry.header.size
        if (total > 256 * 1024 * 1024) throw new Error('WebUI archive exceeds 256 MiB')
        await mkdir(path.dirname(target), { recursive: true })
        await writeFile(target, entry.getData())
      }
      if (existsSync(targetDirectory)) {
        await rename(targetDirectory, backup)
        saved = true
      }
      try {
        await rename(staging, targetDirectory)
        installed = true
      } catch (error) {
        if (saved) await rename(backup, targetDirectory)
        throw error
      }
    } finally {
      await rm(staging, { recursive: true, force: true })
      if (installed) await rm(backup, { recursive: true, force: true })
    }
  })().finally(() => {
    download = undefined
  })
  return download
}
