export const MEDIA_UNLOCK_NAMES = [
  '哔哩哔哩大陆',
  '哔哩哔哩港澳台',
  'ChatGPT Web',
  'Claude',
  'Gemini',
  'Muse AI',
  'YouTube Premium',
  'Bahamut Anime',
  'Netflix',
  'Disney+',
  'Prime Video',
  'Spotify',
  'TikTok'
] as const

export type MediaUnlockName = (typeof MEDIA_UNLOCK_NAMES)[number]

export interface MediaUnlockItem {
  name: MediaUnlockName
  status: string
  region: string | null
  check_time: string | null
}
