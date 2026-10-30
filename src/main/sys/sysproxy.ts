import { triggerAutoProxy, triggerManualProxy } from 'sysproxy-rs'
import { net } from 'electron'
import { getAppConfig, getControledMihomoConfig } from '../config'
import { DEFAULT_MIHOMO_PORTS } from '../../shared/appConfig'
import { pacPort, startPacServer, stopPacServer } from '../resolve/server'
import { proxyLogger } from '../utils/logger'
import { ensureMacService, isMacServiceActive, macServiceRequest } from '../core/macos-service'

let triggerSysProxyTimer: NodeJS.Timeout | null = null
let triggerSysProxyQueue: Promise<void> = Promise.resolve()
let triggerSysProxySequence = 0
const defaultBypass: string[] = (() => {
  switch (process.platform) {
    case 'linux':
      return ['localhost', '127.0.0.1', '192.168.0.0/16', '10.0.0.0/8', '172.16.0.0/12', '::1']
    case 'darwin':
      return [
        '127.0.0.1',
        '192.168.0.0/16',
        '10.0.0.0/8',
        '172.16.0.0/12',
        'localhost',
        '*.local',
        '*.crashlytics.com',
        '<local>'
      ]
    case 'win32':
      return [
        'localhost',
        '127.*',
        '192.168.*',
        '10.*',
        '172.16.*',
        '172.17.*',
        '172.18.*',
        '172.19.*',
        '172.20.*',
        '172.21.*',
        '172.22.*',
        '172.23.*',
        '172.24.*',
        '172.25.*',
        '172.26.*',
        '172.27.*',
        '172.28.*',
        '172.29.*',
        '172.30.*',
        '172.31.*',
        '<local>'
      ]
    default:
      return ['localhost', '127.0.0.1', '192.168.0.0/16', '10.0.0.0/8', '172.16.0.0/12', '::1']
  }
})()

interface TriggerSysProxyOptions {
  helperTimeout?: number
  force?: boolean
}

export async function triggerSysProxy(
  enable: boolean,
  options: TriggerSysProxyOptions = {}
): Promise<void> {
  const sequence = ++triggerSysProxySequence

  if (triggerSysProxyTimer) {
    clearTimeout(triggerSysProxyTimer)
    triggerSysProxyTimer = null
  }

  const operation = triggerSysProxyQueue.then(async () => {
    if (net.isOnline() || options.force) {
      if (enable) {
        await disableSysProxy(options.helperTimeout)
        await enableSysProxy(options.helperTimeout)
      } else {
        await disableSysProxy(options.helperTimeout)
      }
      return
    }

    if (sequence !== triggerSysProxySequence) return
    triggerSysProxyTimer = setTimeout(() => {
      triggerSysProxyTimer = null
      if (sequence !== triggerSysProxySequence) return
      void triggerSysProxy(enable, options).catch((error) => {
        void proxyLogger.error('Failed to retry system proxy', error)
      })
    }, 5000)
  })

  triggerSysProxyQueue = operation.catch(() => {})
  return operation
}

async function enableSysProxy(helperTimeout?: number): Promise<void> {
  await startPacServer()
  const { sysProxy } = await getAppConfig()
  const { mode, host, bypass = defaultBypass } = sysProxy
  const { 'mixed-port': port = DEFAULT_MIHOMO_PORTS.mixed } = await getControledMihomoConfig()
  const proxyHost = host || '127.0.0.1'
  const formattedBypass = bypass
    .map((entry) => entry.trim())
    .filter(Boolean)
    .join(process.platform === 'win32' ? ';' : ',')

  if (process.platform === 'darwin') {
    await ensureMacService()
    await macServiceRequest(
      '/v1/network/proxy',
      mode === 'auto'
        ? { enabled: true, mode: 'auto', url: `http://${proxyHost}:${pacPort}/pac` }
        : { enabled: true, mode: 'manual', host: proxyHost, port, bypass },
      helperTimeout
    )
  } else {
    // Windows / Linux 直接使用 sysproxy-rs
    try {
      if (mode === 'auto') {
        triggerAutoProxy(true, `http://${proxyHost}:${pacPort}/pac`)
      } else {
        triggerManualProxy(true, proxyHost, port, formattedBypass)
      }
    } catch (error) {
      await proxyLogger.error('Failed to enable system proxy', error)
      throw error
    }
  }
}

async function disableSysProxy(helperTimeout?: number): Promise<void> {
  await stopPacServer()

  if (process.platform === 'darwin') {
    if (isMacServiceActive())
      await macServiceRequest('/v1/network/proxy', { enabled: false }, helperTimeout)
  } else {
    // Windows / Linux 直接使用 sysproxy-rs
    try {
      triggerAutoProxy(false, '')
      triggerManualProxy(false, '', 0, '')
    } catch (error) {
      await proxyLogger.error('Failed to disable system proxy', error)
      throw error
    }
  }
}

export function disableSysProxySync(): void {
  if (process.platform === 'darwin') return
  try {
    triggerAutoProxy(false, '')
    triggerManualProxy(false, '', 0, '')
  } catch {
    // ignore errors during sync disable
  }
}
