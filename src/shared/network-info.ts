export type IPProvider = 'ip.sb' | 'ipwho.is' | 'ipapi.is'

export interface IPInfo {
  ip: string
  source: IPProvider | 'Cloudflare'
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
