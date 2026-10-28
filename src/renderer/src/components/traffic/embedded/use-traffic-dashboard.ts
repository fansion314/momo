import { useEffect, useRef, useState } from 'react'
import { queryTrafficHistory, trafficHistoryStatus } from '@renderer/utils/ipc'
import { historyRange, type HistoryPreset } from '@renderer/utils/traffic-history'
import type { HistoryResult, HistoryStatus } from '../../../../../shared/traffic-history'
import { loadDashboard, type DashboardSnapshot, type HistoryReader } from './model'

interface Options {
  preset: HistoryPreset
  resolution: 'raw' | 'day'
  from: string
  to: string
  includeInternal: boolean
  autoRefresh: boolean
  refresh: number
}

export function useTrafficDashboard(options: Options) {
  const { preset, resolution, from, to, includeInternal, autoRefresh, refresh } = options
  const [snapshot, setSnapshot] = useState<DashboardSnapshot>()
  const [status, setStatus] = useState<HistoryStatus>()
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const work = useRef<Promise<void>>(Promise.resolve())
  useEffect(() => {
    let cancelled = false
    let timer: ReturnType<typeof setTimeout> | undefined
    setSnapshot(undefined)
    setStatus(undefined)
    setError('')
    setLoading(true)
    const load = async (): Promise<void> => {
      if (cancelled) return
      if (document.hidden) {
        timer = setTimeout(enqueue, 10000)
        return
      }
      setLoading(true)
      try {
        const nextStatus = await trafficHistoryStatus()
        if (cancelled) return
        setStatus(nextStatus)
        if (!nextStatus.enabled || !nextStatus.ready) {
          setSnapshot(undefined)
          setError('')
          return
        }
        if ((preset === 'year' || resolution === 'day') && !nextStatus.aggregationTimezone)
          throw new Error('timezoneUnavailable')
        const query = {
          ...historyRange(preset, resolution, from, to, Date.now(), nextStatus.aggregationTimezone),
          include_internal: includeInternal
        }
        const read: HistoryReader = async <T>(endpoint, params) => {
          if (cancelled) throw new Error('cancelled')
          return queryTrafficHistory(endpoint, params) as Promise<HistoryResult<T>>
        }
        const next = await loadDashboard(read, query)
        if (!cancelled) {
          setSnapshot(next)
          setError('')
        }
      } catch (reason) {
        if (!cancelled) setError(reason instanceof Error ? reason.message : String(reason))
      } finally {
        if (!cancelled) {
          setLoading(false)
          if (autoRefresh) timer = setTimeout(enqueue, 10000)
        }
      }
    }
    const enqueue = (): void => {
      work.current = work.current.catch(() => {}).then(load)
    }
    enqueue()
    return () => {
      cancelled = true
      clearTimeout(timer)
    }
  }, [preset, resolution, from, to, includeInternal, autoRefresh, refresh])
  return { snapshot, status, loading, error }
}
