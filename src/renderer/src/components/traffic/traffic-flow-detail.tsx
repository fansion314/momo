import {
  Button,
  Modal,
  ModalBody,
  ModalContent,
  ModalFooter,
  ModalHeader,
  Spinner
} from '@heroui/react'
import { queryTrafficHistory } from '@renderer/utils/ipc'
import { calcTraffic } from '@renderer/utils/calc'
import { flowDimension, saveHistoryExport } from '@renderer/utils/traffic-history'
import { useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import {
  historyDimensions,
  type HistoryDimension,
  type HistoryFlow,
  type HistoryQuery,
  type HistoryResult,
  type HistorySample
} from '../../../../shared/traffic-history'

interface Props {
  flow: HistoryFlow
  query: HistoryQuery
  onClose: () => void
  onFilter: (dimension: HistoryDimension, value: string) => void
}
export default function TrafficFlowDetail({
  flow,
  query,
  onClose,
  onFilter
}: Props): React.JSX.Element {
  const { t } = useTranslation()
  const selectedQuery = useRef(query).current
  const [detail, setDetail] = useState(flow)
  const [samples, setSamples] = useState<HistorySample[]>([])
  const [next, setNext] = useState<number>()
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const generation = useRef(0)
  const [page, setPage] = useState<number>()
  useEffect(() => {
    const current = ++generation.current
    let cancelled = false
    const valid = (): boolean => !cancelled && current === generation.current
    setLoading(true)
    setError('')
    void (async () => {
      try {
        if (page === undefined) {
          const result = (await queryTrafficHistory(`flows/${flow.id}`, {
            ...selectedQuery,
            resolution: 'raw',
            cursor: undefined
          })) as HistoryResult<HistoryFlow>
          if (!valid()) return
          setDetail(result.data)
        }
        const result = (await queryTrafficHistory(`flows/${flow.id}/samples`, {
          ...selectedQuery,
          resolution: 'raw',
          limit: 100,
          cursor: page
        })) as HistoryResult<HistorySample[]>
        if (!valid()) return
        setSamples((previous) => (page === undefined ? result.data : [...previous, ...result.data]))
        setNext(result.nextCursor)
      } catch (reason) {
        if (valid()) setError(String(reason))
      } finally {
        if (valid()) setLoading(false)
      }
    })()
    return () => {
      cancelled = true
    }
  }, [flow.id, selectedQuery, page])

  const date = (time: number | null): string =>
    time === null ? '—' : new Date(time).toLocaleString()
  const fields: [string, string][] = [
    ['recordId', `${detail.id} / ${detail.trackerId}`],
    ['session', detail.sessionId],
    ['state', t(`traffic.history.states.${detail.state}`)],
    ['started', date(detail.startAtMs)],
    ['lastObserved', date(detail.lastAtMs)],
    ['ended', date(detail.endAtMs)],
    ['baselineAt', date(detail.baselineAtMs)],
    [
      'baseline',
      `↑ ${calcTraffic(detail.baselineUpload)}  ↓ ${calcTraffic(detail.baselineDownload)}`
    ],
    [
      'recorded',
      `↑ ${calcTraffic(detail.recordedUpload)}  ↓ ${calcTraffic(detail.recordedDownload)}`
    ],
    ['lifetime', `↑ ${calcTraffic(detail.uploadTotal)}  ↓ ${calcTraffic(detail.downloadTotal)}`],
    ['preexisting', t(detail.preexisting ? 'traffic.history.yes' : 'traffic.history.no')],
    ['accounted', t(detail.accounted ? 'traffic.history.yes' : 'traffic.history.no')]
  ]
  return (
    <Modal isOpen onClose={onClose} size="4xl" scrollBehavior="inside">
      <ModalContent>
        <ModalHeader>{t('traffic.history.flowDetail')}</ModalHeader>
        <ModalBody>
          {error && (
            <p role="alert" className="text-sm text-danger break-all">
              {t('traffic.history.detailUnavailable')} {error}
            </p>
          )}
          <p className="text-xs text-foreground/60">{t('traffic.history.counterHelp')}</p>
          <dl className="grid grid-cols-1 sm:grid-cols-2 gap-x-6 gap-y-2 text-xs">
            {fields.map(([key, value]) => (
              <div key={key} className="border-b border-foreground/10 py-2">
                <dt className="text-foreground/60">{t(`traffic.history.${key}`)}</dt>
                <dd className="mt-1 break-all">{value}</dd>
              </div>
            ))}
          </dl>
          <h3 className="font-medium mt-2">{t('traffic.history.exactFilters')}</h3>
          <div className="flex flex-wrap gap-1">
            {historyDimensions.map((dimension) => {
              const value = flowDimension(detail, dimension)
              return (
                <Button
                  size="sm"
                  variant="flat"
                  key={dimension}
                  onPress={() => {
                    onFilter(dimension, value)
                    onClose()
                  }}
                  className="h-auto min-h-8 max-w-full py-1 whitespace-normal break-all text-left"
                >
                  {t(`traffic.history.dimension.${dimension}`)}:{' '}
                  {value || t('traffic.history.unknown')}
                </Button>
              )
            })}
          </div>
          <h3 className="font-medium mt-2">{t('traffic.history.orderedChain')}</h3>
          <ol className="list-decimal list-inside text-sm">
            {(detail.chains || []).map((hop, index) => (
              <li key={index}>{hop}</li>
            ))}
          </ol>
          <p className="text-xs text-foreground/60">
            {t('traffic.history.providerChains')}: {JSON.stringify(detail.providerChains)}
          </p>
          {(!detail.country || !detail.asn) && (
            <p className="text-xs text-foreground/60">{t('traffic.history.geoMissing')}</p>
          )}
          <details>
            <summary className="cursor-pointer text-sm">{t('traffic.history.metadata')}</summary>
            <pre className="text-xs whitespace-pre-wrap break-all bg-content2 rounded p-2 mt-2">
              {JSON.stringify({ metadata: detail.metadata, geo: detail.geo }, null, 2)}
            </pre>
          </details>
          <h3 className="font-medium mt-2">{t('traffic.history.samples')}</h3>
          <p className="text-xs text-foreground/60">{t('traffic.history.sampleScope')}</p>
          <div className="overflow-auto">
            <table className="w-full text-xs">
              <thead>
                <tr>
                  {['started', 'ended', 'upload', 'download'].map((key) => (
                    <th key={key} className="text-left p-2">
                      {t(
                        key === 'upload' || key === 'download'
                          ? `traffic.${key}`
                          : `traffic.history.${key}`
                      )}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {samples.map((sample) => (
                  <tr key={sample.id} className="border-t border-foreground/10">
                    <td className="p-2">{date(sample.fromMs)}</td>
                    <td className="p-2">{date(sample.atMs)}</td>
                    <td className="p-2">{calcTraffic(sample.upload)}</td>
                    <td className="p-2">{calcTraffic(sample.download)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {loading && <Spinner size="sm" label={t('traffic.history.loading')} />}
          {!loading && samples.length === 0 && (
            <p className="text-sm text-foreground/60">{t('traffic.history.noSamples')}</p>
          )}
          {next !== undefined && (
            <Button size="sm" isDisabled={loading} onPress={() => setPage(next)}>
              {t('traffic.history.loadMore')}
            </Button>
          )}
        </ModalBody>
        <ModalFooter>
          <Button
            size="sm"
            variant="flat"
            onPress={() =>
              saveHistoryExport('traffic-flow-detail', 'json', [{ ...detail, samples }], {
                query: selectedQuery,
                scope: 'One flow; samples loaded in selected time range',
                samplesTruncated: next !== undefined,
                samplesComplete: !loading && !error && next === undefined,
                sampleError: error || undefined
              })
            }
          >
            {t('traffic.history.exportDetail')}
          </Button>
          <Button size="sm" variant="light" onPress={onClose}>
            {t('common.close', { defaultValue: 'Close' })}
          </Button>
        </ModalFooter>
      </ModalContent>
    </Modal>
  )
}
