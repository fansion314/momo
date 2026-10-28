import { useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Spinner } from '@heroui/react'
import { LuX } from 'react-icons/lu'
import { queryTrafficHistory } from '@renderer/utils/ipc'
import TrafficRouteMap from '../traffic-route-map'
import TrafficDetailsTable from '../traffic-details-table'
import TrafficFlowDetail from '../traffic-flow-detail'
import type {
  HistoryFlow,
  HistoryGroup,
  HistoryQuery,
  HistoryResult
} from '../../../../../shared/traffic-history'
import { GroupName, GroupTable, TopBars } from './panels'
import { selectionQuery, type Selection } from './model'

type DetailTab =
  'domain' | 'destinationIP' | 'proxy' | 'country' | 'matchedRules' | 'routes' | 'flows'
type DetailGroups = Record<Exclude<DetailTab, 'flows'>, HistoryResult<HistoryGroup[]>>

export default function SelectionDetails({
  selection,
  query,
  onSelect,
  onClose
}: {
  selection: Selection
  query: HistoryQuery
  onSelect: (selection: Selection) => void
  onClose: () => void
}) {
  const { t } = useTranslation()
  const [tab, setTab] = useState<DetailTab>('domain')
  const [state, setState] = useState<{ key: string; groups: DetailGroups }>()
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(true)
  const queue = useRef<Promise<void>>(Promise.resolve())
  const detailRef = useRef<HTMLElement>(null)
  useEffect(() => {
    detailRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' })
  }, [])
  const key = JSON.stringify(selectionQuery(query, selection))
  useEffect(() => {
    let cancelled = false
    setLoading(true)
    setError('')
    const filtered: HistoryQuery = JSON.parse(key)
    const load = async (): Promise<void> => {
      if (cancelled) return
      try {
        const groups = {} as DetailGroups
        for (const dimension of [
          'domain',
          'destinationIP',
          'proxy',
          'country',
          'matchedRules',
          'routes'
        ] as const) {
          if (cancelled) return
          groups[dimension] = (await queryTrafficHistory('groups', {
            ...filtered,
            group_by:
              dimension === 'routes'
                ? 'rule,policy,chain'
                : dimension === 'matchedRules'
                  ? 'rule,rulePayload'
                  : dimension,
            limit: 1000
          })) as HistoryResult<HistoryGroup[]>
        }
        if (!cancelled) setState({ key, groups })
      } catch (reason) {
        if (!cancelled) setError(String(reason))
      } finally {
        if (!cancelled) setLoading(false)
      }
    }
    queue.current = queue.current.catch(() => {}).then(load)
    return () => {
      cancelled = true
    }
  }, [key])
  const groups = state?.key === key ? state.groups : undefined
  const filtered = selectionQuery(query, selection)
  return (
    <section
      ref={detailRef}
      className="space-y-4 traffic-detail"
      aria-label={t('traffic.embedded.details')}
    >
      <div className="flex items-center gap-3">
        <h2 className="flex min-w-0 items-center gap-2 text-sm font-semibold">
          <span className="text-foreground/50 shrink-0">{t('traffic.embedded.details')}</span>
          <GroupName value={selection.value} dimension={selection.dimension} />
        </h2>
        {loading && <Spinner size="sm" aria-label={t('traffic.history.loading')} />}
        <button
          type="button"
          className="traffic-icon-button ml-auto"
          aria-label={t('traffic.embedded.closeDetails')}
          onClick={onClose}
        >
          <LuX size={18} />
        </button>
      </div>
      {error && (
        <p role="alert" className="text-sm text-danger break-all">
          {error}
        </p>
      )}
      {selection.filters && (
        <div className="flex flex-wrap gap-2 text-xs text-foreground/60">
          {Object.entries(selection.filters)
            .filter(([dimension]) => dimension !== selection.dimension)
            .map(([dimension, value]) => (
              <span className="rounded-lg bg-primary/10 px-2 py-1" key={dimension}>
                {t(`traffic.history.dimension.${dimension}`)}:{' '}
                <GroupName dimension={dimension as Selection['dimension']} value={value} />
              </span>
            ))}
        </div>
      )}
      {groups && (
        <TopBars
          data={groups.domain.data}
          dimension="domain"
          onSelect={onSelect}
          title={t('traffic.embedded.topDomains')}
        />
      )}
      <div className="traffic-segments w-fit max-w-full overflow-auto">
        {(
          [
            'domain',
            'destinationIP',
            'proxy',
            'country',
            'matchedRules',
            'routes',
            'flows'
          ] as const
        ).map((value) => (
          <button
            type="button"
            key={value}
            aria-pressed={tab === value}
            onClick={() => setTab(value)}
          >
            {t(
              value === 'matchedRules'
                ? 'traffic.embedded.matchedRules'
                : value === 'routes' || value === 'flows'
                  ? `traffic.history.${value}`
                  : `traffic.history.dimension.${value}`
            )}
          </button>
        ))}
      </div>
      {tab === 'flows' ? (
        <FlowRecords query={filtered} onSelect={onSelect} />
      ) : (
        groups &&
        (tab === 'routes' ? (
          <div className="traffic-panel">
            <TrafficRouteMap
              data={groups.routes.data}
              onFilter={(dimension, value) => onSelect({ dimension, value })}
            />
            {groups.routes.truncated && (
              <p className="text-xs text-warning mt-3">{t('traffic.history.topTruncated')}</p>
            )}
          </div>
        ) : (
          <GroupTable
            key={tab}
            result={groups[tab]}
            dimension={tab === 'matchedRules' ? 'rule' : tab}
            secondaryDimension={tab === 'matchedRules' ? 'rulePayload' : undefined}
            query={filtered}
            onSelect={onSelect}
          />
        ))
      )}
    </section>
  )
}

