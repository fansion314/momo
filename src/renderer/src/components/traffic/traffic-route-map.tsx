import { Button } from '@heroui/react'
import { calcTraffic } from '@renderer/utils/calc'
import { dimensionValue } from '@renderer/utils/traffic-history'
import { useTranslation } from 'react-i18next'
import type { HistoryDimension, HistoryGroup } from '../../../../shared/traffic-history'

interface Props {
  data: HistoryGroup[]
  onFilter: (dimension: HistoryDimension, value: string) => void
}

export default function TrafficRouteMap({ data, onFilter }: Props): React.JSX.Element {
  const { t } = useTranslation()
  const maximum = Math.max(1, ...data.map((row) => row.upload + row.download))
  return (
    <div className="overflow-auto max-h-96 custom-scrollbar space-y-3">
      <p className="text-xs text-foreground/60">{t('traffic.history.routeHelp')}</p>
      {data.map((row, index) => {
        const chain = Array.isArray(row.chain) ? row.chain : []
        const chainValue = dimensionValue(row, 'chain')
        return (
          <div
            key={`${dimensionValue(row, 'rule')}-${dimensionValue(row, 'chain')}-${index}`}
            className="rounded-lg border border-foreground/10 p-2"
          >
            <div className="flex flex-wrap items-center gap-1 text-xs">
              <Button
                size="sm"
                variant="flat"
                onPress={() => onFilter('rule', dimensionValue(row, 'rule'))}
              >
                {dimensionValue(row, 'rule') || t('traffic.history.unknown')}
              </Button>
              <span className="text-foreground/50 px-1" aria-hidden="true">
                →
              </span>
              <Button
                size="sm"
                variant="flat"
                color="primary"
                onPress={() => onFilter('policy', dimensionValue(row, 'policy'))}
              >
                {dimensionValue(row, 'policy') || t('traffic.history.unknown')}
              </Button>
              <span className="ml-auto tabular-nums px-2">
                {calcTraffic(row.upload + row.download)}
              </span>
            </div>
            <div
              className="flex flex-wrap items-center gap-1 mt-2"
              aria-label={t('traffic.history.orderedChain')}
            >
              {chain.map((hop, hopIndex) => (
                <span className="inline-flex items-center gap-1" key={`${hopIndex}-${hop}`}>
                  {hopIndex > 0 && (
                    <span className="text-foreground/40" aria-hidden="true">
                      →
                    </span>
                  )}
                  <Button
                    size="sm"
                    variant="light"
                    onPress={() =>
                      onFilter(
                        hopIndex === 0
                          ? 'proxy'
                          : hopIndex === chain.length - 1
                            ? 'policy'
                            : 'chain',
                        hopIndex === 0 || hopIndex === chain.length - 1
                          ? hop
                          : JSON.stringify(chain)
                      )
                    }
                  >
                    {hop}
                  </Button>
                </span>
              ))}
              <Button size="sm" variant="light" onPress={() => onFilter('chain', chainValue)}>
                {t('traffic.history.filterChain')}
              </Button>
            </div>
            <div className="h-1 rounded bg-primary/10 mt-2 overflow-hidden" aria-hidden="true">
              <div
                className="h-full bg-primary/60"
                style={{ width: `${(100 * (row.upload + row.download)) / maximum}%` }}
              />
            </div>
          </div>
        )
      })}
      {!data.length && (
        <p className="p-8 text-center text-sm text-foreground/50">{t('traffic.history.empty')}</p>
      )}
    </div>
  )
}
