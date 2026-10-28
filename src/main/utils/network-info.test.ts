import { beforeEach, describe, expect, it, vi } from 'vitest'
import { fetchIPInfo } from './network-info'
import { get } from './chromeRequest'

vi.mock('./chromeRequest', () => ({ get: vi.fn() }))

function response(data: string, status = 200) {
  return {
    data,
    status,
    statusText: status === 200 ? 'OK' : 'Too Many Requests',
    headers: {},
    url: ''
  }
}

const trace = 'fl=123\nip=2001:db8::1\nloc=HK\ntls=TLSv1.3\n'

beforeEach(() => vi.resetAllMocks())

describe('fetchIPInfo', () => {
  it('normalizes IP.SB fields and supplies an application User-Agent', async () => {
    vi.mocked(get).mockResolvedValueOnce(
      response(JSON.stringify({ ip: '203.0.113.1', country_code: 'HK', asn: 123, latitude: 1 }))
    )
    expect(await fetchIPInfo('ip.sb')).toMatchObject({
      ip: '203.0.113.1',
      source: 'ip.sb',
      countryCode: 'HK',
      asn: 123,
      latitude: 1
    })
    expect(get).toHaveBeenCalledExactlyOnceWith('https://api.ip.sb/geoip', {
      timeout: 5000,
      responseType: 'text',
      headers: { 'User-Agent': 'Clash-Momo', Accept: 'application/json, text/plain' }
    })
  })

  it('normalizes ipwho.is nested fields', async () => {
    vi.mocked(get).mockResolvedValueOnce(
      response(
        JSON.stringify({
          ip: '203.0.113.2',
          success: true,
          connection: { asn: 456, org: 'Example', isp: 'ISP' },
          timezone: { id: 'Asia/Hong_Kong' }
        })
      )
    )
    expect(await fetchIPInfo('ipwho.is')).toMatchObject({
      ip: '203.0.113.2',
      source: 'ipwho.is',
      asn: 456,
      org: 'Example',
      isp: 'ISP',
      timezone: 'Asia/Hong_Kong'
    })
  })

  it('normalizes ipapi.is fields without trusting malformed optional values', async () => {
    vi.mocked(get).mockResolvedValueOnce(
      response(
        JSON.stringify({
          ip: '203.0.113.3',
          location: { country_code: 'HK', latitude: '1', longitude: 2 },
          asn: { asn: 789 },
          is_vpn: false,
          is_proxy: 'false'
        })
      )
    )
    expect(await fetchIPInfo('ipapi.is')).toMatchObject({
      ip: '203.0.113.3',
      source: 'ipapi.is',
      countryCode: 'HK',
      asn: 789,
      isVPN: false,
      isProxy: undefined,
      latitude: undefined,
      longitude: 2
    })
  })

  it('normalizes GeoJS fields and numeric strings', async () => {
    vi.mocked(get).mockResolvedValueOnce(
      response(
        JSON.stringify({
          ip: '203.0.113.4',
          country_code: 'HK',
          country: 'Hong Kong',
          city: 'Hong Kong',
          region: 'Hong Kong',
          asn: 789,
          organization_name: 'Example Network',
          timezone: 'Asia/Hong_Kong',
          latitude: '22.2842',
          longitude: '114.1759'
        })
      )
    )
    expect(await fetchIPInfo('geojs')).toMatchObject({
      ip: '203.0.113.4',
      source: 'geojs',
      countryCode: 'HK',
      asn: 789,
      org: 'Example Network',
      isp: 'Example Network',
      latitude: 22.2842,
      longitude: 114.1759
    })
  })

  it.each([
    ['TLS reset', new Error('net::ERR_CONNECTION_CLOSED')],
    ['non-JSON response', response('<html>Blocked</html>')],
    ['HTTP failure with valid JSON', response('{"ip":"203.0.113.1"}', 429)],
    ['ipwho.is API error', response('{"success":false,"message":"Rate limit exceeded"}')],
    ['ipapi.is API error', response('{"error":"Quota exceeded"}')],
    ['invalid IP', response('{"ip":"not-an-ip"}')],
    ['missing IP', response('{}')]
  ])('falls back to another full-info service on %s', async (_name, primary) => {
    vi.mocked(get).mockImplementation(async (url) => {
      if (url === 'https://ipwho.is/') {
        if (primary instanceof Error) throw primary
        return primary
      }
      if (url === 'https://get.geojs.io/v1/ip/geo.json') {
        return response(
          JSON.stringify({
            ip: '203.0.113.5',
            country_code: 'HK',
            country: 'Hong Kong',
            asn: 41378,
            organization_name: 'Example Network'
          })
        )
      }
      throw new Error(`Unexpected endpoint: ${url}`)
    })
    expect(await fetchIPInfo('ipwho.is')).toMatchObject({
      ip: '203.0.113.5',
      countryCode: 'HK',
      source: 'geojs',
      asn: 41378
    })
    expect(
      vi.mocked(get).mock.calls.some(([url]) => url === 'https://get.geojs.io/v1/ip/geo.json')
    ).toBe(true)
    expect(vi.mocked(get).mock.calls.some(([url]) => url.includes('cdn-cgi/trace'))).toBe(false)
  })

  it('uses Cloudflare only after every full-info service fails', async () => {
    vi.mocked(get).mockImplementation(async (url) => {
      if (url.includes('cdn-cgi/trace')) return response(trace)
      throw new Error(`Unavailable endpoint: ${url}`)
    })
    expect(await fetchIPInfo('ip.sb')).toEqual({
      ip: '2001:db8::1',
      countryCode: 'HK',
      source: 'Cloudflare'
    })
    expect(vi.mocked(get).mock.calls.at(-1)?.[0]).toBe('https://www.cloudflare.com/cdn-cgi/trace')
  })

  it('preserves provider and Cloudflare errors when every fallback fails', async () => {
    vi.mocked(get).mockImplementation(async (url) => {
      if (url.includes('cdn-cgi/trace')) return response('ip=invalid\nloc=HK')
      if (url === 'https://api.ip.sb/geoip') throw new Error('net::ERR_CONNECTION_CLOSED')
      throw new Error(`Unavailable endpoint: ${url}`)
    })
    const error = await fetchIPInfo('ip.sb').catch((reason: unknown) => reason)
    expect(error).toBeInstanceOf(Error)
    expect((error as Error).message).toContain('ip.sb: net::ERR_CONNECTION_CLOSED')
    expect((error as Error).message).toContain(
      'Cloudflare: Cloudflare returned no valid IP address'
    )
  })

  it('rejects arbitrary IPC destinations', async () => {
    // @ts-expect-error IPC arguments are untrusted at runtime.
    await expect(fetchIPInfo('https://example.com')).rejects.toThrow('Unsupported IP provider')
    expect(get).not.toHaveBeenCalled()
  })
})
