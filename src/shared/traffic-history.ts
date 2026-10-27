export const historyDimensions = [
  'domain',
  'process',
  'sourceIP',
  'destinationIP',
  'rule',
  'rulePayload',
  'policy',
  'proxy',
  'chain',
  'country',
  'asn',
  'network',
  'inbound',
  'processPath'
] as const
export type HistoryDimension = (typeof historyDimensions)[number]
export interface HistoryQuery {
  from: number
  to: number
  limit?: number
  cursor?: number
  interval?: '1m' | '1h' | '1d'
  resolution?: 'raw' | 'day'
  group_by?: string
  include_internal?: boolean
  filters?: Partial<Record<HistoryDimension, string>>
}
export interface HistoryResult<T> {
  data: T
  from: number
  to: number
  lastCommitAt: number
  truncated: boolean
  nextCursor?: number
  resolution?: 'raw' | 'day'
  aggregationTimezone?: string
}
export interface HistoryTotals {
  upload: number
  download: number
  connections: number
  participatingConnections?: number | null
}
export type HistoryGroup = HistoryTotals &
  Partial<Record<HistoryDimension, string | string[] | null>>
export type HistoryPoint = HistoryTotals & { time: number; endTime?: number }
export interface HistorySample {
  id: number
  flowId: number
  fromMs: number
  atMs: number
  upload: number
  download: number
  connections: number
}
export interface HistoryFlow {
  id: number
  sessionId: string
  trackerId: string
  startAtMs: number
  lastAtMs: number
  endAtMs: number | null
  baselineAtMs: number
  state: 'active' | 'closed' | 'unconfirmed' | 'suspended' | 'interrupted'
  accounted: boolean
  preexisting: boolean
  recordedUpload: number
  recordedDownload: number
  uploadTotal: number
  downloadTotal: number
  baselineUpload: number
  baselineDownload: number
  domain: string
  sourceIp: string
  destinationIp: string
  process: string
  processPath: string
  network: string
  inbound: string
  rule: string
  rulePayload: string
  policy: string
  proxy: string
  country: string
  asn: string
  chains: string[] | null
  providerChains: string[] | null
  metadata: Record<string, unknown>
  geo: Record<string, unknown>
}
export interface HistoryStatus {
  enabled: boolean
  ready: boolean
  healthy: boolean
  sessionId?: string
  startedAt?: number
  schemaVersion: number
  retentionDays: number
  sampleIntervalMs: number
  queueUsed: number
  pendingBytes: number
  droppedRecords: number
  skippedSamples: number
  writeErrors: number
  lastCommitAt: number
  lastError?: string
  geoWarnings?: string[]
  aggregationTimezone?: string
  detailAvailableFrom?: number | null
  aggregateAvailableFrom?: number | null
}
export type HistoryEndpoint =
  'summary' | 'series' | 'groups' | 'flows' | `flows/${number}` | `flows/${number}/samples`

export function historyParameters(query: HistoryQuery): Record<string, string | number | boolean> {
  const maxDays = query?.resolution === 'day' ? 367 : 31
  if (
    !query ||
    !Number.isSafeInteger(query.from) ||
    !Number.isSafeInteger(query.to) ||
    query.from < 0 ||
    query.to <= query.from ||
    query.to - query.from > maxDays * 86400000
  ) {
    throw new Error(`Choose a time range of up to ${maxDays} days`)
  }
  const { filters = {}, ...params } = query
  if (
    params.limit !== undefined &&
    (!Number.isInteger(params.limit) || params.limit < 1 || params.limit > 1000)
  )
    throw new Error('Invalid page size')
  if (params.cursor !== undefined && (!Number.isSafeInteger(params.cursor) || params.cursor < 0))
    throw new Error('Invalid cursor')
  if (params.interval !== undefined && !['1m', '1h', '1d'].includes(params.interval))
    throw new Error('Invalid interval')
  if (params.resolution !== undefined && !['raw', 'day'].includes(params.resolution))
    throw new Error('Invalid resolution')
  if (params.group_by !== undefined) {
    const dimensions = params.group_by.split(',')
    if (
      dimensions.length > 3 ||
      new Set(dimensions).size !== dimensions.length ||
      dimensions.some((d) => !historyDimensions.includes(d as HistoryDimension))
    )
      throw new Error('Invalid dimension')
  }
  for (const [key, value] of Object.entries(filters)) {
    if (
      !historyDimensions.includes(key as HistoryDimension) ||
      typeof value !== 'string' ||
      value.length > 8192
    )
      throw new Error('Invalid filter')
  }
  return { ...params, ...filters }
}

export function csvCell(value: unknown): string {
  const text = Array.isArray(value) ? JSON.stringify(value) : String(value ?? '')
  return `"${(/^[\s]*[=+@-]/.test(text) ? "'" + text : text).replaceAll('"', '""')}"`
}
