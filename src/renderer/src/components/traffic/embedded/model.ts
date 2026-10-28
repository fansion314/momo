import type {
  HistoryDimension,
  HistoryEndpoint,
  HistoryGroup,
  HistoryPoint,
  HistoryQuery,
  HistoryResult,
  HistoryTotals
} from '../../../../../shared/traffic-history'

export const modules = ['overview', 'rules', 'domains', 'countries', 'proxies'] as const
export type TrafficModule = (typeof modules)[number]
export const dimensions = ['domain', 'policy', 'proxy', 'country', 'destinationIP'] as const
export type DashboardDimension = (typeof dimensions)[number]
export const moduleDimensions = {
  rules: 'policy',
  domains: 'domain',
  countries: 'country',
  proxies: 'proxy'
} as const
export interface DashboardSnapshot {
  query: HistoryQuery
  summary: HistoryResult<HistoryTotals>
  series: HistoryResult<HistoryPoint[]>
  groups: Record<DashboardDimension, HistoryResult<HistoryGroup[]>>
}
export type HistoryReader = <T>(
  endpoint: HistoryEndpoint,
  query: HistoryQuery
) => Promise<HistoryResult<T>>

// All panels use the same bounds. Group responses are top-N, not exact cardinalities.
export async function loadDashboard(
  read: HistoryReader,
  query: HistoryQuery
): Promise<DashboardSnapshot> {
  const summary = await read<HistoryTotals>('summary', query)
  const series = await read<HistoryPoint[]>('series', { ...query, limit: 1000 })
  const groups = {} as DashboardSnapshot['groups']
  for (const dimension of dimensions) {
    groups[dimension] = await read<HistoryGroup[]>('groups', {
      ...query,
      group_by: dimension,
      limit: 1000
    })
  }
  return { query, summary, series, groups }
}

export interface Selection {
  dimension: HistoryDimension
  value: string
  filters?: HistoryQuery['filters']
}
export function selectionQuery(query: HistoryQuery, selection: Selection): HistoryQuery {
  return {
    ...query,
    filters: { ...query.filters, ...selection.filters, [selection.dimension]: selection.value }
  }
}

export function total(row: HistoryTotals): number {
  return row.upload + row.download
}

export function countryLabel(value: string, locale: string): string {
  if (!/^[A-Za-z]{2}$/.test(value)) return value
  try {
    return new Intl.DisplayNames([locale], { type: 'region' }).of(value.toUpperCase()) || value
  } catch {
    return value
  }
}

export function intervalMs(query: HistoryQuery): number {
  return query.interval === '1d' ? 86400000 : query.interval === '1h' ? 3600000 : 60000
}

export function trendPoints(
  result: HistoryResult<HistoryPoint[]>,
  query: HistoryQuery,
  speed: boolean
): { timestamp: number; upload: number; download: number }[] {
  const step = intervalMs(query)
  const points = new Map(result.data.map((point) => [point.time, point]))
  // Daily boundaries follow the saved calendar, including DST. Raw buckets are UTC aligned.
  const times =
    query.resolution === 'day' || result.truncated
      ? result.data.map((point) => point.time)
      : Array.from(
          { length: Math.min(1000, Math.ceil(query.to / step) - Math.floor(query.from / step)) },
          (_, index) => Math.floor(query.from / step) * step + index * step
        )
  return times.map((time) => {
    const point = points.get(time)
    const seconds = Math.max(
      0.001,
      (Math.min(query.to, point?.endTime ?? time + step) - Math.max(query.from, time)) / 1000
    )
    return {
      timestamp: time,
      upload: (point?.upload ?? 0) / (speed ? seconds : 1),
      download: (point?.download ?? 0) / (speed ? seconds : 1)
    }
  })
}
