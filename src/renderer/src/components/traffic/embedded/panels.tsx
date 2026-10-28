import { useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useTheme } from 'next-themes'
import { ArcElement, Chart as ChartJS, Tooltip } from 'chart.js'
import { Doughnut } from 'react-chartjs-2'
import { LuArrowDown, LuArrowUp, LuChartNoAxesColumn, LuLink, LuSearch } from 'react-icons/lu'
import { calcTraffic } from '@renderer/utils/calc'
import {
  dimensionValue,
  dimensionLabel,
  rankGroups,
  saveHistoryExport,
  type HistorySort
} from '@renderer/utils/traffic-history'
import type {
  HistoryDimension,
  HistoryGroup,
  HistoryQuery,
  HistoryResult
} from '../../../../../shared/traffic-history'
import { countryLabel, total, type Selection } from './model'

ChartJS.register(ArcElement, Tooltip)
export const palette = [
  '#3b82f6',
  '#a855f7',
  '#06b6d4',
  '#10b981',
  '#f59e0b',
  '#ec4899',
  '#6366f1',
  '#64748b'
]

export function useGroupLabel() {
  const { t, i18n } = useTranslation()
  return (value: string, dimension: HistoryDimension): string => {
    if (!value || ['Unknown', 'UNKNOWN', 'ZZ'].includes(value)) return t('traffic.history.unknown')
    if (dimension === 'country') {
      if (['LOCAL', 'LAN', 'private'].includes(value)) return t('traffic.embedded.local')
      return countryLabel(value, i18n.language)
    }
    return dimensionLabel(value, dimension)
  }
}

export function GroupName({ value, dimension }: { value: string; dimension: HistoryDimension }) {
  const label = useGroupLabel()(value, dimension)
  return (
    <span className="inline-flex min-w-0 items-center gap-2" title={label}>
      {dimension === 'country' && /^[a-z]{2}$/i.test(value) && value.toUpperCase() !== 'ZZ' && (
        <span aria-hidden className={`fi fi-${value.toLowerCase()} shrink-0 rounded-xs`} />
      )}
      <span className="truncate">{label}</span>
    </span>
  )
}

export function EmptyState() {
  const { t } = useTranslation()
  return (
    <p className="py-14 text-center text-sm text-foreground/45">{t('traffic.history.empty')}</p>
  )
}

export function MetricToggle({
  value,
  onChange
}: {
  value: boolean
  onChange: (value: boolean) => void
}) {
  const { t } = useTranslation()
  return (
    <div className="traffic-segments">
      {[false, true].map((connections) => (
        <button
          key={String(connections)}
          type="button"
          aria-label={t(connections ? 'traffic.history.connections' : 'traffic.total')}
          title={t(connections ? 'traffic.history.connections' : 'traffic.total')}
          aria-pressed={value === connections}
          onClick={() => onChange(connections)}
        >
          {connections ? <LuLink size={16} /> : <LuChartNoAxesColumn size={16} />}
        </button>
      ))}
    </div>
  )
}

