export const TIZI_DEFAULT_SERVER = 'https://tizi.fansionia.world'
export const TIZI_PROFILE_ID = 'tizi-managed'

export const tiziNativeActions = [
  'status',
  'register',
  'registration-status',
  'complete-registration',
  'reset-request',
  'reset-confirm',
  'login',
  'logout',
  'sync',
  'refresh',
  'usage'
] as const
export type TiziNativeAction = (typeof tiziNativeActions)[number]
export type TiziAction = TiziNativeAction | 'activate' | 'deactivate'
export interface TiziSubscription {
  upload: number
  download: number
  total: number
  expire: number
}
export interface TiziStatus {
  supported: boolean
  keyReady: boolean
  active: boolean
  logged_in: boolean
  email?: string
  device_id?: string
  server_url?: string
  subscription?: TiziSubscription
  subscription_updated_at?: number
  last_sync_at?: number
  pending_days?: number
  health?: string
}
export interface TiziDay {
  day: string
  upload_bytes: number
  download_bytes: number
}
export interface TiziUsage {
  email: string
  days: TiziDay[]
  cycles: {
    id: number
    name: string
    start_day: string
    end_day: string | null
    upload_bytes: number
    download_bytes: number
  }[]
  devices: {
    device_id: string
    name: string
    last_report_at: number | null
    sequence: number
    health: string
  }[]
}
export type TiziResult =
  | TiziStatus
  | TiziUsage
  | { request_id: string }
  | { status: 'pending' | 'approved' | 'registered' | 'rejected' }
  | { ok: true }
  | { sequence: number }
  | { device_id: string; email: string }
