import {
  MEDIA_UNLOCK_NAMES,
  type MediaUnlockItem,
  type MediaUnlockName
} from '../../../shared/media-unlock'

export const MEDIA_UNLOCK_STORAGE_KEY = 'clash-momo-media-unlock-results-v1'
type ResultStorage = Pick<Storage, 'getItem' | 'setItem'>

const normalizeName = (name: string): string => name.trim().toLowerCase()

export function readMediaUnlockResults(storage?: ResultStorage): MediaUnlockItem[] {
  let stored: unknown
  try {
    stored = JSON.parse(
      (storage ?? globalThis.localStorage).getItem(MEDIA_UNLOCK_STORAGE_KEY) ?? '[]'
    )
  } catch {
    stored = []
  }
  const results = new Map<string, MediaUnlockItem>()
  if (Array.isArray(stored)) {
    for (const value of stored) {
      if (
        !value ||
        typeof value !== 'object' ||
        typeof value.name !== 'string' ||
        typeof value.status !== 'string' ||
        !value.status.trim() ||
        (value.region !== null && typeof value.region !== 'string') ||
        (value.check_time !== null && typeof value.check_time !== 'string')
      ) {
        continue
      }
      const key = normalizeName(value.name)
      const previous = results.get(key)
      // A duplicate pending placeholder must not replace a completed cached result.
      if (value.status !== 'Pending' || !previous || previous.status === 'Pending') {
        results.set(key, value)
      }
    }
  }
  return MEDIA_UNLOCK_NAMES.map((name) => ({
    ...(results.get(normalizeName(name)) ?? {
      status: 'Pending',
      region: null,
      check_time: null
    }),
    name
  })).sort((a, b) => a.name.localeCompare(b.name, 'zh-CN'))
}

export function saveMediaUnlockResult(result: MediaUnlockItem, storage?: ResultStorage): void {
  try {
    const target = storage ?? globalThis.localStorage
    const items = readMediaUnlockResults(target).map((item) =>
      item.name === result.name ? result : item
    )
    target.setItem(MEDIA_UNLOCK_STORAGE_KEY, JSON.stringify(items))
  } catch {
    // Full or unavailable storage must not discard the visible detection result.
  }
}

interface QueuedCheck {
  name: MediaUnlockName
  resolve: (value: MediaUnlockItem) => void
  reject: (reason: unknown) => void
}

/** Share a bounded queue between individual and batch checks, including page remounts. */
export class MediaUnlockQueue {
  private pending = new Map<MediaUnlockName, Promise<MediaUnlockItem>>()
  private waiting: QueuedCheck[] = []
  private active = 0

  constructor(
    private request: (name: MediaUnlockName) => Promise<MediaUnlockItem>,
    private concurrency = 4
  ) {
    if (!Number.isInteger(concurrency) || concurrency < 1) {
      throw new Error('Media unlock concurrency must be a positive integer')
    }
  }

  check(name: MediaUnlockName): Promise<MediaUnlockItem> {
    const existing = this.pending.get(name)
    if (existing) return existing
    const promise = new Promise<MediaUnlockItem>((resolve, reject) => {
      this.waiting.push({ name, resolve, reject })
    })
    this.pending.set(name, promise)
    this.pump()
    return promise
  }

  pendingNames(): MediaUnlockName[] {
    return [...this.pending.keys()]
  }

  private pump(): void {
    while (this.active < this.concurrency && this.waiting.length > 0) {
      const task = this.waiting.shift()
      if (!task) return
      this.active++
      void Promise.resolve()
        .then(() => this.request(task.name))
        .then(
          (result) => task.resolve({ ...result, name: task.name }),
          (error: unknown) => task.reject(error)
        )
        .finally(() => {
          this.pending.delete(task.name)
          this.active--
          this.pump()
        })
    }
  }
}
