import { isIP } from 'node:net'
import type { IPInfo, IPInfoSource, IPProvider } from '../../shared/network-info'
import { get } from './chromeRequest'

type FullInfoSource = Exclude<IPInfoSource, 'Cloudflare'>

const IP_ENDPOINTS: Record<FullInfoSource, string> = {
  'ip.sb': 'https://api.ip.sb/geoip',
  'ipwho.is': 'https://ipwho.is/',
  'ipapi.is': 'https://api.ipapi.is/',
  'ipapi.co': 'https://ipapi.co/json',
  'skk.moe': 'https://ip.api.skk.moe/cf-geoip',
  geojs: 'https://get.geojs.io/v1/ip/geo.json'
}
const TRACE_ENDPOINT = 'https://www.cloudflare.com/cdn-cgi/trace'
const FALLBACK_SOURCES: FullInfoSource[] = [
  'geojs',
  'ipapi.is',
  'ipwho.is',
  'ip.sb',
  'ipapi.co',
  'skk.moe'
]
const REQUEST_TIMEOUT = 5000

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

function numeric(value: unknown): number | undefined {
  if (typeof value === 'number') return number(value)
  if (typeof value !== 'string' || !value.trim()) return undefined
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : undefined
}

function asn(value: unknown): number | undefined {
  return typeof value === 'string' ? numeric(value.replace(/^AS/i, '')) : numeric(value)
}

function bool(value: unknown): boolean | undefined {
  return typeof value === 'boolean' ? value : undefined
}

function parseFullInfo(source: FullInfoSource, value: unknown): IPInfo {
  const data = record(value)
  if (data.success === false || data.error) {
    throw new Error(text(data.message) ?? text(data.error) ?? 'IP service rejected the request')
  }
  const ip = text(data.ip)
  if (!ip || !isIP(ip)) throw new Error('IP service returned no valid IP address')

  if (source === 'ip.sb') {
    return {
      ip,
      source,
      country: text(data.country),
      countryCode: text(data.country_code),
      city: text(data.city),
      region: text(data.region),
      asn: number(data.asn),
      org: text(data.organization) ?? text(data.asn_organization),
      isp: text(data.isp),
      timezone: text(data.timezone),
      latitude: number(data.latitude),
      longitude: number(data.longitude)
    }
  }

  if (source === 'ipwho.is') {
    const connection = record(data.connection)
    return {
      ip,
      source,
      country: text(data.country),
      countryCode: text(data.country_code),
      city: text(data.city),
      region: text(data.region),
      asn: number(connection.asn),
      org: text(connection.org),
      isp: text(connection.isp),
      timezone: text(record(data.timezone).id),
      latitude: number(data.latitude),
      longitude: number(data.longitude)
    }
  }

  if (source === 'ipapi.is') {
    const location = record(data.location)
    const connection = record(data.asn)
    return {
      ip,
      source,
      country: text(location.country),
      countryCode: text(location.country_code),
      city: text(location.city),
      region: text(location.state),
      asn: number(connection.asn),
      org: text(connection.org),
      isp: text(data.isp),
      isProxy: bool(data.is_proxy),
      isVPN: bool(data.is_vpn),
      timezone: text(location.timezone),
      latitude: number(location.latitude),
      longitude: number(location.longitude)
    }
  }

  if (source === 'ipapi.co') {
    return {
      ip,
      source,
      country: text(data.country_name),
      countryCode: text(data.country_code),
      city: text(data.city),
      region: text(data.region),
      asn: asn(data.asn),
      org: text(data.org),
      isp: text(data.org),
      timezone: text(data.timezone),
      latitude: number(data.latitude),
      longitude: number(data.longitude)
    }
  }

  if (source === 'skk.moe') {
    const countryCode = text(data.country)
    return {
      ip,
      source,
      country: countryCode,
      countryCode,
      city: text(data.city),
      region: text(data.region),
      asn: number(data.asn),
      org: text(data.asOrg),
      isp: text(data.asOrg),
      timezone: text(data.timezone),
      latitude: number(data.latitude),
      longitude: number(data.longitude)
    }
  }

  const organization = text(data.organization_name) ?? text(data.organization)
  return {
    ip,
    source,
    country: text(data.country),
    countryCode: text(data.country_code),
    city: text(data.city),
    region: text(data.region),
    asn: asn(data.asn),
    org: organization,
    isp: organization,
    timezone: text(data.timezone),
    latitude: numeric(data.latitude),
    longitude: numeric(data.longitude)
  }
}

async function fetchText(url: string): Promise<string> {
  // Keep the same system/TUN route for both lookups; changing routes can report a different IP.
  const response = await get<string>(url, {
    timeout: REQUEST_TIMEOUT,
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

async function fetchFullInfo(source: FullInfoSource): Promise<IPInfo> {
  return parseFullInfo(source, JSON.parse(await fetchText(IP_ENDPOINTS[source])))
}

export async function fetchIPInfo(provider: IPProvider): Promise<IPInfo> {
  if (!Object.hasOwn(IP_ENDPOINTS, provider)) throw new Error('Unsupported IP provider')

  const errors = [`${provider}: failed`]
  try {
    return await fetchFullInfo(provider)
  } catch (providerError) {
    errors[0] = `${provider}: ${errorMessage(providerError)}`
  }

  const alternatives = FALLBACK_SOURCES.filter((source) => source !== provider)
  try {
    return await Promise.any(
      alternatives.map(async (source) => {
        try {
          return await fetchFullInfo(source)
        } catch (error) {
          throw new Error(`${source}: ${errorMessage(error)}`)
        }
      })
    )
  } catch (fallbackError) {
    if (fallbackError instanceof AggregateError) {
      errors.push(...fallbackError.errors.map(errorMessage))
    } else {
      errors.push(errorMessage(fallbackError))
    }
  }

  // Cloudflare is the final fallback because it only provides IP and country.
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
  } catch (cloudflareError) {
    errors.push(`Cloudflare: ${errorMessage(cloudflareError)}`)
    throw new Error(errors.join('; '))
  }
}
