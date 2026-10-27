import { Button } from '@heroui/react'
import { calcTraffic } from '@renderer/utils/calc'
import { useTranslation } from 'react-i18next'
import type { HistoryFlow } from '../../../../shared/traffic-history'

interface Props {
  flows: HistoryFlow[]
  onSelect: (flow: HistoryFlow) => void
}
export default function TrafficDetailsTable({ flows, onSelect }: Props): React.JSX.Element {
  const { t } = useTranslation()
  return (
    <div className="overflow-auto max-h-96 custom-scrollbar">
      <table className="w-full text-xs">
        <thead className="sticky top-0 bg-content1 text-foreground/60">
          <tr>
            {[
              'started',
              'dimension.domain',
              'dimension.process',
              'state',
              'dimension.policy',
              'recorded',
              'lifetime'
            ].map((key) => (
              <th key={key} className="p-2 text-left whitespace-nowrap">
                {t(`traffic.history.${key}`)}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {flows.map((flow) => (
            <tr key={flow.id} className="border-t border-foreground/5 hover:bg-foreground/5">
              <td className="p-2 whitespace-nowrap">
                <Button size="sm" variant="light" className="px-1" onPress={() => onSelect(flow)}>
                  {new Date(flow.startAtMs).toLocaleString()}
                </Button>
              </td>
              <td className="p-2 max-w-56 break-all">
                <button
                  className="text-primary text-left hover:underline focus-visible:outline-2"
                  onClick={() => onSelect(flow)}
                >
                  {flow.domain || flow.destinationIp || t('traffic.history.unknown')}
                </button>
              </td>
              <td className="p-2 max-w-48 break-all" title={flow.processPath}>
                {flow.process || flow.processPath || '—'}
              </td>
              <td className="p-2 whitespace-nowrap">{t(`traffic.history.states.${flow.state}`)}</td>
              <td className="p-2 max-w-40 break-all">{flow.policy || '—'}</td>
              <td className="p-2 whitespace-nowrap tabular-nums">
                ↑ {calcTraffic(flow.recordedUpload)}
                <br />↓ {calcTraffic(flow.recordedDownload)}
              </td>
              <td className="p-2 whitespace-nowrap tabular-nums">
                ↑ {calcTraffic(flow.uploadTotal)}
                <br />↓ {calcTraffic(flow.downloadTotal)}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      {!flows.length && (
        <p className="p-8 text-center text-sm text-foreground/50">{t('traffic.history.empty')}</p>
      )}
    </div>
  )
}
