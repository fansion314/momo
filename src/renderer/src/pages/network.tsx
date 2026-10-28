import BasePage from '@renderer/components/base/base-page'
import NetworkTopologyCard from '@renderer/components/network/network-topology'
import MediaUnlock from '@renderer/components/network/media-unlock'
import React, { useState, useEffect, useCallback, useMemo, useRef } from 'react'
import { Button, Select, SelectItem, Chip, Tooltip, Input } from '@heroui/react'
import {
  IoRefresh,
  IoCopyOutline,
  IoCheckmark,
  IoEyeOutline,
  IoEyeOffOutline,
  IoAdd,
  IoClose
} from 'react-icons/io5'
import { IoMdGlobe, IoMdPulse } from 'react-icons/io'
import { FcGoogle } from 'react-icons/fc'
import { SiCloudflare, SiGithub } from 'react-icons/si'
import { useTranslation } from 'react-i18next'
import { fetchIPInfo, measureLatency } from '@renderer/utils/ipc'
import { useAppConfig } from '@renderer/hooks/use-app-config'
import type { IPInfo, IPProvider } from '../../../shared/network-info'

const cardClass =
  'flex min-w-0 flex-col rounded-xl border border-foreground/10 bg-content1 p-3 shadow-sm'

const CountryFlag: React.FC<{ code?: string }> = ({ code }) =>
  code?.length === 2 ? <span className={`fi fi-${code.toLowerCase()} rounded-sm shrink-0`} /> : null

type LatencyStatus = 'idle' | 'pending' | 'success' | 'error'
interface LatencyResult {
  latency: number | null
  status: LatencyStatus
}
interface LatencyTarget {
  name: string
  url: string
  custom?: boolean
}
const DEFAULT_LATENCY_TARGETS: LatencyTarget[] = [
  { name: 'Google', url: 'https://www.google.com/generate_204' },
  { name: 'Cloudflare', url: 'https://www.cloudflare.com/cdn-cgi/trace' },
  { name: 'GitHub', url: 'https://github.com/' }
]

