import { execFile } from 'child_process'
import { promisify } from 'util'
import { createHash } from 'crypto'
import { readFile, writeFile, rename, rm } from 'fs/promises'
import path from 'path'
import axios from 'axios'
import { mihomoCorePath, mihomoWorkDir, resourcesFilesDir } from '../utils/dirs'
import { tiziTestBuild } from '../../shared/test-build'
import { managerLogger } from '../utils/logger'
import { DEFAULT_MIHOMO_PORTS } from '../../shared/appConfig'
import type { MacServiceStatus } from '../../shared/macos-service'

export const MAC_HELPER_SOCKET =
  '/Library/PrivilegedHelperTools/world.fansionia.clash-momo.ipc/helper.sock'
export const MAC_FORMULA_CORE = '/opt/homebrew/opt/mihomomo/bin/mihomomo'
const execFileAsync = promisify(execFile)
let token: string | undefined
let lease: NodeJS.Timeout | undefined
let managed = false
let expectedRunning = false
let leasePending = false
let recoveryPending = false
let transition: (() => Promise<void>) | undefined
let installPending: Promise<void> | undefined

export function isMacServiceActive(): boolean {
  return process.platform === 'darwin' && managed
}

export function macServiceHeaders(): Record<string, string> {
  return token ? { 'X-Momo-Session': token } : {}
}

export async function macServiceRequest<T = unknown>(
  endpoint: string,
  body?: unknown,
  timeout = 15000
): Promise<T> {
  const response = await axios.request<T>({
    socketPath: MAC_HELPER_SOCKET,
    baseURL: 'http://localhost',
    url: endpoint,
    method: body === undefined ? 'GET' : 'POST',
    data: body,
    headers: macServiceHeaders(),
    timeout,
    proxy: false,
    maxBodyLength: 768 * 1024 * 1024
  })
  return response.data
}

export async function validateMacCore(): Promise<void> {
  const { stdout } = await execFileAsync(
    tiziTestBuild() ? mihomoCorePath() : MAC_FORMULA_CORE,
    ['--momo-capabilities'],
    {
      timeout: 5000
    }
  )
  const capability = JSON.parse(stdout)
  if (
    capability.protocol !== 1 ||
    capability.managedMode !== true ||
    !supportedVersion(capability.version)
  ) {
    throw new Error('Install mihomomo >= 1.19.33 with managed service protocol 1 using Homebrew.')
  }
}

function supportedVersion(version: unknown): boolean {
  if (typeof version !== 'string') return false
  const match = version.match(/(?:^|v)(\d+)\.(\d+)\.(\d+)(?:$|[-+ ])/)
  if (!match) return false
  const [major, minor, patch] = match.slice(1).map(Number)
  return major > 1 || (major === 1 && (minor > 19 || (minor === 19 && patch >= 33)))
}

export async function macServiceStatus(): Promise<MacServiceStatus> {
  if (tiziTestBuild()) return { installed: false, compatible: false }
  if (process.platform !== 'darwin') return { installed: false, compatible: false }
  try {
    const status = await macServiceRequest<MacServiceStatus>('/v1/status', undefined, 2000)
    let expectedHash = ''
    try {
      expectedHash = createHash('sha256')
        .update(await readFile(path.join(resourcesFilesDir(), 'world.fansionia.clash-momo.helper')))
        .digest('hex')
    } catch {
      /* Development checkouts may not have the packaged helper. */
    }
    let expectedCoreHash = ''
    try {
      expectedCoreHash = createHash('sha256')
        .update(await readFile(MAC_FORMULA_CORE))
        .digest('hex')
    } catch {
      /* Report missing Formula as an incompatible installation. */
    }
    const compatible =
      status.protocol === 1 &&
      status.uid === process.getuid?.() &&
      (!expectedHash || status.helperHash === expectedHash) &&
      Boolean(expectedCoreHash && status.coreHash === expectedCoreHash) &&
      supportedVersion(status.coreVersion)
    return { ...status, installed: true, compatible }
  } catch (error) {
    return { installed: false, compatible: false, error: String(error) }
  }
}

export function setMacServiceTransition(callback: () => Promise<void>): void {
  transition = callback
}

export async function connectMacService(): Promise<boolean> {
  if (tiziTestBuild()) return false
  if (process.platform !== 'darwin') return false
  const status = await macServiceStatus()
  if (!status.installed) return false
  if (!status.compatible)
    throw new Error('The macOS service needs an update. Update it in Settings → Core.')
  if (!token) {
    token = (await macServiceRequest<{ token: string }>('/v1/session', {})).token
    if (!token) throw new Error('Service did not return a session token')
    lease = setInterval(() => {
      void renewLease()
    }, 2000)
    lease.unref()
  }
  managed = true
  return true
}

export function expectMacServiceCore(running: boolean): void {
  expectedRunning = running
}

async function renewLease(): Promise<void> {
  if (leasePending || !managed) return
  leasePending = true
  try {
    let shouldRestart = false
    try {
      const response = await macServiceRequest<{ running?: boolean }>('/v1/lease', {}, 1500)
      shouldRestart = expectedRunning && response.running === false
    } catch (error) {
      if (axios.isAxiosError(error) && error.response?.status === 401) {
        token = (await macServiceRequest<{ token: string }>('/v1/session', {})).token
        shouldRestart = expectedRunning
      } else throw error
    }
    if (shouldRestart && !recoveryPending && transition) {
      recoveryPending = true
      void transition()
        .catch((error) => managerLogger.warn('macOS service core recovery failed', error))
        .finally(() => {
          recoveryPending = false
        })
    }
  } catch (error) {
    managerLogger.warn('macOS service lease/recovery failed', error)
  } finally {
    leasePending = false
  }
}

