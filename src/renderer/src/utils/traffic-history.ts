import {
  csvCell,
  type HistoryDimension,
  type HistoryFlow,
  type HistoryGroup,
  type HistoryQuery
} from '../../../shared/traffic-history'

export type HistoryPreset = '1h' | '24h' | '7d' | '30d' | 'year' | 'custom'
export type HistorySort = 'total' | 'upload' | 'download' | 'connections' | 'label'
export const dayMs = 86400000

export function historyRange(
  preset: HistoryPreset,
  resolution: 'raw' | 'day',
  customFrom: string,
  customTo: string,
  now = Date.now(),
  timeZone = 'UTC'
): Pick<HistoryQuery, 'from' | 'to' | 'resolution' | 'interval'> {
  const durations = {
    '1h': 3600000,
    '24h': dayMs,
    '7d': 7 * dayMs,
    '30d': 30 * dayMs,
    year: 365 * dayMs
  }
  let from = preset === 'custom' ? new Date(customFrom).getTime() : now - durations[preset]
  let to = preset === 'custom' ? new Date(customTo).getTime() : now
  if (!Number.isSafeInteger(from) || !Number.isSafeInteger(to) || from < 0 || to <= from) {
    throw new Error('invalidRange')
  }
  const actualResolution = preset === 'year' ? 'day' : resolution
  if (actualResolution === 'day') {
    from = historyDayBoundary(from, timeZone)
    const floorTo = historyDayBoundary(to, timeZone)
    to = to === floorTo ? to : historyDayBoundary(to, timeZone, 1)
  }
  const span =
    actualResolution === 'day'
      ? historyCalendarDay(to, timeZone) - historyCalendarDay(from, timeZone)
      : (to - from) / dayMs
  if (span > (actualResolution === 'day' ? 366 : 31)) throw new Error('rangeTooLong')
  return {
    from,
    to,
    resolution: actualResolution,
    interval:
      actualResolution === 'day' || to - from > 7 * dayMs ? '1d' : to - from > 3600000 ? '1h' : '1m'
  }
}

export function dimensionValue(row: HistoryGroup, dimension: HistoryDimension): string {
  const value = row[dimension]
  if (dimension === 'chain' && value == null) return 'null'
  return Array.isArray(value) ? JSON.stringify(value) : String(value ?? '')
}

export function dimensionLabel(value: string, dimension: HistoryDimension): string {
  if (dimension !== 'chain') return value
  try {
    const chain: unknown = JSON.parse(value)
    if (chain === null) return ''
    return Array.isArray(chain) ? chain.join(' → ') : value
  } catch {
    return value
  }
}

export function flowDimension(flow: HistoryFlow, dimension: HistoryDimension): string {
  if (dimension === 'chain') return JSON.stringify(flow.chains)
  if (dimension === 'process') return flow.processPath || flow.process
  if (dimension === 'sourceIP') return flow.sourceIp
  if (dimension === 'destinationIP') return flow.destinationIp
  return flow[dimension]
}

export function rankGroups(
  rows: HistoryGroup[],
  dimension: HistoryDimension,
  search: string,
  sort: HistorySort,
  ascending: boolean
): HistoryGroup[] {
  const query = search.trim().toLocaleLowerCase()
  return rows
    .filter((row) =>
      dimensionLabel(dimensionValue(row, dimension), dimension).toLocaleLowerCase().includes(query)
    )
    .sort((a, b) => {
      const difference =
        sort === 'label'
          ? dimensionLabel(dimensionValue(a, dimension), dimension).localeCompare(
              dimensionLabel(dimensionValue(b, dimension), dimension)
            )
          : sort === 'total'
            ? a.upload + a.download - b.upload - b.download
            : a[sort] - b[sort]
      return (ascending ? 1 : -1) * difference
    })
}

export function rowsCsv(rows: Record<string, unknown>[]): string {
  const columns = [...new Set(rows.flatMap((row) => Object.keys(row)))]
  return (
    '\uFEFF' +
    [
      columns.map(csvCell).join(','),
      ...rows.map((row) =>
        columns
          .map((key) => {
            const value = row[key]
            return csvCell(
              value !== null && typeof value === 'object' ? JSON.stringify(value) : value
            )
          })
          .join(',')
      )
    ].join('\r\n')
  )
}

export function saveHistoryExport(
  name: string,
  format: 'csv' | 'json',
  rows: Record<string, unknown>[],
  context: Record<string, unknown>
): void {
  const content = format === 'csv' ? rowsCsv(rows) : JSON.stringify({ ...context, rows }, null, 2)
  const url = URL.createObjectURL(
    new Blob([content], { type: format === 'csv' ? 'text/csv;charset=utf-8' : 'application/json' })
  )
  const link = document.createElement('a')
  link.href = url
  link.download = `${name}.${format}`
  link.click()
  setTimeout(() => URL.revokeObjectURL(url), 1000)
}

export function localDateTime(time: number): string {
  const date = new Date(time)
  return new Date(time - date.getTimezoneOffset() * 60000).toISOString().slice(0, 16)
}

/** First valid instant of a calendar date in the saved database timezone. */
export function historyDayBoundary(time: number, timeZone: string, addDays = 0): number {
  let format: Intl.DateTimeFormat
  try {
    format = new Intl.DateTimeFormat('en-CA', {
      timeZone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit'
    })
  } catch {
    throw new Error('timezoneUnavailable')
  }
  const parts = (value: number): Record<string, number> =>
    Object.fromEntries(
      format
        .formatToParts(value)
        .filter((part) => part.type !== 'literal')
        .map((part) => [part.type, Number(part.value)])
    )
  const date = parts(time)
  const desired = Date.UTC(date.year, date.month - 1, date.day + addDays)
  // Wall midnight can be skipped or repeated. Search by civil date rather
  // than selecting a UTC offset; the first valid instant can be 01:00.
  let low = desired - 2 * dayMs
  let high = desired + 2 * dayMs
  while (high - low > 1) {
    const middle = low + Math.floor((high - low) / 2)
    const local = parts(middle)
    const dateKey = Date.UTC(local.year, local.month - 1, local.day)
    if (dateKey < desired) low = middle
    else high = middle
  }
  return high
}

function historyCalendarDay(time: number, timeZone: string): number {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit'
  }).formatToParts(time)
  const fields = Object.fromEntries(parts.map((part) => [part.type, part.value]))
  return Date.UTC(Number(fields.year), Number(fields.month) - 1, Number(fields.day)) / dayMs
}

export function exactHistoryValue(dimension: HistoryDimension, value: string): string {
  if (dimension !== 'chain') return value
  try {
    const parsed: unknown = JSON.parse(value)
    if (
      parsed === null ||
      (Array.isArray(parsed) && parsed.every((hop) => typeof hop === 'string'))
    )
      return JSON.stringify(parsed).replace(
        /[<>&\u2028\u2029]/g,
        (character) => `\\u${character.charCodeAt(0).toString(16).padStart(4, '0')}`
      )
  } catch {
    // The chain filter compares the canonical JSON stored by the recorder.
  }
  throw new Error('invalidChain')
}