function FlowRecords({
  query,
  onSelect
}: {
  query: HistoryQuery
  onSelect: (selection: Selection) => void
}) {
  const { t } = useTranslation()
  const [cursor, setCursor] = useState<number>()
  const [previous, setPrevious] = useState<(number | undefined)[]>([])
  const [result, setResult] = useState<HistoryResult<HistoryFlow[]>>()
  const [selected, setSelected] = useState<HistoryFlow>()
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  // Freeze range membership while paging; remount when the user changes selection.
  const [range] = useState(query)
  const key = JSON.stringify(range)
  useEffect(() => {
    let cancelled = false
    if (range.resolution === 'day') return
    setLoading(true)
    setResult(undefined)
    setError('')
    queryTrafficHistory('flows', { ...JSON.parse(key), limit: 50, cursor })
      .then((value) => {
        if (!cancelled) setResult(value as HistoryResult<HistoryFlow[]>)
      })
      .catch((reason) => {
        if (!cancelled) setError(String(reason))
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [key, cursor, range.resolution])
  if (range.resolution === 'day')
    return (
      <p className="traffic-panel text-sm text-foreground/60">
        {t('traffic.history.dailyNoFlows')}
      </p>
    )
  return (
    <div className="traffic-panel space-y-3">
      <p className="text-xs text-foreground/50">
        {t('traffic.history.flowScope')} {t('traffic.history.frozenFlowRange')}
      </p>
      {error && (
        <p role="alert" className="text-sm text-danger">
          {error}
        </p>
      )}
      {loading && <Spinner size="sm" aria-label={t('traffic.history.loading')} />}
      {result && <TrafficDetailsTable flows={result.data} onSelect={setSelected} />}
      <div className="flex justify-end gap-2">
        <button
          type="button"
          className="traffic-button"
          disabled={!previous.length || loading}
          onClick={() => {
            setCursor(previous.at(-1))
            setPrevious((values) => values.slice(0, -1))
          }}
        >
          {t('traffic.history.previous')}
        </button>
        <button
          type="button"
          className="traffic-button"
          disabled={!result?.truncated || result.nextCursor === undefined || loading}
          onClick={() => {
            setPrevious((values) => [...values, cursor])
            setCursor(result?.nextCursor)
          }}
        >
          {t('traffic.history.next')}
        </button>
      </div>
      {selected && (
        <TrafficFlowDetail
          key={selected.id}
          flow={selected}
          query={range}
          onClose={() => setSelected(undefined)}
          onFilter={(dimension, value) => onSelect({ dimension, value })}
        />
      )}
    </div>
  )
}
