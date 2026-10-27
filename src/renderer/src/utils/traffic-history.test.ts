import { describe, expect, it } from 'vitest'
import {
  dimensionLabel,
  dimensionValue,
  exactHistoryValue,
  historyRange,
  historyDayBoundary,
  rankGroups,
  rowsCsv
} from './traffic-history'

describe('traffic history presentation', () => {
  it('keeps chain order and serializes the exact filter independently of its display label', () => {
    const row = { chain: ['node', 'policy'], upload: 1, download: 2, connections: 1 }
    expect(dimensionValue(row, 'chain')).toBe('["node","policy"]')
    expect(dimensionLabel(dimensionValue(row, 'chain'), 'chain')).toBe('node → policy')
    expect(dimensionValue({ upload: 0, download: 0, connections: 0 }, 'chain')).toBe('null')
    expect(dimensionLabel('null', 'chain')).toBe('')
    expect(exactHistoryValue('chain', '[ "node", "policy" ]')).toBe('["node","policy"]')
    expect(exactHistoryValue('chain', 'null')).toBe('null')
    expect(exactHistoryValue('chain', '["A&B<node>"]')).toBe('["A\\u0026B\\u003cnode\\u003e"]')
    expect(() => exactHistoryValue('chain', '[1]')).toThrow('invalidChain')
  })
  it('aligns daily boundaries in the saved timezone across DST', () => {
    const time = Date.parse('2026-11-01T15:00:00Z')
    expect(historyDayBoundary(time, 'America/New_York')).toBe(Date.parse('2026-11-01T04:00:00Z'))
    expect(historyDayBoundary(time, 'America/New_York', 1)).toBe(Date.parse('2026-11-02T05:00:00Z'))
    expect(historyDayBoundary(time, 'Asia/Shanghai')).toBe(Date.parse('2026-10-31T16:00:00Z'))
  })
  it.each([
    [
      'America/Sao_Paulo',
      '2018-11-04T12:00:00Z',
      '2018-11-04T03:00:00Z',
      '2018-11-05T02:00:00Z',
      23
    ],
    [
      'America/Santiago',
      '2026-09-06T12:00:00Z',
      '2026-09-06T04:00:00Z',
      '2026-09-07T03:00:00Z',
      23
    ],
    ['America/Havana', '2026-11-01T12:00:00Z', '2026-11-01T04:00:00Z', '2026-11-02T05:00:00Z', 25]
  ] as const)(
    'uses the first instant of skipped or repeated midnight in %s',
    (zone, noon, expectedStart, expectedEnd, hours) => {
      const start = historyDayBoundary(Date.parse(noon), zone)
      const end = historyDayBoundary(Date.parse(noon), zone, 1)
      expect(start).toBe(Date.parse(expectedStart))
      expect(end).toBe(Date.parse(expectedEnd))
      expect(end - start).toBe(hours * 3600000)
      expect(historyDayBoundary(start, zone)).toBe(start)
      expect(historyDayBoundary(start - 1, zone, 1)).toBe(start)
      const range = historyRange(
        'custom',
        'day',
        new Date(start).toISOString(),
        new Date(end).toISOString(),
        0,
        zone
      )
      expect(range.from).toBe(start)
      expect(range.to).toBe(end)
    }
  )
  it('does not fabricate a separate day when the saved timezone skips a civil date', () => {
    const beforeSkip = Date.parse('2011-12-29T12:00:00Z')
    const nextValidDay = Date.parse('2011-12-30T10:00:00Z')
    expect(historyDayBoundary(beforeSkip, 'Pacific/Apia', 1)).toBe(nextValidDay)
    expect(historyDayBoundary(beforeSkip, 'Pacific/Apia', 2)).toBe(nextValidDay)
    expect(historyDayBoundary(nextValidDay, 'Pacific/Apia')).toBe(nextValidDay)
  })
  it('accepts 366 saved-zone calendar days spanning a DST offset change', () => {
    const range = historyRange(
      'custom',
      'day',
      '2025-11-02T04:00:00Z',
      '2026-11-03T05:00:00Z',
      0,
      'America/New_York'
    )
    expect(range.to - range.from).toBe(366 * 86400000 + 3600000)
    expect(range.interval).toBe('1d')
    expect(() =>
      historyRange(
        'custom',
        'day',
        '2025-11-02T04:00:00Z',
        '2026-11-04T05:00:00Z',
        0,
        'America/New_York'
      )
    ).toThrow('rangeTooLong')
  })
  it('rejects unresolvable saved timezones instead of substituting UTC', () => {
    expect(() => historyDayBoundary(Date.now(), 'system-local')).toThrow('timezoneUnavailable')
  })
  it('rejects invalid dates and raw ranges beyond detail retention query bounds', () => {
    expect(() => historyRange('custom', 'raw', 'bad', '2026-01-01')).toThrow('invalidRange')
    expect(() => historyRange('custom', 'raw', '2026-01-01', '2026-04-01')).toThrow('rangeTooLong')
    expect(historyRange('year', 'raw', '', '', 1800000000000).resolution).toBe('day')
  })
  it('searches then sorts without mutating server rankings', () => {
    const rows = [
      { domain: 'A.example', upload: 20, download: 0, connections: 1 },
      { domain: 'b.example', upload: 3, download: 10, connections: 2 }
    ]
    expect(rankGroups(rows, 'domain', '.EXAMPLE', 'download', false)[0].domain).toBe('b.example')
    expect(rows[0].domain).toBe('A.example')
  })
  it('neutralizes spreadsheet formulas, escapes nested values and preserves every column', () => {
    const csv = rowsCsv([
      { domain: ' =1+1', chain: ['a,b', 'c"d'] },
      { domain: '@SUM(A1)', other: 2 }
    ])
    expect(csv).toContain('"\' =1+1"')
    expect(csv).toContain('"\'@SUM(A1)"')
    expect(csv).toContain('"other"')
    expect(csv).toContain('[""a,b"",""c\\""d""]')
  })
})
