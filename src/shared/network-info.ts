export type IPProvider = 'ip.sb' | 'ipwho.is' | 'ipapi.is' | 'geojs'

export type IPInfoSource = IPProvider | 'ipapi.co' | 'skk.moe' | 'Cloudflare'

export interface IPInfo {
  ip: string
  source: IPInfoSource
  country?: string
  countryCode?: string
  city?: string
  region?: string
  asn?: number
  org?: string
  isp?: string
  isProxy?: boolean
  isVPN?: boolean
  timezone?: string
  latitude?: number
  longitude?: number
}
