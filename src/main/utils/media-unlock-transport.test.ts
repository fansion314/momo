import { EventEmitter } from 'events'
import { describe, expect, it, vi } from 'vitest'
import { mediaUnlockRequest } from './media-unlock-transport'

const mock = vi.hoisted(() => ({ request: vi.fn() }))
vi.mock('electron', () => ({ net: { request: mock.request } }))

class FakeRequest extends EventEmitter {
  headers: Record<string, string> = {}
  setHeader(name: string, value: string): void {
    this.headers[name] = value
  }
  write = vi.fn()
  end = vi.fn()
  followRedirect = vi.fn()
  abort(): void {
    this.emit('abort')
  }
}

describe('media unlock transport', () => {
  it('authenticates only the configured proxy and follows redirects with session cookies', async () => {
    const request = new FakeRequest()
    mock.request.mockReturnValue(request)
    const signal = new AbortController().signal
    const result = mediaUnlockRequest(
      {} as Electron.Session,
      7890,
      'user:p:a',
      'https://example.com',
      undefined,
      signal
    )
    expect(mock.request).toHaveBeenCalledWith(expect.objectContaining({ useSessionCookies: true }))
    expect(request.headers['user-agent']).toContain('Chrome/122.0.0.0')
    const callback = vi.fn()
    request.emit('login', { isProxy: false, host: 'example.com', port: 443 }, callback)
    expect(callback).toHaveBeenCalledWith()
    request.emit('login', { isProxy: true, host: '127.0.0.1', port: 7890 }, callback)
    expect(callback).toHaveBeenCalledWith('user', 'p:a')
    request.emit('redirect', 302, 'GET', 'https://example.com/final')
    expect(request.followRedirect).toHaveBeenCalledOnce()
    const incoming = Object.assign(new EventEmitter(), { statusCode: 200, headers: {} })
    request.emit('response', incoming)
    incoming.emit('data', Buffer.from('ok'))
    incoming.emit('end')
    const response = await result
    expect(response.url).toBe('https://example.com/final')
    expect(await response.text()).toBe('ok')
  })

  it('aborts the actual request on deadline', async () => {
    const request = new FakeRequest()
    mock.request.mockReturnValue(request)
    const controller = new AbortController()
    const result = mediaUnlockRequest(
      {} as Electron.Session,
      7890,
      undefined,
      'https://example.com',
      undefined,
      controller.signal
    )
    controller.abort()
    await expect(result).rejects.toThrow('aborted')
  })
})