function normalizeLatencyUrl(value: string): string | null {
  const trimmed = value.trim()
  if (!trimmed) return null

  const urlText = /^[a-z][a-z\d+\-.]*:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`
  try {
    const url = new URL(urlText)
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return null
    return url.toString()
  } catch {
    return null
  }
}

function normalizeLatencyTarget(
  value: string | Partial<INetworkLatencyTarget>
): INetworkLatencyTarget | null {
  if (typeof value === 'string') {
    const url = normalizeLatencyUrl(value)
    if (!url) return null
    return { name: getLatencyTargetName(url), url }
  }

  const url = normalizeLatencyUrl(value.url ?? '')
  if (!url) return null
  return { name: value.name?.trim() || getLatencyTargetName(url), url }
}

function normalizeLatencyTargets(
  values: Array<string | Partial<INetworkLatencyTarget>> = []
): INetworkLatencyTarget[] {
  const result: INetworkLatencyTarget[] = []
  const seen = new Set<string>()
  for (const value of values) {
    const target = normalizeLatencyTarget(value)
    if (!target || seen.has(target.url)) continue
    seen.add(target.url)
    result.push(target)
  }
  return result
}

function getLatencyTargetName(url: string): string {
  try {
    return new URL(url).hostname || url
  } catch {
    return url
  }
}

function latencyColor(latency: number | null): string {
  if (latency === null) return ''
  if (latency < 100) return 'text-success'
  if (latency < 300) return 'text-warning'
  return 'text-danger'
}

const providers: { value: IPProvider; label: string }[] = [
  { value: 'ip.sb', label: 'IP.SB' },
  { value: 'ipwho.is', label: 'ipwho.is' },
  { value: 'ipapi.is', label: 'ipapi.is' },
  { value: 'geojs', label: 'GeoJS' }
]

const sourceLabels: Record<IPInfo['source'], string> = {
  'ip.sb': 'IP.SB',
  'ipwho.is': 'ipwho.is',
  'ipapi.is': 'ipapi.is',
  'ipapi.co': 'ipapi.co',
  'skk.moe': 'SKK',
  geojs: 'GeoJS',
  Cloudflare: 'Cloudflare'
}

interface InfoRowProps {
  label: string
  value: React.ReactNode
  mono?: boolean
}

const InfoRow: React.FC<InfoRowProps> = ({ label, value, mono }) => (
  <div className="flex min-w-0 items-center justify-between gap-2">
    <span className="shrink-0 text-xs text-foreground/60">{label}</span>
    <span
      title={typeof value === 'string' ? value : undefined}
      className={`min-w-0 truncate text-right text-[13px] font-medium ${mono ? 'font-mono' : ''}`}
    >
      {value}
    </span>
  </div>
)

const IPInfoCard: React.FC = () => {
  const { t } = useTranslation()
  const { appConfig, patchAppConfig } = useAppConfig()
  const provider = appConfig?.networkIPProvider ?? 'ip.sb'
  const appConfigLoaded = appConfig !== undefined
  const fetchIdRef = useRef(0)
  const [ipInfo, setIpInfo] = useState<IPInfo | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [copied, setCopied] = useState(false)
  const [hidden, setHidden] = useState(false)
  const fetchIP = useCallback(
    async (target: IPProvider) => {
      const currentFetchId = ++fetchIdRef.current
      setLoading(true)
      setError(null)
      try {
        const data = await fetchIPInfo(target)
        if (currentFetchId !== fetchIdRef.current) return
        setIpInfo(data)
      } catch (e) {
        if (currentFetchId !== fetchIdRef.current) return
        setError(
          e instanceof Error ? e.message : typeof e === 'string' ? e : t('network.fetchFailed')
        )
        setIpInfo(null)
      } finally {
        if (currentFetchId === fetchIdRef.current) {
          setLoading(false)
        }
      }
    },
    [t]
  )

  useEffect(() => {
    if (!appConfigLoaded) return
    void fetchIP(provider)
  }, [appConfigLoaded, fetchIP, provider])

  const handleCopy = useCallback(() => {
    if (!ipInfo?.ip) return
    navigator.clipboard.writeText(ipInfo.ip)
    setCopied(true)
    setTimeout(() => setCopied(false), 2000)
  }, [ipInfo?.ip])

  return (
    <section className={`${cardClass} @container/ip-info`} aria-label={t('network.ipCard.title')}>
      <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
        <div className="flex min-w-0 items-center gap-2">
          <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-primary/15 text-primary">
            <IoMdGlobe size={18} />
          </div>
          <h3 className="truncate text-[15px] font-semibold">{t('network.ipCard.title')}</h3>
        </div>
        <div className="ml-auto flex shrink-0 items-center gap-1">
          <Select
            size="sm"
            className="w-24"
            aria-label={t('network.ipProvider')}
            selectedKeys={[provider]}
            onSelectionChange={(keys) => {
              const value = Array.from(keys)[0] as IPProvider | undefined
              if (value) void patchAppConfig({ networkIPProvider: value })
            }}
          >
            {providers.map((item) => (
              <SelectItem key={item.value}>{item.label}</SelectItem>
            ))}
          </Select>
          <Tooltip content={t('common.refresh')}>
            <Button
              size="sm"
              isIconOnly
              variant="light"
              isLoading={loading}
              aria-label={t('common.refresh')}
              onPress={() => fetchIP(provider)}
              className="h-7 w-7 min-w-0"
            >
              <IoRefresh size={16} />
            </Button>
          </Tooltip>
        </div>
      </div>
      {loading && !ipInfo && (
        <div className="flex flex-1 items-center justify-center py-10">
          <span className="h-6 w-6 animate-spin rounded-full border-2 border-foreground/10 border-t-primary" />
        </div>
      )}
      {error && (
        <div
          role="alert"
          className="rounded-lg border border-danger/20 bg-danger/10 p-3 text-[13px] break-words text-danger"
        >
          {error}
        </div>
      )}
      {ipInfo && (
        <div className="flex flex-1 flex-col gap-2">
          <div className="flex min-w-0 flex-wrap items-center justify-between gap-x-2 gap-y-1 rounded-lg border border-primary/20 bg-primary/8 px-2.5 py-1.5 @min-[18rem]/ip-info:flex-nowrap">
            <span className="shrink-0 text-xs text-foreground/60">{t('network.ipAddress')}</span>
            <div className="flex w-full min-w-0 items-center justify-end gap-1.5 @min-[18rem]/ip-info:w-auto">
              <span
                className="truncate font-mono text-[13px] font-semibold text-primary"
                title={hidden ? undefined : ipInfo.ip}
              >
                {hidden ? '••••••••••••' : ipInfo.ip}
              </span>
              <button
                type="button"
                onClick={() => setHidden((value) => !value)}
                aria-label={t(hidden ? 'network.showIP' : 'network.hideIP')}
                className="shrink-0 rounded p-0.5 text-primary/70 hover:text-primary focus-visible:outline-2 focus-visible:outline-primary"
              >
                {hidden ? <IoEyeOffOutline size={14} /> : <IoEyeOutline size={14} />}
              </button>
              <Tooltip content={copied ? t('network.copied') : t('network.copy')}>
                <button
                  type="button"
                  onClick={handleCopy}
                  aria-label={t('network.copy')}
                  className="shrink-0 rounded p-0.5 text-primary/70 hover:text-primary focus-visible:outline-2 focus-visible:outline-primary"
                >
                  {copied ? <IoCheckmark size={14} /> : <IoCopyOutline size={14} />}
                </button>
              </Tooltip>
            </div>
          </div>
          <div className="grid grid-cols-1 gap-x-4 gap-y-2 @min-[20rem]/ip-info:grid-cols-2">
            {(ipInfo.country || ipInfo.countryCode) && (
              <InfoRow
                label={t('network.country')}
                value={
                  <span className="flex min-w-0 items-center justify-end gap-1.5">
                    <CountryFlag code={ipInfo.countryCode} />
                    <span className="truncate" title={ipInfo.country ?? ipInfo.countryCode}>
                      {ipInfo.country ?? ipInfo.countryCode}
                    </span>
                  </span>
                }
              />
            )}
            {(ipInfo.city || ipInfo.region) && (
              <InfoRow
                label={t('network.city')}
                value={[...new Set([ipInfo.city, ipInfo.region].filter(Boolean))].join(', ')}
              />
            )}
            {ipInfo.asn != null && <InfoRow label="ASN" value={`AS${ipInfo.asn}`} mono />}
            {ipInfo.org && <InfoRow label={t('network.organization')} value={ipInfo.org} />}
            {ipInfo.isp && <InfoRow label="ISP" value={ipInfo.isp} />}
            {ipInfo.timezone && <InfoRow label={t('network.timezone')} value={ipInfo.timezone} />}
            {ipInfo.latitude != null && ipInfo.longitude != null && (
              <InfoRow
                label={t('network.coordinates')}
                value={`${ipInfo.latitude.toFixed(4)}, ${ipInfo.longitude.toFixed(4)}`}
                mono
              />
            )}
            <InfoRow label={t('network.dataSource')} value={sourceLabels[ipInfo.source]} />
            {(ipInfo.isProxy !== undefined || ipInfo.isVPN !== undefined) && (
              <div className="flex items-center justify-between gap-3">
                <span className="text-[13px] text-foreground/60">
                  {t('network.proxyDetection')}
                </span>
                <div className="flex gap-1">
                  {ipInfo.isProxy && (
                    <Chip size="sm" color="warning" variant="flat">
                      Proxy
                    </Chip>
                  )}
                  {ipInfo.isVPN && (
                    <Chip size="sm" color="warning" variant="flat">
                      VPN
                    </Chip>
                  )}
                  {!ipInfo.isProxy && !ipInfo.isVPN && (
                    <Chip size="sm" color="success" variant="flat">
                      {t('network.clean')}
                    </Chip>
                  )}
                </div>
              </div>
            )}
          </div>
          {ipInfo.source === 'Cloudflare' && (
            <p className="mt-auto border-t border-foreground/10 pt-2 text-xs leading-relaxed text-foreground/60">
              {t('network.ipFallback')}
            </p>
          )}
        </div>
      )}
      {!loading && !error && !ipInfo && (
        <div className="py-6 text-center text-sm text-foreground/50">{t('network.noData')}</div>
      )}
    </section>
  )
}

function TargetLogo({ target }: { target: LatencyTarget }): React.ReactElement {
  const hostname = new URL(target.url).hostname.replace(/^www\./, '')
  if (hostname === 'google.com') return <FcGoogle size={26} />
  if (hostname === 'cloudflare.com') return <SiCloudflare size={26} className="text-[#f48120]" />
  if (hostname === 'github.com') return <SiGithub size={26} />
  return <IoMdGlobe size={26} className="text-primary/70" />
}

const LatencyCard: React.FC = () => {
  const { t } = useTranslation()
  const { appConfig, patchAppConfig } = useAppConfig()
  const [isAddingLatencyTarget, setIsAddingLatencyTarget] = useState(false)
  const [customLatencyName, setCustomLatencyName] = useState('')
  const [customLatencyUrl, setCustomLatencyUrl] = useState('')
  const [customLatencyNameError, setCustomLatencyNameError] = useState(false)
  const [customLatencyUrlError, setCustomLatencyUrlError] = useState(false)

  const [latencyResults, setLatencyResults] = useState<Record<string, LatencyResult>>({})
  const [testingLatency, setTestingLatency] = useState(false)
  const appConfigLoaded = appConfig !== undefined
  const customLatencyTargets = useMemo(
    () => normalizeLatencyTargets(appConfig?.networkLatencyTargets),
    [appConfig?.networkLatencyTargets]
  )

  const latencyTargets = useMemo(() => {
    const defaultUrls = new Set(DEFAULT_LATENCY_TARGETS.map((target) => target.url))
    return [
      ...DEFAULT_LATENCY_TARGETS,
      ...customLatencyTargets
        .filter((target) => !defaultUrls.has(target.url))
        .map((target) => ({ ...target, custom: true }))
    ]
  }, [customLatencyTargets])

  const patchCustomLatencyTargets = useCallback(
    async (targets: Array<string | Partial<INetworkLatencyTarget>>) => {
      const defaultUrls = new Set(DEFAULT_LATENCY_TARGETS.map((target) => target.url))
      await patchAppConfig({
        networkLatencyTargets: normalizeLatencyTargets(targets).filter(
          (target) => !defaultUrls.has(target.url)
        )
      })
    },
    [patchAppConfig]
  )

  const closeLatencyTargetForm = useCallback(() => {
    setIsAddingLatencyTarget(false)
    setCustomLatencyName('')
    setCustomLatencyUrl('')
    setCustomLatencyNameError(false)
    setCustomLatencyUrlError(false)
  }, [])

  const addCustomLatencyTarget = useCallback(async () => {
    const name = customLatencyName.trim()
    const url = normalizeLatencyUrl(customLatencyUrl)
    setCustomLatencyNameError(!name)
    setCustomLatencyUrlError(!url)
    if (!name || !url) return

    const existingUrls = new Set(DEFAULT_LATENCY_TARGETS.map((target) => target.url))
    if (!existingUrls.has(url)) {
      await patchCustomLatencyTargets([
        ...customLatencyTargets.filter((target) => target.url !== url),
        { name, url }
      ])
    }
    closeLatencyTargetForm()
  }, [
    closeLatencyTargetForm,
    customLatencyName,
    customLatencyTargets,
    customLatencyUrl,
    patchCustomLatencyTargets
  ])

  const openLatencyTargetForm = useCallback(() => {
    setIsAddingLatencyTarget(true)
  }, [])

  const updateCustomLatencyName = useCallback((value: string) => {
    setCustomLatencyName(value)
    setCustomLatencyNameError(false)
  }, [])

  const updateCustomLatencyUrl = useCallback((value: string) => {
    setCustomLatencyUrl(value)
    setCustomLatencyUrlError(false)
  }, [])

  const submitLatencyTargetOnEnter = useCallback(
    (event: React.KeyboardEvent<HTMLInputElement>) => {
      if (event.key !== 'Enter') return
      event.preventDefault()
      addCustomLatencyTarget()
    },
    [addCustomLatencyTarget]
  )

  const removeCustomLatencyTarget = useCallback(
    async (url: string) => {
      await patchCustomLatencyTargets(
        customLatencyTargets.filter((targetUrl) => targetUrl.url !== url)
      )
      setLatencyResults((prev) => {
        const next = { ...prev }
        delete next[url]
        return next
      })
    },
    [customLatencyTargets, patchCustomLatencyTargets]
  )

  const pendingRequests = useRef(new Map<string, Promise<void>>())
  const testTarget = useCallback((url: string): Promise<void> => {
    const pending = pendingRequests.current.get(url)
    if (pending) return pending
    setLatencyResults((previous) => ({ ...previous, [url]: { latency: null, status: 'pending' } }))
    const request = (async () => {
      try {
        const latency = await measureLatency(url)
        setLatencyResults((previous) => ({
          ...previous,
          [url]: { latency, status: latency !== null ? 'success' : 'error' }
        }))
      } catch {
        setLatencyResults((previous) => ({
          ...previous,
          [url]: { latency: null, status: 'error' }
        }))
      } finally {
        pendingRequests.current.delete(url)
      }
    })()
    pendingRequests.current.set(url, request)
    return request
  }, [])

  const testAllLatencies = useCallback(async () => {
    setTestingLatency(true)
    try {
      await Promise.all(latencyTargets.map((target) => testTarget(target.url)))
    } finally {
      setTestingLatency(false)
    }
  }, [latencyTargets, testTarget])

  const initialized = useRef(false)
  useEffect(() => {
    if (!appConfigLoaded || initialized.current) return
    initialized.current = true
    void testAllLatencies()
  }, [appConfigLoaded, testAllLatencies])

  const successes = latencyTargets
    .map((target) => latencyResults[target.url])
    .filter(
      (result): result is LatencyResult & { latency: number } =>
        result?.status === 'success' && result.latency !== null
    )
  const averageLatency = successes.length
    ? Math.round(successes.reduce((sum, result) => sum + result.latency, 0) / successes.length)
    : null

  return (
    <section className={cardClass} aria-label={t('network.latency.title')}>
      <div className="mb-3 flex items-center justify-between gap-2">
        <div className="flex min-w-0 items-center gap-2">
          <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-primary/15 text-primary">
            <IoMdPulse size={18} />
          </div>
          <h3 className="truncate text-[15px] font-semibold">{t('network.latency.title')}</h3>
        </div>
        <div className="flex shrink-0 items-center gap-1">
          <Tooltip content={t('network.latency.testAll')}>
            <Button
              size="sm"
              isIconOnly
              variant="light"
              isLoading={testingLatency}
              isDisabled={testingLatency}
              aria-label={t('network.latency.testAll')}
              onPress={testAllLatencies}
              className="h-7 w-7 min-w-0"
            >
              <IoRefresh size={16} />
            </Button>
          </Tooltip>
          <Tooltip content={t('network.latency.add')}>
            <Button
              size="sm"
              isIconOnly
              variant={isAddingLatencyTarget ? 'flat' : 'light'}
              className="h-7 w-7 min-w-0"
              aria-label={t('network.latency.add')}
              onPress={openLatencyTargetForm}
            >
              <IoAdd size={18} />
            </Button>
          </Tooltip>
        </div>
      </div>
      {isAddingLatencyTarget && (
        <div className="mb-3 flex flex-wrap items-start gap-2">
          <Input
            size="sm"
            className="min-w-32 flex-1"
            value={customLatencyName}
            placeholder={t('network.latency.namePlaceholder')}
            aria-label={t('network.latency.namePlaceholder')}
            isInvalid={customLatencyNameError}
            errorMessage={customLatencyNameError ? t('network.latency.invalidName') : undefined}
            onValueChange={updateCustomLatencyName}
            onKeyDown={submitLatencyTargetOnEnter}
          />
          <Input
            size="sm"
            className="min-w-48 flex-[1.5]"
            value={customLatencyUrl}
            placeholder={t('network.latency.urlPlaceholder')}
            aria-label={t('network.latency.urlPlaceholder')}
            isInvalid={customLatencyUrlError}
            errorMessage={customLatencyUrlError ? t('network.latency.invalidUrl') : undefined}
            onValueChange={updateCustomLatencyUrl}
            onKeyDown={submitLatencyTargetOnEnter}
          />
          <Tooltip content={t('common.save')}>
            <Button
              size="sm"
              isIconOnly
              variant="flat"
              color="primary"
              className="h-8 w-8 min-w-0"
              aria-label={t('common.save')}
              onPress={addCustomLatencyTarget}
            >
              <IoCheckmark size={16} />
            </Button>
          </Tooltip>
          <Tooltip content={t('common.cancel')}>
            <Button
              size="sm"
              isIconOnly
              variant="light"
              className="h-8 w-8 min-w-0"
              aria-label={t('common.cancel')}
              onPress={closeLatencyTargetForm}
            >
              <IoClose size={16} />
            </Button>
          </Tooltip>
        </div>
      )}

      <div className="grid max-h-52 grid-cols-[repeat(auto-fill,minmax(76px,1fr))] items-start gap-2 overflow-y-auto p-0.5 custom-scrollbar">
        {latencyTargets.map((target) => {
          const result = latencyResults[target.url]
          return (
            <div
              key={target.url}
              className="group relative min-w-0 rounded-lg border border-foreground/10 bg-default-50 p-2 transition-colors hover:border-primary/30"
            >
              {target.custom && (
                <Tooltip content={t('common.delete')}>
                  <button
                    type="button"
                    aria-label={`${t('common.delete')} ${target.name}`}
                    onClick={() => removeCustomLatencyTarget(target.url)}
                    className="absolute top-1 right-1 flex h-5 w-5 items-center justify-center rounded-full bg-content1 text-foreground/40 hover:bg-danger/10 hover:text-danger focus-visible:outline-2 focus-visible:outline-primary"
                  >
                    <IoClose size={13} />
                  </button>
                </Tooltip>
              )}
              <Tooltip content={target.url}>
                <div className="flex min-w-0 flex-col items-center gap-1 pt-0.5">
                  <span className="flex h-7 items-center justify-center">
                    <TargetLogo target={target} />
                  </span>
                  <span className="w-full truncate text-center text-xs font-medium">
                    {target.name}
                  </span>
                </div>
              </Tooltip>
              <div className="mt-1.5 border-t border-foreground/10 pt-1">
                <Button
                  size="sm"
                  variant="light"
                  isLoading={result?.status === 'pending'}
                  isDisabled={result?.status === 'pending'}
                  onPress={() => testTarget(target.url)}
                  aria-label={`${t('network.latency.test')} ${target.name}`}
                  className={`h-6 w-full min-w-0 px-0 font-mono text-xs ${result?.status === 'success' ? latencyColor(result.latency) : result?.status === 'error' ? 'text-danger' : 'text-primary'}`}
                >
                  {result?.status === 'success'
                    ? `${result.latency} ms`
                    : result?.status === 'error'
                      ? t('network.latency.timeout')
                      : result?.status === 'pending'
                        ? ''
                        : t('network.latency.test')}
                </Button>
              </div>
            </div>
          )
        })}
      </div>
      {averageLatency !== null && (
        <div className="mt-auto pt-2 text-right text-xs text-foreground/50">
          {t('network.latency.average')}:{' '}
          <span className={`font-mono ${latencyColor(averageLatency)}`}>{averageLatency} ms</span>
        </div>
      )}
    </section>
  )
}

const NetworkPage: React.FC = () => {
  const { t } = useTranslation()
  return (
    <BasePage title={t('network.title')}>
      <div className="@container m-2 flex flex-col gap-3">
        <div className="grid grid-cols-1 items-stretch gap-3 @min-[25rem]:grid-cols-2">
          <IPInfoCard />
          <LatencyCard />
        </div>
        <MediaUnlock />
        <NetworkTopologyCard />
      </div>
    </BasePage>
  )
}

export default NetworkPage
