import { Button } from '@heroui/react'
import { calcTraffic } from '@renderer/utils/calc'
import { dimensionLabel, dimensionValue } from '@renderer/utils/traffic-history'
import { useTranslation } from 'react-i18next'
import type { HistoryDimension, HistoryGroup } from '../../../../shared/traffic-history'

interface Props {
  data: HistoryGroup[]
  dimension: HistoryDimension
  onSelect: (dimension: HistoryDimension, value: string) => void
}

export default function TrafficRankings({ data, dimension, onSelect }: Props): React.JSX.Element {
  const { t } = useTranslation()
  const maximum = Math.max(...data.map((row) => row.upload + row.download), 1)
  return (
    <div className="overflow-auto max-h-96 custom-scrollbar">
      <table className="w-full text-xs">
        <thead className="sticky top-0 bg-content1 text-foreground/60">
          <tr>
            <th className="p-2 text-left">{t(`traffic.history.dimension.${dimension}`)}</th>
            <th className="p-2 text-right">{t('traffic.upload')}</th>
            <th className="p-2 text-right">{t('traffic.download')}</th>
            <th className="p-2 text-right">{t('traffic.history.newConnections')}</th>
            <th className="p-2 text-right">{t('traffic.total')}</th>
          </tr>
        </thead>
        <tbody>
          {data.map((row) => {
            const value = dimensionValue(row, dimension)
            return (
              <tr key={value} className="border-t border-foreground/5 hover:bg-foreground/5">
                <td className="p-2 min-w-40 max-w-96">
                  <Button
                    variant="light"
                    size="sm"
                    className="h-auto min-h-8 w-full justify-start px-1 text-left whitespace-normal break-all"
                    onPress={() => onSelect(dimension, value)}
                  >
                    {dimensionLabel(value, dimension) || t('traffic.history.unknown')}
                  </Button>
                  <div className="h-0.5 bg-primary/15 rounded overflow-hidden" aria-hidden="true">
                    <div
                      className="h-full bg-primary/65"
                      style={{ width: `${(100 * (row.upload + row.download)) / maximum}%` }}
                    />
                  </div>
                </td>
                <td className="p-2 text-right whitespace-nowrap tabular-nums">
                  {calcTraffic(row.upload)}
                </td>
                <td className="p-2 text-right whitespace-nowrap tabular-nums">
                  {calcTraffic(row.download)}
                </td>
                <td className="p-2 text-right tabular-nums">{row.connections.toLocaleString()}</td>
                <td className="p-2 text-right whitespace-nowrap tabular-nums font-medium">
                  {calcTraffic(row.upload + row.download)}
                </td>
              </tr>
            )
          })}
        </tbody>
      </table>
      {!data.length && (
        <p className="p-8 text-center text-sm text-foreground/50">{t('traffic.history.empty')}</p>
      )}
    </div>
  )
}