export async function restoreMacServiceNetwork(): Promise<void> {
  const { getAppConfig, getControledMihomoConfig } = await import('../config')
  const config = await getAppConfig()
  const core = await getControledMihomoConfig()
  if (core.tun?.enable && config.autoSetDNS !== false)
    await macServiceRequest('/v1/network/dns', { enabled: true, servers: ['223.5.5.5'] })
  if (!config.sysProxy.enable) return
  const { startPacServer, pacPort } = await import('../resolve/server')
  await startPacServer()
  const host = config.sysProxy.host || '127.0.0.1'
  await macServiceRequest(
    '/v1/network/proxy',
    config.sysProxy.mode === 'auto'
      ? { enabled: true, mode: 'auto', url: `http://${host}:${pacPort}/pac` }
      : {
          enabled: true,
          mode: 'manual',
          host,
          port: core['mixed-port'] ?? DEFAULT_MIHOMO_PORTS.mixed,
          bypass: config.sysProxy.bypass
        }
  )
}

function shellQuote(value: string): string {
  return "'" + value.replace(/'/g, "'\\''") + "'"
}

async function privilegedCommand(args: string[]): Promise<void> {
  const helper = path.join(resourcesFilesDir(), 'world.fansionia.clash-momo.helper')
  const command = [helper, ...args].map(shellQuote).join(' ')
  // JSON string escaping is also valid for an AppleScript text literal here.
  await execFileAsync(
    '/usr/bin/osascript',
    ['-e', `do shell script ${JSON.stringify(command)} with administrator privileges`],
    { timeout: 120000 }
  )
}

export async function installMacService(): Promise<void> {
  if (tiziTestBuild()) throw new Error('团购测试版使用独立内核，不安装或连接现有特权服务。')
  if (process.platform !== 'darwin')
    throw new Error('macOS service is unavailable on this platform')
  if (installPending) return installPending
  installPending = (async () => {
    await validateMacCore()
    await privilegedCommand([
      'install',
      '--uid',
      String(process.getuid?.()),
      '--core',
      MAC_FORMULA_CORE
    ])
    clearMacServiceSession()
    // Authorization finishes before stopping the ordinary core, so cancellation is harmless.
    await transition?.()
  })().finally(() => {
    installPending = undefined
  })
  return installPending
}

export async function ensureMacService(): Promise<void> {
  if (isMacServiceActive()) return
  if (await connectMacService()) {
    await transition?.()
    return
  }
  await installMacService()
}

export function clearMacServiceSession(): void {
  if (lease) clearInterval(lease)
  lease = undefined
  token = undefined
  managed = false
  expectedRunning = false
}

export async function stopMacServiceCore(release = false): Promise<void> {
  if (!isMacServiceActive()) return
  expectedRunning = false
  try {
    await macServiceRequest('/v1/core/stop', {}, 8000)
  } finally {
    if (release) clearMacServiceSession()
  }
}

export async function uninstallMacService(): Promise<void> {
  if (tiziTestBuild()) throw new Error('团购测试版不管理现有特权服务。')
  if (process.platform !== 'darwin')
    throw new Error('macOS service is unavailable on this platform')
  const { stopCore, restartCore } = await import('./manager')
  await stopCore()
  try {
    const state = await macServiceRequest<{ files: { path: string; data: string }[] }>(
      '/v1/core/state',
      undefined,
      60000
    )
    for (const name of [
      'traffic-history.db-wal',
      'traffic-history.db-shm',
      'cache.db-wal',
      'cache.db-shm'
    ])
      await rm(path.join(mihomoWorkDir(), name), { force: true })
    let total = 0
    for (const file of state.files) {
      if (!/^(traffic-history|cache|smart)\.db(?:-wal|-shm)?$/.test(file.path))
        throw new Error('Service returned an invalid state path')
      const data = Buffer.from(file.data, 'base64')
      total += data.length
      if (total > 512 * 1024 * 1024) throw new Error('Service state export exceeds import limit')
      const target = path.join(mihomoWorkDir(), file.path)
      const temporary = `${target}.momo-restore-${process.pid}`
      await writeFile(temporary, data, { mode: 0o600, flag: 'wx' })
      await rename(temporary, target)
    }
    await privilegedCommand(['uninstall'])
  } catch (error) {
    await restartCore().catch((restartError) =>
      managerLogger.warn('Failed to resume service after cancelled uninstall', restartError)
    )
    throw error
  }
  clearMacServiceSession()
  const { patchAppConfig, patchControledMihomoConfig } = await import('../config')
  await patchAppConfig({ sysProxy: { enable: false } })
  await patchControledMihomoConfig({ tun: { enable: false } })
  if (!isMacServiceActive()) await restartCore()
}

export async function macServiceLogs(): Promise<string> {
  if (!(await connectMacService())) return ''
  return (await macServiceRequest<{ logs: string }>('/v1/core/logs')).logs
}
