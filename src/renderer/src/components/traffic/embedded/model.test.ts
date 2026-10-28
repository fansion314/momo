import { describe, expect, it } from 'vitest'
import type {
  HistoryPoint,
  HistoryQuery,
  HistoryResult
} from '../../../../../shared/traffic-history'
import { loadDashboard, selectionQuery, trendPoints, type HistoryReader } from './model'

const query: HistoryQuery = {
  from: 30000,
  to: 150000,
  interval: '1m',
  resolution: 'raw',
  include_internal: true
}
function result<T>(data: T, truncated = false): HistoryResult<T> {
  return { data, from: query.from, to: query.to, lastCommitAt: 140000, truncated }
}

describe('embedded traffic adapter', () => {
  it('uses one bounded range and preserves daily resolution and exact filters across all five modules', async () => {
    const calls: { endpoint: string; query: HistoryQuery }[] = []
    const dailyQuery: HistoryQuery = {
      ...query,
      resolution: 'day',
      interval: '1d',
      filters: { country: 'CN' }
    }
    const read: HistoryReader = async <T>(endpoint, params) => {
      calls.push({ endpoint, query: params })
      return result(
        (endpoint === 'summary' ? { upload: 2, download: 3, connections: 1 } : []) as T,
        endpoint === 'groups'
      )
    }
    const snapshot = await loadDashboard(read, dailyQuery)
    expect(calls.map((call) => call.endpoint)).toEqual([
      'summary',
      'series',
      ...Array(5).fill('groups')
    ])
    expect(calls.slice(2).map((call) => call.query.group_by)).toEqual([
      'domain',
      'policy',
      'proxy',
      'country',
      'destinationIP'
    ])
    for (const call of calls) {
      expect(call.query).toMatchObject(dailyQuery)
      expect(call.query.limit ?? 1000).toBeLessThanOrEqual(1000)
    }
    expect(snapshot.summary.data).toEqual({ upload: 2, download: 3, connections: 1 })
    expect(snapshot.groups.domain.truncated).toBe(true)
  })

  it('does not return a partial dashboard as a successful read', async () => {
    const read: HistoryReader = async <T>(endpoint) => {
      if (endpoint === 'series') throw new Error('history unavailable')
      return result({ upload: 2, download: 3, connections: 1 } as T)
    }
    await expect(loadDashboard(read, query)).rejects.toThrow('history unavailable')
  })

  it('adds exact drilldown filters without dropping internal traffic or range bounds', () => {
    const original = { ...query, filters: { country: 'CN' } }
    expect(selectionQuery(original, { dimension: 'domain', value: '' })).toEqual({
      ...original,
      filters: { country: 'CN', domain: '' }
    })
    expect(original.filters).toEqual({ country: 'CN' })
    expect(
      selectionQuery(original, {
        dimension: 'rule',
        value: 'RuleSet',
        filters: { rulePayload: 'ai', proxy: 'Japan | 01' }
      }).filters
    ).toEqual({ country: 'CN', rule: 'RuleSet', rulePayload: 'ai', proxy: 'Japan | 01' })
  })

  it('fills raw gaps and computes averages over clipped partial buckets, without losing bytes', () => {
    const points = result<HistoryPoint[]>([
      { time: 0, upload: 300, download: 600, connections: 1 },
      { time: 120000, upload: 900, download: 1500, connections: 2 }
    ])
    const traffic = trendPoints(points, query, false)
    expect(traffic).toEqual([
      { timestamp: 0, upload: 300, download: 600 },
      { timestamp: 60000, upload: 0, download: 0 },
      { timestamp: 120000, upload: 900, download: 1500 }
    ])
    expect(trendPoints(points, query, true)).toEqual([
      { timestamp: 0, upload: 10, download: 20 },
      { timestamp: 60000, upload: 0, download: 0 },
      { timestamp: 120000, upload: 30, download: 50 }
    ])
  })

  it('uses actual 25-hour saved-zone days for speed instead of assuming 24 hours', () => {
    const from = Date.parse('2026-11-01T04:00:00Z')
    const to = Date.parse('2026-11-02T05:00:00Z')
    const daily = { from, to, resolution: 'day', interval: '1d' } as const
    const points = result<HistoryPoint[]>([
      { time: from, endTime: to, upload: 90000, download: 180000, connections: 1 }
    ])
    expect(trendPoints(points, daily, true)).toEqual([{ timestamp: from, upload: 1, download: 2 }])
    expect(trendPoints(points, daily, false)[0].download).toBe(180000)
  })

  it('does not fabricate zero-valued buckets when the server truncated the series', () => {
    const points = result<HistoryPoint[]>(
      [{ time: 0, upload: 0, download: 1, connections: 0 }],
      true
    )
    expect(trendPoints(points, query, false)).toHaveLength(1)
  })
})
