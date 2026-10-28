import { afterEach, describe, expect, it, vi } from 'vitest'
import { checkMediaUnlockItem, defaultMediaUnlockItems, runMediaUnlockCheck } from './media-unlock'

const mocks = vi.hoisted(() => ({
  fetch: vi.fn(),
  clearStorageData: vi.fn(async () => {}),
  closeAllConnections: vi.fn(async () => {}),
  clearAuthCache: vi.fn(async () => {}),
  setProxy: vi.fn(async () => {}),
  fromPartition: vi.fn(),
  getRuntimeConfig: vi.fn(async () => ({ 'mixed-port': 7890, port: 7891 }))
}))
vi.mock('electron', () => ({ session: { fromPartition: mocks.fromPartition } }))
vi.mock('../core/factory', () => ({ getRuntimeConfig: mocks.getRuntimeConfig }))
vi.mock('./media-unlock-transport', () => ({ mediaUnlockRequest: mocks.fetch }))

function response(body: string, status = 200, url = 'https://example.com/'): Response {
  const result = new Response(body, { status })
  Object.defineProperty(result, 'url', { value: url })
  return result
}

afterEach(() => {
  vi.useRealTimers()
  vi.clearAllMocks()
})

describe('media unlock probes', () => {
  it('offers only the 13 known services and rejects unknown names', async () => {
    expect(defaultMediaUnlockItems()).toHaveLength(13)
    await expect(checkMediaUnlockItem('https://arbitrary.example')).rejects.toThrow('未知')
    expect(mocks.fromPartition).not.toHaveBeenCalled()
  })

  it('classifies traces, blocked content and anti-bot results', async () => {
    expect(await runMediaUnlockCheck('Claude', async () => response('loc=HK\n'))).toEqual({
      status: 'No',
      region: '🇭🇰HK'
    })
    expect(await runMediaUnlockCheck('Gemini', async () => response(',2,1,200,"USA"'))).toEqual({
      status: 'Yes',
      region: '🇺🇸USA'
    })
    expect(
      await runMediaUnlockCheck('哔哩哔哩大陆', async () => response('{"code":-10403}'))
    ).toEqual({ status: 'No' })
    expect(
      await runMediaUnlockCheck('Muse AI', async (url) =>
        url.includes('trace')
          ? response('loc=US')
          : response('gateway', 200, 'https://auth.muse.ai/')
      )
    ).toEqual({ status: 'Risky', region: '🇺🇸US' })
  })

  it('performs Disney device, form token, and GraphQL requests in order', async () => {
    const calls: { url: string; init?: RequestInit }[] = []
    const result = await runMediaUnlockCheck('Disney+', async (url, init) => {
      calls.push({ url, init })
      if (url.endsWith('/devices')) return response('{"assertion":"device"}')
      if (url.endsWith('/token')) return response('{"refresh_token":"token"}')
      if (url.includes('graphql'))
        return response('{"data":{"countryCode":"US","inSupportedLocation":true}}')
      return response('', 200, 'https://www.disneyplus.com/')
    })
    expect(result).toEqual({ status: 'Yes', region: '🇺🇸US' })
    expect(calls.map((call) => call.init?.method ?? 'GET')).toEqual(['POST', 'POST', 'GET', 'POST'])
    expect(calls[1].init?.body).toContain('subject_token=device')
  })

  it('uses a fresh service session through the configured proxy', async () => {
    mocks.fromPartition.mockReturnValue({
      fetch: mocks.fetch,
      clearStorageData: mocks.clearStorageData,
      closeAllConnections: mocks.closeAllConnections,
      clearAuthCache: mocks.clearAuthCache,
      setProxy: mocks.setProxy
    })
    mocks.fetch.mockResolvedValue(response('loc=US'))
    const result = await checkMediaUnlockItem('Claude')
    expect(result).toMatchObject({ name: 'Claude', status: 'Yes', region: '🇺🇸US' })
    expect(mocks.setProxy).toHaveBeenCalledWith({
      mode: 'fixed_servers',
      proxyRules: 'http=127.0.0.1:7890;https=127.0.0.1:7890',
      proxyBypassRules: '<-loopback>'
    })
    expect(mocks.clearStorageData).toHaveBeenCalledOnce()
    expect(mocks.fetch.mock.calls[0][5]).toBeInstanceOf(AbortSignal)
  })

  it('uses the HTTP port and configured credentials when the mixed port is disabled', async () => {
    mocks.getRuntimeConfig.mockResolvedValueOnce({
      'mixed-port': 0,
      port: 7891,
      authentication: ['u:p:a']
    } as never)
    mocks.fromPartition.mockReturnValue({
      clearStorageData: mocks.clearStorageData,
      closeAllConnections: mocks.closeAllConnections,
      clearAuthCache: mocks.clearAuthCache,
      setProxy: mocks.setProxy
    })
    mocks.fetch.mockResolvedValue(response('loc=US'))
    await checkMediaUnlockItem('Claude')
    expect(mocks.fetch.mock.calls[0][1]).toBe(7891)
    expect(mocks.fetch.mock.calls[0][2]).toBe('u:p:a')
  })

  it('aborts a running request at the total deadline', async () => {
    vi.useFakeTimers()
    mocks.fromPartition.mockReturnValue({
      fetch: mocks.fetch,
      clearStorageData: mocks.clearStorageData,
      closeAllConnections: mocks.closeAllConnections,
      clearAuthCache: mocks.clearAuthCache,
      setProxy: mocks.setProxy
    })
    let signal: AbortSignal | undefined
    mocks.fetch.mockImplementation((_session, _port, _credential, _url, _init, requestSignal) => {
      signal = requestSignal
      return new Promise(() => {})
    })
    const result = checkMediaUnlockItem('Claude')
    await vi.advanceTimersByTimeAsync(15_000)
    expect((await result).status).toBe('Failed')
    expect(signal?.aborted).toBe(true)
  })
})
