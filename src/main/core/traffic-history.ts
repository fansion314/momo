import { getAppConfig, patchAppConfig } from '../config/app'
import {
  historyParameters,
  type HistoryEndpoint,
  type HistoryQuery,
  type HistoryStatus
} from '../../shared/traffic-history'
import { getAxios, mihomoHotReloadConfig } from './mihomoApi'
import { hasCoreProcess } from './manager'

let tail: Promise<unknown> = Promise.resolve()
let pending = 0
export async function queryTrafficHistory(
  endpoint: HistoryEndpoint,
  query: HistoryQuery
): Promise<unknown> {
  if (
    typeof endpoint !== 'string' ||
    !/^(summary|series|groups|flows(?:\/[1-9]\d*(?:\/samples)?)?)$/.test(endpoint)
  )
    throw new Error('Invalid history endpoint')
  const params = historyParameters(query)
  if (pending >= 12) throw new Error('Traffic history is busy; retry shortly')
  pending++
  const current = tail.then(async () =>
    (await getAxios()).get(`/traffic-history/${endpoint}`, { params, timeout: 5000 })
  )
  tail = current.catch(() => undefined)
  try {
    return await current
  } finally {
    pending--
  }
}
export async function trafficHistoryStatus(): Promise<HistoryStatus> {
  return (await getAxios()).get<never, HistoryStatus>('/traffic-history/status', { timeout: 5000 })
}

let configTail: Promise<void> = Promise.resolve()
export function patchAppConfigWithHistory(patch: Partial<IAppConfig>): Promise<void> {
  const operation = configTail.then(async () => {
    const before = await getAppConfig()
    const oldEnabled = before.enableTrafficLogger
    const oldRetention = before.trafficHistoryRetentionDays
    await patchAppConfig(patch)
    const after = await getAppConfig()
    if (
      (oldEnabled !== after.enableTrafficLogger ||
        oldRetention !== after.trafficHistoryRetentionDays) &&
      hasCoreProcess()
    ) {
      try {
        await mihomoHotReloadConfig()
      } catch (applyError) {
        try {
          // Restore only history preferences; unrelated changes in this patch stay saved.
          await patchAppConfig({
            enableTrafficLogger: oldEnabled,
            trafficHistoryRetentionDays: oldRetention
          })
          if (hasCoreProcess()) await mihomoHotReloadConfig()
        } catch (rollbackError) {
          throw new Error(
            `Traffic history settings failed to apply and rollback could not be confirmed. The kernel capture state is unconfirmed. Apply error: ${String(applyError)}. Rollback error: ${String(rollbackError)}`,
            { cause: new AggregateError([applyError, rollbackError]) }
          )
        }
        throw applyError
      }
    }
  })
  configTail = operation.catch(() => undefined)
  return operation
}
