import { useRef, useState, useEffect } from 'react'
import { useTranslation } from 'react-i18next'
import { Spinner, Switch } from '@heroui/react'
import {
  LuActivity,
  LuArrowDownToLine,
  LuArrowUpFromLine,
  LuChartNoAxesColumn,
  LuClock,
  LuGlobe,
  LuLayoutDashboard,
  LuMapPin,
  LuRefreshCw,
  LuRoute,
  LuServer,
  LuSettings2
} from 'react-icons/lu'
import { useAppConfig } from '@renderer/hooks/use-app-config'
import { patchAppConfig } from '@renderer/utils/ipc'
import { calcTraffic } from '@renderer/utils/calc'
import { localDateTime, type HistoryPreset } from '@renderer/utils/traffic-history'
import TrafficTrendChart from '../traffic-trend-chart'
import { Distribution, EmptyState, GroupTable, RankList, TopBars } from './panels'
import WorldMap from './world-map'
import SelectionDetails from './selection-details'
import {
  intervalMs,
  moduleDimensions,
  modules,
  total,
  trendPoints,
  selectionQuery,
  type DashboardSnapshot,
  type Selection,
  type TrafficModule
} from './model'
import { useTrafficDashboard } from './use-traffic-dashboard'
import './traffic.css'

const icons = {
  overview: LuLayoutDashboard,
  rules: LuRoute,
  domains: LuGlobe,
  countries: LuMapPin,
  proxies: LuServer
}

