import { mkdir } from 'fs/promises'
import path from 'path'
import { BrowserWindow, powerMonitor } from 'electron'
import { getAppConfig, patchAppConfig } from '../config/app'
import { dataDir, mihomoCorePath, mihomoWorkDir } from '../utils/dirs'
import { WriteQueue } from '../utils/safeFile'
import { TIZI_PROFILE_ID, type TiziStatus } from '../../shared/tizi'
import { invokeTiziNative, validateTiziRequest } from './native'
import { tiziFeatureEnabled } from './policy'
import { checkBackendBinding, rememberBackendBinding } from './backend-binding'

const operations = new WriteQueue()
const backendMarker = (): string => path.join(dataDir(), 'tizi-backend.json')

async function rememberIdentity(backend: string, result: unknown): Promise<void> {
  if (result && typeof result === 'object' && 'device_id' in result && result.device_id)
    await rememberBackendBinding(backendMarker(), backend)
}

export async function tiziStateDirectory(): Promise<string> {
  if (process.platform === 'darwin') {
    const { isMacServiceActive, macServiceStatus } = await import('../core/macos-service')
    if (isMacServiceActive()) {
      const status = await macServiceStatus()
      if (!status.workDir) throw new Error('macOS service work directory is unavailable')
      return path.join(path.dirname(status.workDir), 'tizi')
    }
  }
  return path.join(mihomoWorkDir(), 'tizi')
}

async function native(action: unknown, input: unknown = {}): Promise<unknown> {
  const request = validateTiziRequest(action, input)
  if (process.platform === 'darwin') {
    const { connectMacService, isMacServiceActive, macServiceRequest } =
      await import('../core/macos-service')
    await connectMacService()
    if (isMacServiceActive()) {
      const backend = await tiziStateDirectory()
      await checkBackendBinding(
        backendMarker(),
        backend,
        path.join(mihomoWorkDir(), 'tizi', 'identity.enc')
      )
      const envelope = await macServiceRequest<{
        ok: boolean
        data?: unknown
        error?: { message?: string }
      }>('/v1/tizi/action', request, 60000)
      if (!envelope.ok)
        throw new Error(envelope.error?.message?.slice(0, 300) || 'Tizi native request failed')
      await rememberIdentity(backend, envelope.data)
      return envelope.data
    }
  }
  const directory = await tiziStateDirectory()
  await checkBackendBinding(backendMarker(), directory)
  await mkdir(directory, { recursive: true, mode: 0o700 })
  const result = await invokeTiziNative(
    mihomoCorePath(),
    directory,
    request.action,
    request.payload
  )
  await rememberIdentity(directory, result)
  return result
}

let reportingStarted = false
let reportingPending = false
let lastReportedDay = ''
function settlementDay(at: number): string {
  return new Date(at + 60 * 60 * 1000).toISOString().slice(0, 10)
}

/** Keep inactive managed ledgers reporting even after switching to a private subscription. */
export function startTiziReporting(): void {
  if (!tiziFeatureEnabled() || reportingStarted) return
  reportingStarted = true
  const attempt = async (): Promise<void> => {
    if (reportingPending || lastReportedDay === settlementDay(Date.now())) return
    reportingPending = true
    try {
      {
        const current = (await native('status')) as TiziStatus
        if (!current.device_id || !current.keyReady) return
        const reportDay = settlementDay(Date.now())
        const result = (await native('sync')) as TiziStatus
        if (result.last_sync_at && settlementDay(result.last_sync_at * 1000) >= reportDay)
          lastReportedDay = reportDay
      }
    } catch {
      // Offline usage remains available; the tizi page shows pending/health state.
    } finally {
      reportingPending = false
    }
  }
  const timer = setInterval(() => void attempt(), 60000)
  timer.unref()
  const initial = setTimeout(() => void attempt(), 5000)
  initial.unref()
  powerMonitor.on('resume', () => void attempt())
}

async function status(): Promise<TiziStatus> {
  const data = (await native('status')) as Omit<TiziStatus, 'active'>
  return { ...data, active: (await getAppConfig()).tiziActive === true }
}

let profileSnapshot: IProfileItem | undefined
let profileExpires = 0
let profilePending: Promise<IProfileItem | undefined> | undefined

/** Metadata only: never read or copy the sealed subscription into the profile library. */
export async function getTiziProfileItem(): Promise<IProfileItem | undefined> {
  if (!tiziFeatureEnabled()) return undefined
  if (Date.now() < profileExpires) return profileSnapshot
  if (!profilePending) {
    profilePending = status()
      .then((current) => {
        profileSnapshot = current.logged_in
          ? {
              id: TIZI_PROFILE_ID,
              name: '新团购tizi订阅服务',
              type: 'managed',
              updated: current.subscription_updated_at
                ? current.subscription_updated_at * 1000
                : undefined,
              extra: current.subscription
            }
          : undefined
        profileExpires = Date.now() + 5000
        return profileSnapshot
      })
      .catch(() => profileSnapshot)
      .finally(() => {
        profilePending = undefined
      })
  }
  return profilePending
}

function notify(): void {
  for (const window of BrowserWindow.getAllWindows()) {
    for (const event of [
      'appConfigUpdated',
      'profileConfigUpdated',
      'groupsUpdated',
      'rulesUpdated'
    ])
      window.webContents.send(event)
  }
}

async function select(active: boolean): Promise<TiziStatus> {
  const previous = (await getAppConfig()).tiziActive === true
  if (active) {
    const current = await status()
    if (!current.supported || !current.keyReady)
      throw new Error('请安装启用团购功能并注入构建密钥的 Mihomomo 内核。')
    if (!current.logged_in) throw new Error('请先登录并获取团购订阅。')
  }
  if (previous === active) return status()
  const { restartCore } = await import('../core/manager')
  await patchAppConfig({ tiziActive: active })
  try {
    await restartCore()
  } catch (error) {
    await patchAppConfig({ tiziActive: previous })
    await restartCore().catch(() => {})
    throw error
  } finally {
    const { initWebdavBackupScheduler } = await import('../resolve/backup')
    await initWebdavBackupScheduler()
    notify()
  }
  return status()
}

export async function tiziAction(action: unknown, input: unknown = {}): Promise<unknown> {
  if (!tiziFeatureEnabled()) throw new Error('This build does not include tizi support')
  if (action === 'status') {
    validateTiziRequest(action, input)
    return status()
  }
  if (
    [
      'usage',
      'sync',
      'register',
      'registration-status',
      'complete-registration',
      'reset-request',
      'reset-confirm'
    ].includes(String(action))
  )
    return native(action, input)
  if (action === 'refresh') {
    const result = await native(action, input)
    return operations.run(async () => {
      if ((await getAppConfig()).tiziActive) {
        const { mihomoHotReloadConfig } = await import('../core/mihomoApi')
        await mihomoHotReloadConfig()
      }
      profileExpires = 0
      notify()
      return result
    })
  }
  return operations.run(async () => {
    if (action === 'activate' || action === 'deactivate') {
      if (!input || typeof input !== 'object' || Object.keys(input).length)
        throw new Error('Invalid tizi selection request')
      return select(action === 'activate')
    }
    if (action === 'login' && (await getAppConfig()).tiziActive)
      throw new Error('请先切换至私人订阅，再重新登录或切换账户。')
    if (action === 'logout') {
      validateTiziRequest(action, input)
      const wasActive = (await getAppConfig()).tiziActive === true
      if (wasActive) await select(false)
      const result = await native(action, input)
      profileExpires = 0
      notify()
      return result
    }
    const result = await native(action, input)
    profileExpires = 0
    notify()
    return result
  })
}
