import BasePage from '@renderer/components/base/base-page'
import TrafficRankings from '@renderer/components/traffic/traffic-rankings'
import TrafficTrendChart from '@renderer/components/traffic/traffic-trend-chart'
import TrafficDetailsTable from '@renderer/components/traffic/traffic-details-table'
import TrafficRouteMap from '@renderer/components/traffic/traffic-route-map'
import TrafficFlowDetail from '@renderer/components/traffic/traffic-flow-detail'
import { Button, Chip, Input, Spinner, Switch, Tab, Tabs } from '@heroui/react'
import { useAppConfig } from '@renderer/hooks/use-app-config'
import { patchAppConfig, queryTrafficHistory, trafficHistoryStatus } from '@renderer/utils/ipc'
import { calcTraffic } from '@renderer/utils/calc'
import {
  dimensionLabel,
  exactHistoryValue,
  historyRange,
  localDateTime,
  rankGroups,
  saveHistoryExport,
  type HistoryPreset,
  type HistorySort
} from '@renderer/utils/traffic-history'
import { useEffect, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import {
  historyDimensions,
  type HistoryDimension,
  type HistoryFlow,
  type HistoryGroup,
  type HistoryPoint,
  type HistoryQuery,
  type HistoryResult,
  type HistoryStatus,
  type HistoryTotals
} from '../../../shared/traffic-history'

type View = 'rankings' | 'routes' | 'flows'
interface Snapshot {
  query: HistoryQuery
  summary: HistoryResult<HistoryTotals>
  series: HistoryResult<HistoryPoint[]>
  groups: HistoryResult<HistoryGroup[]>
  routes: HistoryResult<HistoryGroup[]>
  flows?: HistoryResult<HistoryFlow[]>
}
const selectClass =
  'rounded-lg bg-content2 text-foreground border border-foreground/15 text-sm px-2 py-2 min-w-0 focus-visible:outline-primary'
const sectionClass = 'rounded-xl border border-foreground/10 bg-content1 p-3 min-w-0'

export default function TrafficPage(): React.JSX.Element {
  const { t } = useTranslation()
  const { appConfig, mutateAppConfig } = useAppConfig()
  const [preset, setPreset] = useState<HistoryPreset>('24h')
  const [resolution, setResolution] = useState<'raw' | 'day'>('raw')
  const [customFrom, setCustomFrom] = useState(() => localDateTime(Date.now() - 86400000))
  const [customTo, setCustomTo] = useState(() => localDateTime(Date.now()))
  const [dimension, setDimension] = useState<HistoryDimension>('domain')
  const [filters, setFilters] = useState<HistoryQuery['filters']>({})
  const [includeInternal, setIncludeInternal] = useState(false)
  const [search, setSearch] = useState('')
  const [exactValue, setExactValue] = useState('')
  const [flowSearch, setFlowSearch] = useState('')
  const [sort, setSort] = useState<HistorySort>('total')
  const [ascending, setAscending] = useState(false)
  const [view, setView] = useState<View>('rankings')
  const [cursor, setCursor] = useState<number>()
  const [previousCursors, setPreviousCursors] = useState<(number | undefined)[]>([])
  const [snapshot, setSnapshot] = useState<Snapshot>()
  const [status, setStatus] = useState<HistoryStatus>()
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [saving, setSaving] = useState(false)
  const [settingError, setSettingError] = useState('')
  const [refresh, setRefresh] = useState(0)
  const [selectedFlow, setSelectedFlow] = useState<HistoryFlow>()
  const generation = useRef(0)
  const work = useRef<Promise<void>>(Promise.resolve())
  const flowRange = useRef<
    | {
        key: string
        range: Pick<HistoryQuery, 'from' | 'to' | 'resolution' | 'interval'>
      }
    | undefined
  >(undefined)
  const alive = useRef(true)
  useEffect(() => {
    alive.current = true
    return () => {
      alive.current = false
    }
  }, [])

  useEffect(() => {
    const current = ++generation.current
    let cancelled = false
    let timer: ReturnType<typeof setTimeout> | undefined
    const valid = (): boolean => !cancelled && current === generation.current
    setSnapshot(undefined)
    setSelectedFlow(undefined)
    setError('')
    const load = async (): Promise<void> => {
      if (!valid()) return
      setLoading(true)
      try {
        const nextStatus = await trafficHistoryStatus()
        if (!valid()) return
        setStatus(nextStatus)
        if (!nextStatus.enabled || !nextStatus.ready) {
          setSnapshot(undefined)
          return
        }
        // ID cursors need the same membership bounds on every page and refresh.
        const rangeKey = JSON.stringify([
          preset,
          resolution,
          customFrom,
          customTo,
          filters,
          includeInternal,
          refresh,
          nextStatus.aggregationTimezone
        ])
        if ((preset === 'year' || resolution === 'day') && !nextStatus.aggregationTimezone)
          throw new Error('timezoneUnavailable')
        const range =
          view === 'flows' && flowRange.current?.key === rangeKey
            ? flowRange.current.range
            : historyRange(
                preset,
                resolution,
                customFrom,
                customTo,
                Date.now(),
                nextStatus.aggregationTimezone || 'UTC'
              )
        flowRange.current = view === 'flows' ? { key: rangeKey, range } : undefined
        const query: HistoryQuery = {
          ...range,
          filters,
          include_internal: includeInternal
        }
        // A single reader sequence also prevents overlapping refreshes across filter changes.
        const read = async <T,>(
          endpoint: Parameters<typeof queryTrafficHistory>[0],
          extra: Partial<HistoryQuery> = {}
        ): Promise<HistoryResult<T>> => {
          if (!valid()) throw new Error('cancelled')
          return (await queryTrafficHistory(endpoint, { ...query, ...extra })) as HistoryResult<T>
        }
        const summary = await read<HistoryTotals>('summary')
        const series = await read<HistoryPoint[]>('series', { limit: 1000 })
        const groups = await read<HistoryGroup[]>('groups', { group_by: dimension, limit: 1000 })
        const routes = await read<HistoryGroup[]>('groups', {
          group_by: 'rule,policy,chain',
          limit: 100
        })
        const flows =
          query.resolution === 'raw'
            ? await read<HistoryFlow[]>('flows', { limit: 50, cursor })
            : undefined
        if (!valid()) return
        setSnapshot({ query, summary, series, groups, routes, flows })
        setError('')
      } catch (reason) {
        if (valid()) {
          const message = reason instanceof Error ? reason.message : String(reason)
          setError(
            message === 'invalidRange' ||
              message === 'rangeTooLong' ||
              message === 'timezoneUnavailable'
              ? t(`traffic.history.${message}`)
              : message
          )
        }
      } finally {
        if (valid()) {
          setLoading(false)
          timer = setTimeout(enqueue, 10000)
        }
      }
    }
    const enqueue = (): void => {
      if (!valid()) return
      if (document.hidden) {
        timer = setTimeout(enqueue, 10000)
        return
      }
      work.current = work.current.catch(() => {}).then(load)
    }
    enqueue()
    return () => {
      cancelled = true
      clearTimeout(timer)
    }
  }, [
    preset,
    resolution,
    customFrom,
    customTo,
    dimension,
    filters,
    includeInternal,
    cursor,
    view,
    refresh,
    t
  ])

  const resetPage = (): void => {
    flowRange.current = undefined
    setCursor(undefined)
    setPreviousCursors([])
  }
  const filter = (key: HistoryDimension, value: string): void => {
    try {
      const exact = exactHistoryValue(key, value)
      resetPage()
      setFilters((previous) => ({ ...previous, [key]: exact }))
    } catch {
      setError(t('traffic.history.invalidChain'))
    }
  }
  const updateSetting = async (value: Partial<IAppConfig>): Promise<void> => {
    setSaving(true)
    setSettingError('')
    try {
      await patchAppConfig(value)
      if (!alive.current) return
      mutateAppConfig()
      resetPage()
      setRefresh((previous) => previous + 1)
    } catch (reason) {
      if (alive.current) setSettingError(String(reason))
    } finally {
      if (alive.current) setSaving(false)
    }
  }
  const rankings = useMemo(
    () => rankGroups(snapshot?.groups.data || [], dimension, search, sort, ascending),
    [snapshot, dimension, search, sort, ascending]
  )
  const flows = useMemo(
    () =>
      (snapshot?.flows?.data || []).filter((flow) =>
        JSON.stringify(flow).toLocaleLowerCase().includes(flowSearch.toLocaleLowerCase())
      ),
    [snapshot, flowSearch]
  )
  const totals = snapshot?.summary.data
  const daily = preset === 'year' || resolution === 'day'
  const exportRows = (format: 'csv' | 'json'): void => {
    if (!snapshot) return
    const rows = view === 'flows' ? flows : view === 'routes' ? snapshot.routes.data : rankings
    const result =
      view === 'flows' ? snapshot.flows : view === 'routes' ? snapshot.routes : snapshot.groups
    saveHistoryExport(
      `traffic-${view}-${view === 'flows' ? 'current-page' : 'top-results'}`,
      format,
      rows.map((row) => ({ ...row })),
      {
        query: snapshot.query,
        groupBy:
          view === 'routes'
            ? ['rule', 'policy', 'chain']
            : view === 'rankings'
              ? [dimension]
              : undefined,
        sort: view === 'rankings' ? { field: sort, ascending } : undefined,
        search: view === 'flows' ? flowSearch : view === 'rankings' ? search : '',
        scope:
          view === 'flows'
            ? 'Current page only; flow counters are lifetime, not selected-range traffic'
            : 'Loaded top results only',
        truncated: result?.truncated,
        cursor,
        lastCommitAt: result?.lastCommitAt,
        aggregationTimezone: status?.aggregationTimezone
      }
    )
  }

  return (
    <BasePage
      title={t('sider.cards.traffic')}
      header={
        <Button
          size="sm"
          variant="light"
          className="app-nodrag"
          isDisabled={loading}
          onPress={() => {
            resetPage()
            setRefresh((value) => value + 1)
          }}
        >
          {t('traffic.history.refresh')}
        </Button>
      }
    >
      <div className="flex flex-col gap-3 p-3 max-w-7xl mx-auto">
        <div className="flex flex-wrap items-center gap-3 text-sm">
          <Switch
            size="sm"
            isSelected={appConfig?.enableTrafficLogger ?? true}
            isDisabled={saving || !appConfig}
            onValueChange={(enabled) => void updateSetting({ enableTrafficLogger: enabled })}
          >
            {t('traffic.history.recordLocally')}
          </Switch>
          <label className="flex items-center gap-2 text-xs text-foreground/70">
            {t('traffic.history.retention')}
            <select
              className={selectClass}
              disabled={saving || !appConfig}
              value={appConfig?.trafficHistoryRetentionDays ?? status?.retentionDays ?? 30}
              onChange={(event) =>
                void updateSetting({ trafficHistoryRetentionDays: Number(event.target.value) })
              }
            >
              {[...new Set([7, 14, 30, 90, 180, 365, appConfig?.trafficHistoryRetentionDays ?? 30])]
                .sort((a, b) => a - b)
                .map((days) => (
                  <option key={days} value={days}>
                    {t('traffic.history.days', { count: days })}
                  </option>
                ))}
            </select>
          </label>
          <span className="text-xs text-foreground/50">{t('traffic.history.dailyForever')}</span>
        </div>
        {settingError && (
          <p className="text-sm text-danger break-all" role="alert">
            {settingError}
          </p>
        )}
        <div className="flex flex-wrap gap-2 items-end">
          <label className="flex flex-col gap-1 text-xs text-foreground/60">
            {t('traffic.history.range')}
            <select
              className={selectClass}
              value={preset}
              onChange={(event) => {
                setPreset(event.target.value as HistoryPreset)
                resetPage()
              }}
            >
              {(['1h', '24h', '7d', '30d', 'year', 'custom'] as const).map((range) => (
                <option key={range} value={range}>
                  {t(
                    range === 'year' || range === 'custom'
                      ? `traffic.history.${range}`
                      : `traffic.timeRange.${range}`
                  )}
                </option>
              ))}
            </select>
          </label>
          <label className="flex flex-col gap-1 text-xs text-foreground/60">
            {t('traffic.history.resolution')}
            <select
              className={selectClass}
              value={daily ? 'day' : 'raw'}
              disabled={preset === 'year'}
              onChange={(event) => {
                setResolution(event.target.value as 'raw' | 'day')
                resetPage()
              }}
            >
              <option value="raw">{t('traffic.history.raw')}</option>
              <option value="day">{t('traffic.history.day')}</option>
            </select>
          </label>
          {preset === 'custom' && (
            <>
              <label className="flex flex-col gap-1 text-xs text-foreground/60">
                {t('traffic.history.fromLocal')}
                <input
                  className={selectClass}
                  type="datetime-local"
                  value={customFrom}
                  onChange={(event) => {
                    setCustomFrom(event.target.value)
                    resetPage()
                  }}
                />
              </label>
              <label className="flex flex-col gap-1 text-xs text-foreground/60">
                {t('traffic.history.toLocal')}
                <input
                  className={selectClass}
                  type="datetime-local"
                  value={customTo}
                  onChange={(event) => {
                    setCustomTo(event.target.value)
                    resetPage()
                  }}
                />
              </label>
            </>
          )}
          <Switch
            size="sm"
            isSelected={includeInternal}
            onValueChange={(value) => {
              setIncludeInternal(value)
              resetPage()
            }}
          >
            {t('traffic.history.internal')}
          </Switch>
        </div>
        <div className="flex flex-wrap gap-2" aria-label={t('traffic.history.exactFilters')}>
          {Object.entries(filters || {}).map(([key, value]) => (
            <Chip
              size="sm"
              key={key}
              onClose={() => {
                resetPage()
                setFilters((previous) => {
                  const next = { ...previous }
                  delete next[key as HistoryDimension]
                  return next
                })
              }}
              className="h-auto min-h-7 max-w-full py-1"
              classNames={{ content: 'whitespace-normal break-all' }}
            >
              {t(`traffic.history.dimension.${key}`)} ={' '}
              {dimensionLabel(value, key as HistoryDimension) || t('traffic.history.unknown')}
            </Chip>
          ))}
          {Object.keys(filters || {}).length > 0 && (
            <Button
              size="sm"
              variant="light"
              onPress={() => {
                setFilters({})
                resetPage()
              }}
            >
              {t('traffic.history.clearFilters')}
            </Button>
          )}
        </div>
        <div className="space-y-1 text-xs text-foreground/60" aria-live="polite">
          {status && !status.enabled && <p>{t('traffic.history.disabled')}</p>}
          {status?.enabled && !status.ready && <p>{t('traffic.history.notReady')}</p>}
          {status &&
            (status.droppedRecords > 0 || status.skippedSamples > 0 || status.writeErrors > 0) && (
              <p className="text-warning">
                {t('traffic.history.loss', {
                  dropped: status.droppedRecords,
                  skipped: status.skippedSamples,
                  errors: status.writeErrors
                })}
              </p>
            )}
          {status?.lastError && (
            <p role="alert" className="text-danger break-all">
              {status.lastError}
            </p>
          )}
          {status?.geoWarnings?.map((warning) => (
            <p key={warning}>{warning}</p>
          ))}
          {status?.detailAvailableFrom &&
          !daily &&
          snapshot &&
          snapshot.query.from < status.detailAvailableFrom ? (
            <p>
              {t('traffic.history.expired', {
                date: new Date(status.detailAvailableFrom).toLocaleString()
              })}
            </p>
          ) : null}
          {status?.aggregateAvailableFrom &&
          daily &&
          snapshot &&
          snapshot.query.from < status.aggregateAvailableFrom ? (
            <p>
              {t('traffic.history.aggregateFrom', {
                date: new Date(status.aggregateAvailableFrom).toLocaleDateString()
              })}
            </p>
          ) : null}
          {daily && (
            <p>
              {t('traffic.history.dailyHelp', { timezone: status?.aggregationTimezone || '…' })}
            </p>
          )}
          {snapshot && (
            <p>
              {new Date(snapshot.query.from).toLocaleString()} –{' '}
              {new Date(snapshot.query.to).toLocaleString()} ·{' '}
              {t('traffic.history.committed', {
                date: snapshot.summary.lastCommitAt
                  ? new Date(snapshot.summary.lastCommitAt).toLocaleString()
                  : '—'
              })}
            </p>
          )}
        </div>
        {error && (
          <p role="alert" className="text-sm text-danger break-all">
            {error}
          </p>
        )}
        {loading && (
          <Spinner size="sm" className="self-start" label={t('traffic.history.loading')} />
        )}
        {snapshot && (
          <>
            <section
              className={`${sectionClass} grid grid-cols-2 lg:grid-cols-5 gap-4`}
              aria-label={t('traffic.history.overview')}
            >
              {[
                [t('traffic.total'), calcTraffic((totals?.upload || 0) + (totals?.download || 0))],
                [t('traffic.upload'), calcTraffic(totals?.upload || 0)],
                [t('traffic.download'), calcTraffic(totals?.download || 0)],
                [t('traffic.history.newConnections'), totals?.connections.toLocaleString() || '0'],
                [
                  t('traffic.history.participating'),
                  totals?.participatingConnections == null
                    ? '—'
                    : totals.participatingConnections.toLocaleString()
                ]
              ].map(([label, value], index) => (
                <div key={label} className={index === 0 ? 'col-span-2 lg:col-span-1' : ''}>
                  <div className="text-xs text-foreground/60">{label}</div>
                  <div
                    className={`mt-1 font-semibold tabular-nums ${index === 0 ? 'text-2xl' : 'text-lg'}`}
                  >
                    {value}
                  </div>
                </div>
              ))}
              <p className="text-xs text-foreground/50 col-span-2 lg:col-span-5">
                {t('traffic.history.countHelp')} {daily && t('traffic.history.noDailyParticipants')}
              </p>
            </section>
            <section className={sectionClass} aria-label={t('traffic.history.trend')}>
              <h2 className="text-sm font-medium mb-2">{t('traffic.history.trend')}</h2>
              <div className="h-56">
                <TrafficTrendChart
                  data={snapshot.series.data.map((point) => ({
                    timestamp: point.time,
                    upload: point.upload,
                    download: point.download
                  }))}
                  bucketSizeMs={
                    snapshot.query.interval === '1d'
                      ? 86400000
                      : snapshot.query.interval === '1h'
                        ? 3600000
                        : 60000
                  }
                  timezone={daily ? status?.aggregationTimezone : undefined}
                />
              </div>
              <details className="mt-2 text-xs">
                <summary className="cursor-pointer text-foreground/60">
                  {t('traffic.history.trendTable')}
                </summary>
                <div className="max-h-52 overflow-auto">
                  <table className="w-full">
                    <thead>
                      <tr>
                        <th className="p-2 text-left">{t('traffic.history.started')}</th>
                        <th className="p-2 text-right">{t('traffic.upload')}</th>
                        <th className="p-2 text-right">{t('traffic.download')}</th>
                      </tr>
                    </thead>
                    <tbody>
                      {snapshot.series.data.map((point) => (
                        <tr key={point.time}>
                          <td className="p-2">
                            {new Date(point.time).toLocaleString(
                              undefined,
                              daily ? { timeZone: status?.aggregationTimezone } : undefined
                            )}
                          </td>
                          <td className="p-2 text-right">{calcTraffic(point.upload)}</td>
                          <td className="p-2 text-right">{calcTraffic(point.download)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </details>
              {snapshot.series.truncated && (
                <p className="text-xs text-warning">{t('traffic.history.trendTruncated')}</p>
              )}
            </section>
            <section className={sectionClass}>
              <div className="flex flex-wrap items-center gap-2 justify-between mb-3">
                <Tabs
                  size="sm"
                  selectedKey={view}
                  onSelectionChange={(key) => {
                    resetPage()
                    setView(key as View)
                  }}
                >
                  <Tab key="rankings" title={t('traffic.history.rankings')} />
                  <Tab key="routes" title={t('traffic.history.routes')} />
                  <Tab key="flows" title={t('traffic.history.flows')} />
                </Tabs>
                <div className="flex gap-1">
                  <Button
                    size="sm"
                    variant="flat"
                    isDisabled={daily && view === 'flows'}
                    onPress={() => exportRows('csv')}
                  >
                    {t('traffic.history.exportCsv')}
                  </Button>
                  <Button
                    size="sm"
                    variant="flat"
                    isDisabled={daily && view === 'flows'}
                    onPress={() => exportRows('json')}
                  >
                    {t('traffic.history.exportJson')}
                  </Button>
                </div>
              </div>
              {view === 'rankings' && (
                <>
                  <div className="flex flex-wrap items-end gap-2 mb-3">
                    <label className="flex flex-col gap-1 text-xs text-foreground/60">
                      {t('traffic.history.groupBy')}
                      <select
                        value={dimension}
                        className={selectClass}
                        onChange={(event) => {
                          setDimension(event.target.value as HistoryDimension)
                          setSearch('')
                        }}
                      >
                        {historyDimensions.map((key) => (
                          <option value={key} key={key}>
                            {t(`traffic.history.dimension.${key}`)}
                          </option>
                        ))}
                      </select>
                    </label>
                    <Input
                      size="sm"
                      className="w-52"
                      aria-label={t('traffic.history.searchRankings')}
                      placeholder={t('traffic.history.searchRankings')}
                      value={search}
                      onValueChange={setSearch}
                      isClearable
                    />
                    <Input
                      size="sm"
                      className="w-52"
                      aria-label={t('traffic.history.exactValue')}
                      placeholder={t('traffic.history.exactValue')}
                      value={exactValue}
                      onValueChange={setExactValue}
                      onKeyDown={(event) => {
                        if (event.key === 'Enter') filter(dimension, exactValue)
                      }}
                    />
                    <Button size="sm" variant="flat" onPress={() => filter(dimension, exactValue)}>
                      {t('traffic.history.applyExact')}
                    </Button>
                    <label className="flex flex-col gap-1 text-xs text-foreground/60">
                      {t('traffic.history.sort')}
                      <select
                        className={selectClass}
                        value={sort}
                        onChange={(event) => setSort(event.target.value as HistorySort)}
                      >
                        {(['total', 'upload', 'download', 'connections', 'label'] as const).map(
                          (key) => (
                            <option key={key} value={key}>
                              {t(
                                key === 'total' || key === 'upload' || key === 'download'
                                  ? `traffic.${key}`
                                  : `traffic.history.${key}`
                              )}
                            </option>
                          )
                        )}
                      </select>
                    </label>
                    <Button
                      size="sm"
                      variant="light"
                      onPress={() => setAscending((value) => !value)}
                    >
                      {t(ascending ? 'traffic.history.ascending' : 'traffic.history.descending')}
                    </Button>
                  </div>
                  <TrafficRankings data={rankings} dimension={dimension} onSelect={filter} />
                  <p className="text-xs text-foreground/50 mt-2">
                    {t('traffic.history.topScope', { count: snapshot.groups.data.length })}{' '}
                    {snapshot.groups.truncated && t('traffic.history.topTruncated')}
                  </p>
                </>
              )}
              {view === 'routes' && (
                <>
                  <TrafficRouteMap data={snapshot.routes.data} onFilter={filter} />
                  <p className="text-xs text-foreground/50 mt-2">
                    {t('traffic.history.topScope', { count: snapshot.routes.data.length })}{' '}
                    {snapshot.routes.truncated && t('traffic.history.topTruncated')}
                  </p>
                </>
              )}
              {view === 'flows' &&
                (daily ? (
                  <p className="text-sm text-foreground/60 py-8">
                    {t('traffic.history.dailyNoFlows')}
                  </p>
                ) : (
                  <>
                    <Input
                      size="sm"
                      className="max-w-sm mb-3"
                      aria-label={t('traffic.history.searchPage')}
                      placeholder={t('traffic.history.searchPage')}
                      value={flowSearch}
                      onValueChange={setFlowSearch}
                      isClearable
                    />
                    <p className="text-xs text-foreground/50 mb-2">
                      {t('traffic.history.flowScope')} {t('traffic.history.frozenFlowRange')}
                    </p>
                    <TrafficDetailsTable flows={flows} onSelect={setSelectedFlow} />
                    <div className="flex items-center justify-between mt-3 gap-2">
                      <p className="text-xs text-foreground/50">
                        {t('traffic.history.pageScope', {
                          page: previousCursors.length + 1,
                          count: snapshot.flows?.data.length || 0
                        })}
                      </p>
                      <div className="flex gap-2">
                        <Button
                          size="sm"
                          variant="flat"
                          isDisabled={!previousCursors.length || loading}
                          onPress={() => {
                            setCursor(previousCursors.at(-1))
                            setPreviousCursors((previous) => previous.slice(0, -1))
                          }}
                        >
                          {t('traffic.history.previous')}
                        </Button>
                        <Button
                          size="sm"
                          variant="flat"
                          isDisabled={snapshot.flows?.nextCursor === undefined || loading}
                          onPress={() => {
                            setPreviousCursors((previous) => [...previous, cursor])
                            setCursor(snapshot.flows?.nextCursor)
                          }}
                        >
                          {t('traffic.history.next')}
                        </Button>
                      </div>
                    </div>
                  </>
                ))}
              <p className="text-xs text-foreground/50 mt-3">
                {t(view === 'flows' ? 'traffic.history.exportPage' : 'traffic.history.exportTop')}
              </p>
            </section>
          </>
        )}
      </div>
      {selectedFlow && snapshot && (
        <TrafficFlowDetail
          flow={selectedFlow}
          query={snapshot.query}
          onClose={() => setSelectedFlow(undefined)}
          onFilter={filter}
        />
      )}
    </BasePage>
  )
}