export default function EmbeddedTrafficDashboard() {
  const { t } = useTranslation()
  const { appConfig, mutateAppConfig } = useAppConfig()
  const [module, setModule] = useState<TrafficModule>('overview')
  const [preset, setPreset] = useState<HistoryPreset>('24h')
  const [resolution, setResolution] = useState<'raw' | 'day'>('raw')
  const [from, setFrom] = useState(() => localDateTime(Date.now() - 86400000))
  const [to, setTo] = useState(() => localDateTime(Date.now()))
  const [includeInternal, setIncludeInternal] = useState(false)
  const [autoRefresh, setAutoRefresh] = useState(true)
  const [refresh, setRefresh] = useState(0)
  const [settings, setSettings] = useState(false)
  const [selection, setSelection] = useState<Selection>()
  const [ipTab, setIpTab] = useState(false)
  const [saving, setSaving] = useState(false)
  const [settingError, setSettingError] = useState('')
  const alive = useRef(true)
  useEffect(() => {
    alive.current = true
    return () => {
      alive.current = false
    }
  }, [])
  const { snapshot, status, loading, error } = useTrafficDashboard({
    preset,
    resolution,
    from,
    to,
    includeInternal,
    autoRefresh,
    refresh
  })
  const daily = preset === 'year' || resolution === 'day'
  const updateSetting = async (patch: Partial<IAppConfig>): Promise<void> => {
    setSaving(true)
    setSettingError('')
    try {
      await patchAppConfig(patch)
      if (alive.current) {
        mutateAppConfig()
        setRefresh((value) => value + 1)
      }
    } catch (reason) {
      if (alive.current) setSettingError(String(reason))
    } finally {
      if (alive.current) setSaving(false)
    }
  }
  const navigate = (value: TrafficModule): void => {
    setModule(value)
    setSelection(undefined)
  }
  const select = (value: Selection): void => setSelection(value)
  const errorMessage = ['invalidRange', 'rangeTooLong', 'timezoneUnavailable'].includes(error)
    ? t(`traffic.history.${error}`)
    : error
  return (
    <div className="embedded-traffic min-h-full p-4 lg:p-6">
      <div className="traffic-toolbar">
        <nav className="traffic-navigation" aria-label={t('traffic.embedded.navigation')}>
          {modules.map((value) => {
            const Icon = icons[value]
            return (
              <button
                type="button"
                key={value}
                aria-current={module === value ? 'page' : undefined}
                onClick={() => navigate(value)}
              >
                <Icon size={17} />
                <span>{t(`traffic.embedded.${value}`)}</span>
              </button>
            )
          })}
        </nav>
        <div className="flex items-center gap-2 flex-wrap">
          {loading && snapshot && <Spinner size="sm" aria-label={t('traffic.history.loading')} />}
          <button
            type="button"
            className="traffic-icon-button text-emerald-500"
            disabled={loading}
            aria-label={t('traffic.history.refresh')}
            title={t('traffic.history.refresh')}
            onClick={() => {
              setSelection(undefined)
              setRefresh((value) => value + 1)
            }}
          >
            <LuRefreshCw size={18} className={loading ? 'animate-spin' : ''} />
          </button>
          <label className="traffic-range">
            <LuClock size={16} />
            <span className="sr-only">{t('traffic.history.range')}</span>
            <select
              value={preset}
              onChange={(event) => {
                setSelection(undefined)
                setPreset(event.target.value as HistoryPreset)
              }}
            >
              {(['1h', '24h', '7d', '30d', 'year', 'custom'] as const).map((value) => (
                <option key={value} value={value}>
                  {t(
                    value === 'year' || value === 'custom'
                      ? `traffic.history.${value}`
                      : `traffic.timeRange.${value}`
                  )}
                </option>
              ))}
            </select>
          </label>
          <button
            type="button"
            className="traffic-icon-button"
            aria-label={t('traffic.embedded.settings')}
            title={t('traffic.embedded.settings')}
            aria-expanded={settings}
            onClick={() => setSettings(!settings)}
          >
            <LuSettings2 size={18} />
          </button>
        </div>
      </div>
      {(settings || preset === 'custom') && (
        <section className="traffic-panel flex flex-wrap items-end gap-4 mb-5">
          {preset === 'custom' && (
            <>
              <label className="traffic-field">
                {t('traffic.history.fromLocal')}
                <input
                  type="datetime-local"
                  value={from}
                  onChange={(event) => {
                    setFrom(event.target.value)
                    setSelection(undefined)
                  }}
                />
              </label>
              <label className="traffic-field">
                {t('traffic.history.toLocal')}
                <input
                  type="datetime-local"
                  value={to}
                  onChange={(event) => {
                    setTo(event.target.value)
                    setSelection(undefined)
                  }}
                />
              </label>
            </>
          )}
          <label className="traffic-field">
            {t('traffic.history.resolution')}
            <select
              value={daily ? 'day' : 'raw'}
              disabled={preset === 'year'}
              onChange={(event) => {
                setResolution(event.target.value as 'raw' | 'day')
                setSelection(undefined)
              }}
            >
              <option value="raw">{t('traffic.history.raw')}</option>
              <option value="day">{t('traffic.history.day')}</option>
            </select>
          </label>
          <Switch size="sm" isSelected={autoRefresh} onValueChange={setAutoRefresh}>
            {t('traffic.embedded.autoRefresh')}
          </Switch>
          <Switch
            size="sm"
            isSelected={includeInternal}
            onValueChange={(value) => {
              setIncludeInternal(value)
              setSelection(undefined)
            }}
          >
            {t('traffic.history.internal')}
          </Switch>
          {settings && (
            <>
              <Switch
                size="sm"
                isDisabled={saving || !appConfig}
                isSelected={appConfig?.enableTrafficLogger ?? true}
                onValueChange={(value) => void updateSetting({ enableTrafficLogger: value })}
              >
                {t('traffic.history.recordLocally')}
              </Switch>
              <label className="traffic-field">
                {t('traffic.history.retention')}
                <select
                  disabled={saving || !appConfig}
                  value={appConfig?.trafficHistoryRetentionDays ?? 30}
                  onChange={(event) =>
                    void updateSetting({ trafficHistoryRetentionDays: Number(event.target.value) })
                  }
                >
                  {[
                    ...new Set([
                      7,
                      14,
                      30,
                      90,
                      180,
                      365,
                      appConfig?.trafficHistoryRetentionDays ?? 30
                    ])
                  ]
                    .sort((a, b) => a - b)
                    .map((days) => (
                      <option key={days} value={days}>
                        {t('traffic.history.days', { count: days })}
                      </option>
                    ))}
                </select>
              </label>
              <span className="text-xs text-foreground/50">
                {t('traffic.history.dailyForever')}
              </span>
            </>
          )}
        </section>
      )}
      {(errorMessage || settingError) && (
        <div
          role="alert"
          className="traffic-panel border-danger/30 text-danger text-sm mb-5 break-all"
        >
          {errorMessage || settingError}
        </div>
      )}
      {status && (!status.enabled || !status.ready) && (
        <div className="traffic-panel text-sm text-foreground/60 mb-5">
          {t(status.enabled ? 'traffic.history.notReady' : 'traffic.history.disabled')}
          {!status.enabled && (
            <button
              type="button"
              className="traffic-button ml-3"
              disabled={saving}
              onClick={() => void updateSetting({ enableTrafficLogger: true })}
            >
              {t('traffic.history.recordLocally')}
            </button>
          )}
        </div>
      )}
      {loading && !snapshot && (
        <div className="traffic-panel py-20 flex justify-center">
          <Spinner label={t('traffic.history.loading')} />
        </div>
      )}
      {snapshot && (
        <div className="space-y-5">
          {module === 'overview' ? (
            <>
              <Stats snapshot={snapshot} />
              <Trend snapshot={snapshot} />
              <div className="grid grid-cols-1 xl:grid-cols-3 gap-5">
                {(['domain', 'proxy', 'country'] as const).map((dimension) => (
                  <RankList
                    key={dimension}
                    title={t(
                      `traffic.embedded.top${dimension === 'domain' ? 'Domains' : dimension === 'proxy' ? 'Proxies' : 'Countries'}`
                    )}
                    dimension={dimension}
                    data={snapshot.groups[dimension].data}
                    onSelect={select}
                    onViewAll={() =>
                      navigate(
                        dimension === 'domain'
                          ? 'domains'
                          : dimension === 'proxy'
                            ? 'proxies'
                            : 'countries'
                      )
                    }
                  />
                ))}
              </div>
            </>
          ) : module === 'countries' ? (
            <>
              <WorldMap data={snapshot.groups.country.data} onSelect={select} />
              <GroupTable
                result={snapshot.groups.country}
                dimension="country"
                query={snapshot.query}
                onSelect={select}
              />
            </>
          ) : module === 'domains' ? (
            <>
              <TopBars
                data={snapshot.groups[ipTab ? 'destinationIP' : 'domain'].data}
                dimension={ipTab ? 'destinationIP' : 'domain'}
                title={t(ipTab ? 'traffic.embedded.topIPs' : 'traffic.embedded.topDomains')}
                onSelect={select}
              />
              <div className="traffic-segments w-fit">
                {[false, true].map((value) => (
                  <button
                    type="button"
                    key={String(value)}
                    aria-pressed={ipTab === value}
                    onClick={() => {
                      setIpTab(value)
                      setSelection(undefined)
                    }}
                  >
                    {t(value ? 'traffic.embedded.ipList' : 'traffic.embedded.domainList')}
                  </button>
                ))}
              </div>
              <GroupTable
                key={String(ipTab)}
                result={snapshot.groups[ipTab ? 'destinationIP' : 'domain']}
                dimension={ipTab ? 'destinationIP' : 'domain'}
                query={snapshot.query}
                onSelect={select}
              />
            </>
          ) : (
            <>
              {module === 'rules' && (
                <p className="text-xs text-foreground/50">{t('traffic.embedded.ruleHelp')}</p>
              )}
              <div className="traffic-insights">
                <Distribution
                  data={snapshot.groups[moduleDimensions[module]].data}
                  dimension={moduleDimensions[module]}
                  onSelect={select}
                />
                <div className="traffic-panel">
                  <RankList
                    data={snapshot.groups[moduleDimensions[module]].data}
                    dimension={moduleDimensions[module]}
                    title={t(`traffic.embedded.${module}`)}
                    selected={
                      selection?.dimension === moduleDimensions[module]
                        ? selection.value
                        : undefined
                    }
                    limit={1000}
                    onSelect={select}
                  />
                </div>
                <TopBars
                  data={snapshot.groups.domain.data}
                  dimension="domain"
                  title={t('traffic.embedded.topDomains')}
                  onSelect={select}
                />
              </div>
              <GroupTable
                key={module}
                result={snapshot.groups[moduleDimensions[module]]}
                dimension={moduleDimensions[module]}
                query={snapshot.query}
                onSelect={select}
              />
            </>
          )}
          {selection && (
            <SelectionDetails
              key={JSON.stringify(selection)}
              selection={selection}
              query={snapshot.query}
              onSelect={(value) =>
                setSelection({
                  ...value,
                  filters: {
                    ...selectionQuery(snapshot.query, selection).filters,
                    ...value.filters
                  }
                })
              }
              onClose={() => setSelection(undefined)}
            />
          )}
          <footer
            className="text-[11px] text-foreground/45 space-y-1 leading-relaxed"
            aria-live="polite"
          >
            <p>
              {new Date(snapshot.query.from).toLocaleString()} –{' '}
              {new Date(snapshot.query.to).toLocaleString()} ·{' '}
              {t('traffic.history.committed', {
                date: snapshot.summary.lastCommitAt
                  ? new Date(snapshot.summary.lastCommitAt).toLocaleString()
                  : '—'
              })}
            </p>
            {daily && (
              <p>
                {t('traffic.history.dailyHelp', { timezone: status?.aggregationTimezone || '…' })}
              </p>
            )}
            {snapshot.series.truncated && (
              <p className="text-warning">{t('traffic.history.trendTruncated')}</p>
            )}
            {Object.values(snapshot.groups).some((result) => result.truncated) && (
              <p className="text-warning">{t('traffic.history.topTruncated')}</p>
            )}
            <p>{t('traffic.embedded.shareHelp')}</p>
            {!!status?.detailAvailableFrom &&
              !daily &&
              snapshot.query.from < status.detailAvailableFrom && (
                <p>
                  {t('traffic.history.expired', {
                    date: new Date(status.detailAvailableFrom).toLocaleString()
                  })}
                </p>
              )}
            {!!status?.aggregateAvailableFrom &&
              daily &&
              snapshot.query.from < status.aggregateAvailableFrom && (
                <p>
                  {t('traffic.history.aggregateFrom', {
                    date: new Date(status.aggregateAvailableFrom).toLocaleDateString()
                  })}
                </p>
              )}
          </footer>
        </div>
      )}
      {status && (
        <div className="mt-3 text-xs text-warning space-y-1" aria-live="polite">
          {!status.healthy && status.enabled && status.ready && (
            <p>{t('traffic.embedded.unhealthy')}</p>
          )}
          {(status.droppedRecords > 0 || status.skippedSamples > 0 || status.writeErrors > 0) && (
            <p>
              {t('traffic.history.loss', {
                dropped: status.droppedRecords,
                skipped: status.skippedSamples,
                errors: status.writeErrors
              })}
            </p>
          )}
          {status.lastError && (
            <p role="alert" className="break-all">
              {status.lastError}
            </p>
          )}
          {status.geoWarnings?.map((warning) => (
            <p key={warning}>{warning}</p>
          ))}
        </div>
      )}
    </div>
  )
}

