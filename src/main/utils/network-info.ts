import { isIP } from 'node:net'
import type { IPInfo, IPProvider } from '../../shared/network-info'
import { get } from './chromeRequest'

const IP_ENDPOINTS: Record<IPProvider, string> = {
  'ip.sb': 'https://api.ip.sb/geoip',
  'ipwho.is': 'https://ipwho.is/',
  'ipapi.is': 'https://api.ipapi.is/'
}
const TRACE_ENDPOINT = 'https://www.cloudflare.com/cdn-cgi/trace'

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {}
}

function text(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined
}

function number(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

function bool(value: unknown): boolean | undefined {
  return typeof value === 'boolean' ? value : undefined
}

function parseProvider(provider: IPProvider, value: unknown): IPInfo {
  const data = record(value)
  if (data.success === false || data.error) {
    throw new Error(text(data.message) ?? text(data.error) ?? 'IP service rejected the request')
  }
  const ip = text(data.ip)
  if (!ip || !isIP(ip)) throw new Error('IP service returned no valid IP address')
  const location = provider === 'ipapi.is' ? record(data.location) : data
  const connection = provider === 'ipwho.is' ? record(data.connection) : record(data.asn)
  return {
    ip,
    source: provider,
    country: text(location.country),
    countryCode: text(location.country_code),
    city: text(location.city),
    region: text(provider === 'ipapi.is' ? location.state : location.region),
    asn: number(provider === 'ip.sb' ? data.asn : connection.asn),
    org: text(provider === 'ip.sb' ? data.asn_organization : connection.org),
    isp: text(provider === 'ipwho.is' ? connection.isp : data.isp),
    isProxy: bool(data.is_proxy),
    isVPN: bool(data.is_vpn),
    timezone: text(provider === 'ipwho.is' ? record(data.timezone).id : location.timezone),
    latitude: number(location.latitude),
    longitude: number(location.longitude)
  }
}

async function fetchText(url: string): Promise<string> {
  // Keep the same system/TUN route for both lookups; changing routes can report a different IP.
  const response = await get<string>(url, {
    timeout: 8000,
    responseType: 'text',
    headers: { 'User-Agent': 'Clash-Momo', Accept: 'application/json, text/plain' }
  })
  if (response.status < 200 || response.status >= 300) {
    throw new Error(`HTTP ${response.status} ${response.statusText}`.trim())
  }
  return response.data
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

export async function fetchIPInfo(provider: IPProvider): Promise<IPInfo> {
  if (!Object.hasOwn(IP_ENDPOINTS, provider)) throw new Error('Unsupported IP provider')
  try {
    return parseProvider(provider, JSON.parse(await fetchText(IP_ENDPOINTS[provider])))
  } catch (providerError) {
    // Some proxy exits reset connections to geolocation APIs. Cloudflare's trace still
    // reports the observed public IP and country, without inventing unavailable city/ASN data.
    try {
      const trace = Object.fromEntries(
        (await fetchText(TRACE_ENDPOINT)).split(/\r?\n/).map((line) => {
          const separator = line.indexOf('=')
          return [line.slice(0, separator), line.slice(separator + 1)]
        })
      )
      if (!isIP(trace.ip ?? '')) throw new Error('Cloudflare returned no valid IP address')
      const countryCode = /^[A-Z]{2}$/.test(trace.loc ?? '') ? trace.loc : undefined
      return { ip: trace.ip, countryCode, source: 'Cloudflare' }
    } catch (fallbackError) {
      throw new Error(
        `${provider}: ${errorMessage(providerError)}; Cloudflare: ${errorMessage(fallbackError)}`
      )
    }
  }
}
