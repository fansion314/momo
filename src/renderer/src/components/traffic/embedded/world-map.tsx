import { useMemo } from 'react'
import { useTranslation } from 'react-i18next'
import { calcTraffic } from '@renderer/utils/calc'
import type { HistoryGroup } from '../../../../../shared/traffic-history'
import { GroupName, useGroupLabel } from './panels'
import { total, type Selection } from './model'
import countries from './world-map.json'

// Offline Natural Earth map, projected from neko-master's bundled world atlas.
export default function WorldMap({
  data,
  onSelect
}: {
  data: HistoryGroup[]
  onSelect: (selection: Selection) => void
}) {
  const { t } = useTranslation()
  const label = useGroupLabel()
  const lookup = useMemo(
    () => new Map(data.map((row) => [String(row.country).toUpperCase(), row])),
    [data]
  )
  const maximum = Math.max(1, ...data.map(total))
  return (
    <section className="traffic-panel">
      <h2 className="traffic-section-title">{t('traffic.embedded.worldMap')}</h2>
      <svg
        viewBox="0 0 960 470"
        className="traffic-world-map mt-4 w-full max-h-[440px]"
        role="group"
        aria-label={t('traffic.embedded.worldMap')}
      >
        {countries.map((country, index) => {
          const row = lookup.get(country.code)
          const value = row ? total(row) : 0
          const name = label(country.code || country.name, 'country')
          return (
            <path
              key={`${country.code}-${index}`}
              d={country.path || ''}
              className={row ? 'traffic-map-country traffic-map-active' : 'traffic-map-country'}
              style={
                row
                  ? {
                      fill: `color-mix(in srgb, #6366f1 ${25 + 75 * Math.sqrt(value / maximum)}%, var(--traffic-map-empty))`
                    }
                  : undefined
              }
              tabIndex={row ? 0 : undefined}
              role={row ? 'button' : undefined}
              aria-label={row ? name : undefined}
              onClick={() => {
                if (row) onSelect({ dimension: 'country', value: String(row.country ?? '') })
              }}
              onKeyDown={(event) => {
                if (row && (event.key === 'Enter' || event.key === ' ')) {
                  event.preventDefault()
                  onSelect({ dimension: 'country', value: String(row.country ?? '') })
                }
              }}
            >
              <title>
                {name}
                {row
                  ? ` · ↓ ${calcTraffic(row.download)} · ↑ ${calcTraffic(row.upload)} · ${t('traffic.history.newConnections')}: ${row.connections.toLocaleString()}`
                  : ''}
              </title>
            </path>
          )
        })}
      </svg>
      <div className="flex flex-wrap items-center gap-3 text-xs text-foreground/60 mt-3">
        <span>{t('traffic.embedded.mapHint')}</span>
        <span className="ml-auto">{t('traffic.embedded.low')}</span>
        <span className="h-2 w-24 rounded-full bg-linear-to-r from-indigo-200 to-indigo-600" />
        <span>{t('traffic.embedded.high')}</span>
      </div>
      <div className="mt-4 flex flex-wrap gap-x-5 gap-y-2 text-xs">
        {[...data]
          .sort((a, b) => total(b) - total(a))
          .slice(0, 5)
          .map((row) => (
            <button
              key={String(row.country)}
              type="button"
              onClick={() => onSelect({ dimension: 'country', value: String(row.country ?? '') })}
              className="hover:text-primary"
            >
              <GroupName dimension="country" value={String(row.country ?? '')} />
            </button>
          ))}
      </div>
    </section>
  )
}
