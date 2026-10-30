import { getAppConfig } from '../config/app'
import { DEFAULT_CONTROL_DNS, DEFAULT_CONTROL_SNIFF } from '../../shared/appConfig'

export function tiziFeatureEnabled(): boolean {
  return typeof __TIZI_ENABLED__ !== 'undefined' && __TIZI_ENABLED__
}

export function managedTiziActive(config: Pick<IAppConfig, 'tiziActive'>): boolean {
  return tiziFeatureEnabled() && config.tiziActive === true
}

export async function assertConfigurationBackupAllowed(): Promise<void> {
  if (managedTiziActive(await getAppConfig()))
    throw new Error('团购订阅使用期间已停用配置备份与同步；切换至私人订阅后恢复。')
}

// Never merge proxies, rules, scripts or provider definitions into a managed configuration.
export const managedOverlayKeys = [
  'mixed-port',
  'port',
  'socks-port',
  'redir-port',
  'tproxy-port',
  'allow-lan',
  'bind-address',
  'authentication',
  'secret',
  'lan-allowed-ips',
  'lan-disallowed-ips',
  'skip-auth-prefixes',
  'ipv6',
  'mode',
  'log-level',
  'find-process-mode',
  'tcp-concurrent',
  'unified-delay',
  'interface-name',
  'profile',
  'geodata-mode',
  'geo-auto-update',
  'geo-update-interval',
  'geox-url',
  'lgbm-auto-update',
  'lgbm-update-interval',
  'lgbm-url',
  'tun',
  'dns',
  'hosts',
  'sniffer',
  'external-controller-unix',
  'external-controller-pipe'
] as const

export function managedTiziOverlay(
  config: object,
  settings: Partial<IAppConfig> = {}
): Record<string, unknown> {
  const overlay = structuredClone(
    Object.fromEntries(
      Object.entries(config).filter(([key]) =>
        (managedOverlayKeys as readonly string[]).includes(key)
      )
    )
  )
  if (!(settings.controlDns ?? DEFAULT_CONTROL_DNS)) {
    delete overlay.dns
    delete overlay.hosts
  }
  if (!(settings.controlSniff ?? DEFAULT_CONTROL_SNIFF)) delete overlay.sniffer
  if (!settings.useNameserverPolicy && overlay.dns && typeof overlay.dns === 'object')
    delete (overlay.dns as Record<string, unknown>)['nameserver-policy']
  return overlay
}

export function managedSmartPolicy(config: Partial<IAppConfig>): {
  enabled: boolean
  useLightGBM: boolean
  collectData: boolean
  collectorSize: number
} {
  const size = config.smartCollectorSize ?? 100
  return {
    enabled: (config.core ?? 'mihomomo') === 'mihomomo' && (config.enableSmartOverride ?? true),
    useLightGBM: config.smartCoreUseLightGBM ?? false,
    collectData: config.smartCoreCollectData ?? false,
    collectorSize: Number.isSafeInteger(size) ? Math.min(100000, Math.max(1, size)) : 100
  }
}