export function RankList({
  data,
  dimension,
  onSelect,
  selected,
  limit = 8,
  title,
  onViewAll
}: {
  data: HistoryGroup[]
  dimension: HistoryDimension
  onSelect: (selection: Selection) => void
  selected?: string
  limit?: number
  title: string
  onViewAll?: () => void
}) {
  const { t } = useTranslation()
  const [connections, setConnections] = useState(false)
  const rows = rankGroups(data, dimension, '', connections ? 'connections' : 'total', false)
  const maximum = Math.max(1, ...rows.map((row) => (connections ? row.connections : total(row))))
  const sum = rows.reduce((sum, row) => sum + (connections ? row.connections : total(row)), 0)
  return (
    <section className="min-w-0">
      <div className="mb-3 flex items-center justify-between gap-2">
        <h2 className="traffic-section-title">{title}</h2>
        <MetricToggle value={connections} onChange={setConnections} />
      </div>
      <div className="space-y-2 max-h-[440px] overflow-auto custom-scrollbar">
        {rows.slice(0, limit).map((row, index) => {
          const value = dimensionValue(row, dimension)
          const metric = connections ? row.connections : total(row)
          const width = (100 * metric) / maximum
          return (
            <button
              type="button"
              key={value}
              aria-pressed={selected === value}
              onClick={() => onSelect({ dimension, value })}
              className={`traffic-ranking ${selected === value ? 'traffic-selected' : ''}`}
            >
              <div className="flex items-center gap-2 text-sm">
                <span className={`traffic-rank ${index < 3 ? 'traffic-rank-top' : ''}`}>
                  {index + 1}
                </span>
                <span className="min-w-0 flex-1 text-left font-medium">
                  <GroupName value={value} dimension={dimension} />
                </span>
                <strong className="tabular-nums shrink-0">
                  {connections ? metric.toLocaleString() : calcTraffic(metric)}
                </strong>
              </div>
              <div className="pl-7 mt-2">
                <div className="traffic-bar" aria-hidden>
                  <span
                    className="bg-blue-500"
                    style={{
                      width: `${connections ? width : (width * row.download) / Math.max(1, total(row))}%`
                    }}
                  />
                  {!connections && (
                    <span
                      className="bg-purple-500"
                      style={{ width: `${(width * row.upload) / Math.max(1, total(row))}%` }}
                    />
                  )}
                </div>
                <div className="mt-1.5 flex flex-wrap items-center gap-x-2 gap-y-1 text-[11px] tabular-nums">
                  <span className="text-blue-500">↓ {calcTraffic(row.download)}</span>
                  <span className="text-purple-500">↑ {calcTraffic(row.upload)}</span>
                  <span className="text-foreground/50 inline-flex items-center gap-1">
                    <LuLink size={11} />
                    {row.connections.toLocaleString()}
                  </span>
                  <span className="ml-auto text-foreground/50">
                    {(sum ? (metric / sum) * 100 : 0).toFixed(1)}%
                  </span>
                </div>
              </div>
            </button>
          )
        })}
        {!rows.length && <EmptyState />}
      </div>
      {onViewAll && (
        <button type="button" className="traffic-view-all" onClick={onViewAll}>
          {t('traffic.embedded.viewAll')} →
        </button>
      )}
    </section>
  )
}

export function Distribution({
  data,
  dimension,
  onSelect
}: {
  data: HistoryGroup[]
  dimension: HistoryDimension
  onSelect: (selection: Selection) => void
}) {
  const { t } = useTranslation()
  const { resolvedTheme } = useTheme()
  const label = useGroupLabel()
  const rows = rankGroups(data, dimension, '', 'total', false)
  const top = rows.slice(0, 7)
  const other = rows.slice(7).reduce((sum, row) => sum + total(row), 0)
  const values = [...top.map(total), ...(other ? [other] : [])]
  const labels = [
    ...top.map((row) => label(dimensionValue(row, dimension), dimension)),
    ...(other ? [t('traffic.embedded.other')] : [])
  ]
  const sum = values.reduce((a, b) => a + b, 0)
  return (
    <section className="traffic-panel">
      <h2 className="traffic-section-title">{t('traffic.embedded.distribution')}</h2>
      {sum ? (
        <>
          <div className="relative mx-auto h-56 max-w-64 my-5">
            <Doughnut
              aria-label={t('traffic.embedded.distribution')}
              data={{
                labels,
                datasets: [
                  {
                    data: values,
                    backgroundColor: palette,
                    borderWidth: 3,
                    borderColor: resolvedTheme === 'dark' ? '#18181b' : '#ffffff'
                  }
                ]
              }}
              options={{
                maintainAspectRatio: false,
                cutout: '76%',
                animation: false,
                plugins: {
                  legend: { display: false },
                  tooltip: {
                    callbacks: { label: (item) => ` ${item.label}: ${calcTraffic(item.parsed)}` }
                  }
                },
                onClick: (_, elements) => {
                  const row = top[elements[0]?.index]
                  if (row) onSelect({ dimension, value: dimensionValue(row, dimension) })
                }
              }}
            />
            <div className="absolute inset-0 flex flex-col items-center justify-center pointer-events-none">
              <span className="text-xs text-foreground/50">{t('traffic.total')}</span>
              <strong className="mt-1 text-xl tabular-nums">{calcTraffic(sum)}</strong>
            </div>
          </div>
          <div className="space-y-2 text-xs">
            {labels.map((name, index) => (
              <div className="flex items-center gap-2" key={`${index}-${name}`}>
                <span
                  className="h-2 w-2 rounded-full shrink-0"
                  style={{ background: palette[index] }}
                />
                <span className="truncate flex-1" title={name}>
                  {name}
                </span>
                <span className="text-foreground/60 tabular-nums">
                  {((values[index] / sum) * 100).toFixed(1)}%
                </span>
              </div>
            ))}
          </div>
        </>
      ) : (
        <EmptyState />
      )}
    </section>
  )
}

