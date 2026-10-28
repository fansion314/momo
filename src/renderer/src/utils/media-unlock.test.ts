import { describe, expect, it, vi } from 'vitest'
import {
  MEDIA_UNLOCK_NAMES,
  type MediaUnlockItem,
  type MediaUnlockName
} from '../../../shared/media-unlock'
import {
  MEDIA_UNLOCK_STORAGE_KEY,
  MediaUnlockQueue,
  readMediaUnlockResults,
  saveMediaUnlockResult
} from './media-unlock'

const result = (name: MediaUnlockName): MediaUnlockItem => ({
  name,
  status: 'Yes',
  region: 'US',
  check_time: '2026-10-28 10:00:00'
})

function storage(initial = '[]'): Pick<Storage, 'getItem' | 'setItem'> {
  let value = initial
  return {
    getItem: vi.fn(() => value),
    setItem: vi.fn((_key: string, next: string) => {
      value = next
    })
  }
}

const flush = async (): Promise<void> => {
  for (let i = 0; i < 12; i++) await Promise.resolve()
}

describe('media unlock cache', () => {
  it('restores only known, valid results and keeps completed results over duplicate placeholders', () => {
    const name = MEDIA_UNLOCK_NAMES[2]
    const cached = storage(
      JSON.stringify([
        { ...result(name), name: ` ${name.toUpperCase()} ` },
        { name, status: 'Pending', region: null, check_time: null },
        { name: 'unknown service', status: 'Yes', region: null, check_time: null },
        { name: MEDIA_UNLOCK_NAMES[1], status: 123, region: null, check_time: null },
        null
      ])
    )
    const restored = readMediaUnlockResults(cached)
    expect(restored).toHaveLength(MEDIA_UNLOCK_NAMES.length)
    expect(restored.find((item) => item.name === name)).toEqual(result(name))
    expect(restored.filter((item) => item.status === 'Pending')).toHaveLength(
      MEDIA_UNLOCK_NAMES.length - 1
    )
    expect(restored.map((item) => item.name)).toEqual(
      [...MEDIA_UNLOCK_NAMES].sort((a, b) => a.localeCompare(b, 'zh-CN'))
    )
  })

  it('persists each completed item without discarding other previously completed items', () => {
    const cached = storage()
    saveMediaUnlockResult(result(MEDIA_UNLOCK_NAMES[0]), cached)
    saveMediaUnlockResult(result(MEDIA_UNLOCK_NAMES[1]), cached)
    expect(cached.setItem).toHaveBeenLastCalledWith(MEDIA_UNLOCK_STORAGE_KEY, expect.any(String))
    expect(readMediaUnlockResults(cached).filter((item) => item.status === 'Yes')).toEqual(
      [result(MEDIA_UNLOCK_NAMES[0]), result(MEDIA_UNLOCK_NAMES[1])].sort((a, b) =>
        a.name.localeCompare(b.name, 'zh-CN')
      )
    )
  })

  it('recovers from corrupt or unavailable storage and tolerates a full cache', () => {
    expect(
      readMediaUnlockResults(storage('{invalid')).every((item) => item.status === 'Pending')
    ).toBe(true)
    const unavailable = {
      getItem: vi.fn(() => {
        throw new Error('storage unavailable')
      }),
      setItem: vi.fn(() => {
        throw new Error('quota exceeded')
      })
    }
    expect(readMediaUnlockResults(unavailable)).toHaveLength(MEDIA_UNLOCK_NAMES.length)
    expect(() => saveMediaUnlockResult(result(MEDIA_UNLOCK_NAMES[0]), unavailable)).not.toThrow()
  })
})

describe('media unlock request scheduling', () => {
  it('shares duplicate requests and starts at most four checks, updating progressively', async () => {
    const finish = new Map<MediaUnlockName, (value: MediaUnlockItem) => void>()
    let active = 0
    let maximum = 0
    const request = vi.fn((name: MediaUnlockName) => {
      active++
      maximum = Math.max(maximum, active)
      return new Promise<MediaUnlockItem>((resolve) => finish.set(name, resolve)).finally(() => {
        active--
      })
    })
    const queue = new MediaUnlockQueue(request)
    const names = MEDIA_UNLOCK_NAMES.slice(0, 6)
    const complete = (name: MediaUnlockName): void => {
      const resolve = finish.get(name)
      if (!resolve) throw new Error(`Check has not started: ${name}`)
      resolve(result(name))
    }
    const checks = names.map((name) => queue.check(name))
    expect(queue.check(names[0])).toBe(checks[0])
    expect(queue.pendingNames()).toEqual(names)
    await flush()
    expect(request.mock.calls.map(([name]) => name)).toEqual(names.slice(0, 4))

    const progress: MediaUnlockItem[] = []
    for (const check of checks) void check.then((item) => progress.push(item))
    complete(names[2])
    await flush()
    expect(progress).toEqual([result(names[2])])
    expect(request).toHaveBeenCalledTimes(5)
    complete(names[0])
    await flush()
    expect(request).toHaveBeenCalledTimes(6)
    for (const name of names.filter((name) => ![names[0], names[2]].includes(name))) {
      complete(name)
    }
    await Promise.all(checks)
    await flush()
    expect(maximum).toBe(4)
    expect(queue.pendingNames()).toEqual([])
    expect(progress).toHaveLength(6)
  })

  it('continues after a string rejection and permits retrying the same service', async () => {
    const request = vi
      .fn<(name: MediaUnlockName) => Promise<MediaUnlockItem>>()
      .mockRejectedValueOnce('IPC network failure')
      .mockImplementation(async (name) => result(name))
    const queue = new MediaUnlockQueue(request, 1)
    const first = queue.check(MEDIA_UNLOCK_NAMES[0])
    const second = queue.check(MEDIA_UNLOCK_NAMES[1])
    await expect(first).rejects.toBe('IPC network failure')
    await expect(second).resolves.toEqual(result(MEDIA_UNLOCK_NAMES[1]))
    await flush()
    await expect(queue.check(MEDIA_UNLOCK_NAMES[0])).resolves.toEqual(result(MEDIA_UNLOCK_NAMES[0]))
    expect(request).toHaveBeenCalledTimes(3)
  })
})
