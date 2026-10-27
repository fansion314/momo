import path from 'path'
import { mihomoWorkDir } from '../utils/dirs'

export function applyHistoryConfig(profile: object, config: IAppConfig): void {
  ;(profile as Record<string, unknown>)['traffic-history'] = {
    enable: config.enableTrafficLogger !== false,
    path: path.join(mihomoWorkDir(), 'traffic-history.db'),
    'sample-interval': '5s',
    'flush-interval': '1s',
    'retention-days': config.trafficHistoryRetentionDays ?? 30,
    'shutdown-timeout': '5s',
    geoip: { enable: true }
  }
}
