import { getAppConfig } from '../config/app'

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
  'lan-allowed-ips',
  'lan-disallowed-ips',
  'skip-auth-prefixes',
  'ipv6',
  'mode',
  'log-level',
  'find-process-mode',
  'tcp-concurrent',
  'unified-delay',
  'tun',
  'external-controller-unix',
  'external-controller-pipe'
] as const

export function managedTiziOverlay(config: object): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(config).filter(([key]) =>
      (managedOverlayKeys as readonly string[]).includes(key)
    )
  )
}