function Stats({ snapshot }: { snapshot: DashboardSnapshot }) {
  const { t } = useTranslation()
  const count = (dimension: 'domain' | 'policy'): string => {
    const result = snapshot.groups[dimension]
    return `${result.data.filter((row) => row[dimension]).length.toLocaleString()}${result.truncated ? '+' : ''}`
  }
  const stats = [
    {
      icon: LuArrowDownToLine,
      label: t('traffic.embedded.totalDownload'),
      value: calcTraffic(snapshot.summary.data.download),
      color: '#3b82f6'
    },
    {
      icon: LuArrowUpFromLine,
      label: t('traffic.embedded.totalUpload'),
      value: calcTraffic(snapshot.summary.data.upload),
      color: '#a855f7'
    },
    {
      icon: LuServer,
      label: t('traffic.embedded.totalTraffic'),
      value: calcTraffic(total(snapshot.summary.data)),
      color: '#ec4899'
    },
    {
      icon: LuActivity,
      label: t('traffic.history.newConnections'),
      value: snapshot.summary.data.connections.toLocaleString(),
      color: '#10b981'
    },
    {
      icon: LuGlobe,
      label: t('traffic.embedded.domainCount'),
      value: count('domain'),
      color: '#06b6d4'
    },
    {
      icon: LuRoute,
      label: t('traffic.embedded.ruleCount'),
      value: count('policy'),
      color: '#f59e0b'
    }
  ]
  return (
    <div>
      <div className="grid grid-cols-2 md:grid-cols-3 2xl:grid-cols-6 gap-3">
        {stats.map(({ icon: Icon, label, value, color }) => (
          <div className="traffic-panel traffic-stat" key={label}>
            <span className="traffic-stat-icon" style={{ color, backgroundColor: `${color}12` }}>
              <Icon size={19} />
            </span>
            <p className="text-xs text-foreground/55 mt-3">{label}</p>
            <strong
              className="block text-xl font-semibold tabular-nums mt-2 truncate"
              title={value}
            >
              {value}
            </strong>
          </div>
        ))}
      </div>
      <p className="mt-2 text-[11px] text-foreground/40">{t('traffic.history.countHelp')}</p>
    </div>
  )
}