export function TopBars({
  data,
  dimension,
  onSelect,
  title
}: {
  data: HistoryGroup[]
  dimension: HistoryDimension
  onSelect: (selection: Selection) => void
  title: string
}) {
  const rows = rankGroups(data, dimension, '', 'total', false).slice(0, 10)
  const maximum = Math.max(1, ...rows.map(total))
  return (
    <section className="traffic-panel min-w-0">
      <h2 className="traffic-section-title mb-5">{title}</h2>
      <div className="space-y-4">
        {rows.map((row, index) => {
          const value = dimensionValue(row, dimension)
          return (
            <button
              type="button"
              key={value}
              className="block w-full text-left rounded focus-visible:outline-2 focus-visible:outline-primary"
              onClick={() => onSelect({ dimension, value })}
            >
              <div className="flex justify-between gap-3 text-xs mb-1.5">
                <span className="min-w-0 truncate">
                  <GroupName value={value} dimension={dimension} />
                </span>
                <span className="shrink-0 tabular-nums text-foreground/65">
                  {calcTraffic(total(row))}
                </span>
              </div>
              <div className="traffic-bar h-2" aria-hidden>
                <span
                  style={{
                    background: palette[index % palette.length],
                    width: `${(total(row) / maximum) * 100}%`
                  }}
                />
              </div>
            </button>
          )
        })}
        {!rows.length && <EmptyState />}
      </div>
    </section>
  )
}

