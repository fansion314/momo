import { Button, Chip, Tooltip } from '@heroui/react'
import { useCallback, useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import {
  IoCheckmarkCircleOutline,
  IoCloseCircleOutline,
  IoHelpCircleOutline,
  IoHourglassOutline,
  IoLockOpenOutline,
  IoRefresh,
  IoTimeOutline
} from 'react-icons/io5'
import { checkMediaUnlockItem } from '@renderer/utils/ipc'
import {
  MediaUnlockQueue,
  readMediaUnlockResults,
  saveMediaUnlockResult
} from '@renderer/utils/media-unlock'
import { type MediaUnlockItem, type MediaUnlockName } from '../../../../shared/media-unlock'

const queue = new MediaUnlockQueue(async (name) => {
  let result: MediaUnlockItem
  try {
    result = await checkMediaUnlockItem(name)
  } catch {
    result = {
      name,
      status: 'Failed (Network Connection)',
      region: null,
      check_time: new Date().toLocaleString()
    }
  }
  saveMediaUnlockResult(result)
  return result
})

const statusKeys: Record<string, string> = {
  Pending: 'network.unlock.status.pending',
  Yes: 'network.unlock.status.yes',
  No: 'network.unlock.status.no',
  Failed: 'network.unlock.status.failed',
  Soon: 'network.unlock.status.soon',
  Risky: 'network.unlock.status.risky',
  Blocked: 'network.unlock.status.blocked',
  Completed: 'network.unlock.status.completed',
  'Disallowed ISP': 'network.unlock.status.disallowedIsp',
  'Originals Only': 'network.unlock.status.originalsOnly',
  'No (IP Banned By Disney+)': 'network.unlock.status.noDisney',
  'Unsupported Country/Region': 'network.unlock.status.unsupportedRegion',
  'Failed (Network Connection)': 'network.unlock.status.failedNetwork'
}

function statusAppearance(status: string): {
  color: 'default' | 'success' | 'danger' | 'warning' | 'primary'
  border: string
  icon: React.JSX.Element
} {
  if (status === 'Pending') {
    return {
      color: 'default',
      border: 'border-l-default-300',
      icon: <IoHourglassOutline className="text-sm" />
    }
  }
  if (status === 'Yes') {
    return {
      color: 'success',
      border: 'border-l-success',
      icon: <IoCheckmarkCircleOutline className="text-sm" />
    }
  }
  if (['Soon', 'Risky', 'Originals Only'].includes(status)) {
    return {
      color: 'warning',
      border: 'border-l-warning',
      icon: <IoTimeOutline className="text-sm" />
    }
  }
  if (status === 'Completed') {
    return {
      color: 'primary',
      border: 'border-l-primary',
      icon: <IoCheckmarkCircleOutline className="text-sm" />
    }
  }
  if (
    status.startsWith('No') ||
    status.includes('Failed') ||
    ['Disallowed ISP', 'Blocked', 'Unsupported Country/Region'].includes(status)
  ) {
    return {
      color: 'danger',
      border: 'border-l-danger',
      icon: <IoCloseCircleOutline className="text-sm" />
    }
  }
  return {
    color: 'default',
    border: 'border-l-default-300',
    icon: <IoHelpCircleOutline className="text-sm" />
  }
}

export default function MediaUnlock(): React.JSX.Element {
  const { t } = useTranslation()
  const [items, setItems] = useState<MediaUnlockItem[]>(() => readMediaUnlockResults())
  const [loading, setLoading] = useState<Set<MediaUnlockName>>(() => new Set())
  const [checkingAll, setCheckingAll] = useState(false)
  const mounted = useRef(true)
  const inFlight = useRef(new Map<MediaUnlockName, Promise<void>>())
  const allInFlight = useRef(false)

  const checkItem = useCallback((name: MediaUnlockName): Promise<void> => {
    const existing = inFlight.current.get(name)
    if (existing) return existing
    setLoading((current) => new Set(current).add(name))
    const task = queue
      .check(name)
      .then((result) => {
        if (!mounted.current) return
        setItems((current) => current.map((item) => (item.name === name ? result : item)))
      })
      .finally(() => {
        inFlight.current.delete(name)
        if (!mounted.current) return
        setLoading((current) => {
          const next = new Set(current)
          next.delete(name)
          return next
        })
      })
    inFlight.current.set(name, task)
    return task
  }, [])

  useEffect(() => {
    mounted.current = true
    // Reattach to checks still running after navigating away and back.
    for (const name of queue.pendingNames()) void checkItem(name)
    return () => {
      mounted.current = false
    }
  }, [checkItem])

  const checkAll = async (): Promise<void> => {
    if (allInFlight.current || inFlight.current.size > 0) return
    allInFlight.current = true
    setCheckingAll(true)
    try {
      await Promise.all(items.map((item) => checkItem(item.name)))
    } finally {
      allInFlight.current = false
      if (mounted.current) setCheckingAll(false)
    }
  }

  return (
    <section
      aria-label={t('network.unlock.title')}
      className="@container rounded-xl border border-foreground/10 bg-content1 p-3 shadow-sm"
    >
      <div className="mb-3 flex items-center justify-between gap-2">
        <div className="flex min-w-0 items-center gap-2">
          <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-primary/15 text-primary">
            <IoLockOpenOutline size={18} />
          </div>
          <h3 className="text-[15px] font-semibold">{t('network.unlock.title')}</h3>
        </div>
        <Button
          size="sm"
          color="primary"
          isDisabled={checkingAll || loading.size > 0}
          startContent={<IoRefresh className={checkingAll ? 'animate-spin' : ''} size={16} />}
          onPress={checkAll}
        >
          {t(checkingAll ? 'network.unlock.testing' : 'network.unlock.testAll')}
        </Button>
      </div>
      <div className="grid grid-cols-1 gap-2 @min-[29rem]:grid-cols-2 @min-[44rem]:grid-cols-3">
        {items.map((item) => {
          const pending = loading.has(item.name)
          const appearance = statusAppearance(item.status)
          return (
            <article
              key={item.name}
              aria-label={item.name}
              aria-busy={pending}
              className={`flex min-w-0 flex-col overflow-hidden rounded-lg border border-foreground/10 border-l-4 bg-default-50 transition-colors hover:bg-default-100 ${appearance.border}`}
            >
              <div className="flex flex-1 flex-col gap-1.5 px-2.5 py-2">
                <div className="flex items-center justify-between gap-2">
                  <h4 className="min-w-0 text-sm font-semibold wrap-break-word">{item.name}</h4>
                  <Tooltip content={t('network.unlock.testItem', { name: item.name })}>
                    <Button
                      size="sm"
                      isIconOnly
                      radius="full"
                      variant="bordered"
                      color="primary"
                      className="h-7 w-7 min-w-7 shrink-0 border"
                      aria-label={t('network.unlock.testItem', { name: item.name })}
                      isDisabled={pending || checkingAll}
                      onPress={() => checkItem(item.name)}
                    >
                      <IoRefresh size={16} className={pending ? 'animate-spin' : ''} />
                    </Button>
                  </Tooltip>
                </div>
                <div className="flex min-h-5 flex-wrap items-center gap-1.5" aria-live="polite">
                  <Chip
                    size="sm"
                    variant="solid"
                    color={appearance.color}
                    startContent={appearance.icon}
                    className="h-auto min-h-5 max-w-full py-0.5"
                    classNames={{
                      content: `text-xs whitespace-normal ${item.status === 'Pending' ? '' : 'font-semibold'}`
                    }}
                  >
                    {t(statusKeys[item.status] ?? item.status)}
                  </Chip>
                  {item.region && (
                    <Chip
                      size="sm"
                      variant="bordered"
                      color="primary"
                      className="h-5 border"
                      classNames={{ content: 'text-xs' }}
                    >
                      {item.region}
                    </Chip>
                  )}
                </div>
              </div>
              <div className="mx-2 border-t border-dashed border-default-200" />
              <div className="px-2.5 py-0.5 text-right text-[10px] text-default-500 tabular-nums">
                {item.check_time || '-- --'}
              </div>
            </article>
          )
        })}
      </div>
    </section>
  )
}