function Trend({ snapshot }: { snapshot: DashboardSnapshot }) {
  const { t } = useTranslation()
  const [speed, setSpeed] = useState(false)
  return (
    <section className="traffic-panel">
      <div className="flex flex-wrap justify-between items-center gap-3 mb-4">
        <h2 className="traffic-section-title flex items-center gap-2">
          <LuChartNoAxesColumn size={17} />
          {t('traffic.embedded.trend')}
        </h2>
        <div className="traffic-segments">
          {[false, true].map((value) => (
            <button
              type="button"
              key={String(value)}
              aria-pressed={speed === value}
              onClick={() => setSpeed(value)}
            >
              {t(value ? 'traffic.embedded.speed' : 'traffic.embedded.traffic')}
            </button>
          ))}
        </div>
      </div>
      <div className="flex flex-wrap gap-x-5 gap-y-2 text-xs mb-4 tabular-nums">
        <span className="text-blue-500">
          ↓ {t('traffic.embedded.totalDownload')}: {calcTraffic(snapshot.summary.data.download)}
        </span>
        <span className="text-purple-500">
          ↑ {t('traffic.embedded.totalUpload')}: {calcTraffic(snapshot.summary.data.upload)}
        </span>
        <span className="ml-auto text-foreground/55">
          {t('traffic.total')}:{' '}
          <strong className="text-foreground">{calcTraffic(total(snapshot.summary.data))}</strong>
        </span>
      </div>
      <div className="h-64 lg:h-72">
        {snapshot.series.data.length ? (
          <TrafficTrendChart
            data={trendPoints(snapshot.series, snapshot.query, speed)}
            bucketSizeMs={intervalMs(snapshot.query)}
            timezone={
              snapshot.query.resolution === 'day' ? snapshot.series.aggregationTimezone : undefined
            }
            speed={speed}
          />
        ) : (
          <EmptyState />
        )}
      </div>
      {speed && (
        <p className="mt-3 text-[11px] text-foreground/45">{t('traffic.embedded.speedHelp')}</p>
      )}
    </section>
  )
}