export function GroupTable({
  result,
  dimension,
  query,
  onSelect,
  secondaryDimension
}: {
  result: HistoryResult<HistoryGroup[]>
  dimension: HistoryDimension
  query: HistoryQuery
  onSelect: (selection: Selection) => void
  secondaryDimension?: HistoryDimension
}) {
  const { t } = useTranslation()
  const [search, setSearch] = useState('')
  const [sort, setSort] = useState<HistorySort>('total')
  const [ascending, setAscending] = useState(false)
  const [page, setPage] = useState(0)
  const label = useGroupLabel()
  const rows = useMemo(
    () => rankGroups(result.data, dimension, '', sort, ascending),
    [result, dimension, sort, ascending]
  ).filter((row) =>
    `${label(dimensionValue(row, dimension), dimension)} ${secondaryDimension ? dimensionValue(row, secondaryDimension) : ''}`
      .toLocaleLowerCase()
      .includes(search.toLocaleLowerCase().trim())
  )
  const currentPage = Math.min(page, Math.max(0, Math.ceil(rows.length / 15) - 1))
  const sum = result.data.reduce((sum, row) => sum + total(row), 0)
  const exportRows = (format: 'csv' | 'json'): void =>
    saveHistoryExport(
      `traffic-${dimension}`,
      format,
      rows.map((row) => ({ ...row })),
      {
        query,
        groupBy: secondaryDimension ? [dimension, secondaryDimension] : dimension,
        sort,
        ascending,
        search,
        truncated: result.truncated,
        lastCommitAt: result.lastCommitAt,
        scope: 'Loaded top results only'
      }
    )
  return (
    <section className="traffic-panel min-w-0">
      <div className="flex flex-wrap justify-between gap-3 mb-4">
        <label className="traffic-search">
          <LuSearch size={15} />
          <input
            aria-label={t('traffic.history.searchRankings')}
            placeholder={t('traffic.history.searchRankings')}
            value={search}
            onChange={(event) => {
              setSearch(event.target.value)
              setPage(0)
            }}
          />
        </label>
        <div className="flex gap-2">
          <button type="button" className="traffic-button" onClick={() => exportRows('csv')}>
            {t('traffic.history.exportCsv')}
          </button>
          <button type="button" className="traffic-button" onClick={() => exportRows('json')}>
            {t('traffic.history.exportJson')}
          </button>
        </div>
      </div>
      <div className="overflow-x-auto custom-scrollbar">
        <table className="traffic-table">
          <thead>
            <tr>
              {(['label', 'download', 'upload', 'total', 'connections'] as const).map((field) => (
                <th key={field} className={field === 'label' ? 'text-left' : 'text-right'}>
                  <button
                    type="button"
                    className="inline-flex items-center gap-1"
                    onClick={() => {
                      setSort(field)
                      setAscending(sort === field ? !ascending : field === 'label')
                      setPage(0)
                    }}
                  >
                    {field === 'label'
                      ? t(`traffic.history.dimension.${dimension}`)
                      : t(
                          field === 'connections'
                            ? 'traffic.history.newConnections'
                            : `traffic.${field}`
                        )}
                    {sort === field &&
                      (ascending ? <LuArrowUp size={12} /> : <LuArrowDown size={12} />)}
                  </button>
                </th>
              ))}
              <th className="text-right">{t('traffic.embedded.share')}</th>
            </tr>
          </thead>
          <tbody>
            {rows.slice(currentPage * 15, (currentPage + 1) * 15).map((row) => {
              const value = dimensionValue(row, dimension)
              return (
                <tr
                  key={JSON.stringify([value, secondaryDimension ? row[secondaryDimension] : null])}
                >
                  <td className="max-w-72">
                    <button
                      type="button"
                      className="text-left hover:text-primary max-w-full"
                      onClick={() =>
                        onSelect({
                          dimension,
                          value,
                          filters: secondaryDimension
                            ? { [secondaryDimension]: dimensionValue(row, secondaryDimension) }
                            : undefined
                        })
                      }
                    >
                      <GroupName value={value} dimension={dimension} />
                      {secondaryDimension && (
                        <span className="block text-foreground/50 max-w-72 truncate text-[11px]">
                          {dimensionValue(row, secondaryDimension)}
                        </span>
                      )}
                    </button>
                  </td>
                  <td className="text-blue-500">{calcTraffic(row.download)}</td>
                  <td className="text-purple-500">{calcTraffic(row.upload)}</td>
                  <td className="font-semibold">{calcTraffic(total(row))}</td>
                  <td>{row.connections.toLocaleString()}</td>
                  <td>{(sum ? (total(row) / sum) * 100 : 0).toFixed(1)}%</td>
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>
      {!rows.length && <EmptyState />}
      <div className="mt-4 flex flex-wrap items-center justify-between gap-3 text-xs text-foreground/50">
        <span>
          {t('traffic.embedded.resultScope', { count: result.data.length })}
          {result.truncated && ` · ${t('traffic.history.topTruncated')}`}
        </span>
        <div className="flex items-center gap-3">
          <button
            type="button"
            className="traffic-button"
            disabled={currentPage === 0}
            onClick={() => setPage(currentPage - 1)}
          >
            {t('traffic.history.previous')}
          </button>
          <span>
            {currentPage + 1} / {Math.max(1, Math.ceil(rows.length / 15))}
          </span>
          <button
            type="button"
            className="traffic-button"
            disabled={(currentPage + 1) * 15 >= rows.length}
            onClick={() => setPage(currentPage + 1)}
          >
            {t('traffic.history.next')}
          </button>
        </div>
      </div>
    </section>
  )
}
