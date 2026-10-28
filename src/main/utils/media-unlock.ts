import { session } from 'electron'
import { getRuntimeConfig } from '../core/factory'
import {
  MEDIA_UNLOCK_NAMES,
  type MediaUnlockItem,
  type MediaUnlockName
} from '../../shared/media-unlock'
import countries from './media-unlock-countries.json'
import { mediaUnlockRequest } from './media-unlock-transport'

type Fetcher = (url: string, init?: RequestInit) => Promise<Response>
type Result = { status: string; region?: string | null }
const queues = new Map<MediaUnlockName, Promise<unknown>>()
const timeoutMs = 15_000

function regionLabel(code: string): string {
  const upper = code.toUpperCase()
  const alpha2 = upper.length === 3 ? (countries as Record<string, string>)[upper] : upper
  // Intl validates ISO alpha-2 codes; preserve unknown codes without a flag.
  const names = new Intl.DisplayNames(['en'], { type: 'region', fallback: 'none' })
  let valid = false
  try {
    valid = !!alpha2 && /^[A-Z]{2}$/.test(alpha2) && !!names.of(alpha2)
  } catch {
    /* invalid code */
  }
  const flag = valid
    ? String.fromCodePoint(...[...alpha2].map((c) => 0x1f1e6 + c.charCodeAt(0) - 65))
    : ''
  return `${flag}${code}`
}

function quoted(body: string, key: string): string | undefined {
  const index = body.indexOf(`"${key}"`)
  if (index < 0) return undefined
  return body.slice(index + key.length + 2).match(/^\s*:\s*"([^"]*)"/)?.[1]
}

function restricted(status: number): string | undefined {
  return status === 403 || status === 451
    ? 'No'
    : status < 200 || status >= 300
      ? 'Failed'
      : undefined
}

async function text(fetcher: Fetcher, url: string): Promise<string | undefined> {
  try {
    return await (await fetcher(url)).text()
  } catch {
    return undefined
  }
}

async function trace(fetcher: Fetcher, url: string): Promise<string | undefined> {
  return (await text(fetcher, url))
    ?.split('\n')
    .find((line) => line.startsWith('loc='))
    ?.slice(4)
}

function findValue(
  value: unknown,
  key: string,
  kind: 'string' | 'boolean'
): string | boolean | undefined {
  if (!value || typeof value !== 'object') return undefined
  const obj = value as Record<string, unknown>
  if (typeof obj[key] === kind) return obj[key] as string | boolean
  for (const child of Object.values(obj)) {
    const found = findValue(child, key, kind)
    if (found !== undefined) return found
  }
  return undefined
}

const disneyAuth = 'Bearer ZGlzbmV5JmJyb3dzZXImMS4wLjA.Cu56AgSfBTDag5NiRA81oLHkDZfu5L3CKadnefEAY84'
const disneyHeaders = { authorization: disneyAuth }

async function disney(fetcher: Fetcher): Promise<Result> {
  let response: Response
  try {
    response = await fetcher('https://disney.api.edge.bamgrid.com/devices', {
      method: 'POST',
      headers: { ...disneyHeaders, 'content-type': 'application/json' },
      body: JSON.stringify({
        deviceFamily: 'browser',
        applicationRuntime: 'chrome',
        deviceProfile: 'windows',
        attributes: {}
      })
    })
  } catch {
    return { status: 'Failed (Network Connection)' }
  }
  if (response.status === 403) return { status: 'No (IP Banned By Disney+)' }
  let assertion: string
  try {
    assertion = ((await response.json()) as { assertion: string }).assertion
    if (typeof assertion !== 'string') throw new Error()
  } catch {
    return { status: 'Failed (Cannot extract assertion)' }
  }
  try {
    response = await fetcher('https://disney.api.edge.bamgrid.com/token', {
      method: 'POST',
      headers: { ...disneyHeaders, 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'urn:ietf:params:oauth:grant-type:token-exchange',
        latitude: '0',
        longitude: '0',
        platform: 'browser',
        subject_token: assertion,
        subject_token_type: 'urn:bamtech:params:oauth:token-type:device'
      }).toString()
    })
  } catch {
    return { status: 'Failed (Network Connection)' }
  }
  let body: string
  try {
    body = await response.text()
  } catch {
    return { status: 'Failed (Cannot read token response)' }
  }
  if (response.status === 403 || body.includes('forbidden-location') || body.includes('403 ERROR'))
    return { status: 'No (IP Banned By Disney+)' }
  let token: string
  try {
    token = JSON.parse(body).refresh_token
    if (typeof token !== 'string') throw new Error()
  } catch {
    return { status: `Failed (Cannot extract refresh token: ${response.status})` }
  }
  let unavailable = true
  try {
    const landing = await fetcher('https://disneyplus.com')
    unavailable = /preview|unavailable/.test(landing.url)
  } catch {
    /* unavailable */
  }
  try {
    response = await fetcher('https://disney.api.edge.bamgrid.com/graph/v1/device/graphql', {
      method: 'POST',
      headers: { ...disneyHeaders, 'content-type': 'application/json' },
      body: JSON.stringify({
        query:
          'mutation refreshToken($input: RefreshTokenInput!) { refreshToken(refreshToken: $input) { activeSession { sessionId } } }',
        variables: { input: { refreshToken: token } }
      })
    })
  } catch {
    return { status: 'Failed (Network Connection)' }
  }
  body = await response.text().catch(() => '')
  let data: unknown
  let error = `Failed (GraphQL: ${response.status})`
  if (response.ok && body) {
    try {
      data = JSON.parse(body)
    } catch {
      error = 'Failed (Invalid GraphQL Response)'
    }
  }
  const country = findValue(data, 'countryCode', 'string') as string | undefined
  if (country) {
    if (country === 'JP') return { status: 'Yes', region: regionLabel(country) }
    if (unavailable) return { status: 'No' }
    const supported = findValue(data, 'inSupportedLocation', 'boolean')
    if (supported === true) return { status: 'Yes', region: regionLabel(country) }
    if (supported === false)
      return { status: 'Soon', region: `${regionLabel(country)}（即将上线）` }
    return { status: `Failed (Unknown region status for ${country})` }
  }
  const fallback = quoted((await text(fetcher, 'https://www.disneyplus.com/')) ?? '', 'region')
  if (fallback !== undefined)
    return { status: 'Yes', region: `${regionLabel(fallback)} (from main page)` }
  return { status: data === undefined ? error : 'No' }
}

async function netflix(fetcher: Fetcher): Promise<Result> {
  try {
    const res = await fetcher(
      'https://api.fast.com/netflix/speedtest/v2?https=true&token=YXNkZmFzZGxmbnNkYWZoYXNkZmhrYWxm&urlCount=5'
    )
    if (res.status === 403) return { status: 'No (IP Banned By Netflix)' }
    const data = (await res.json()) as { targets?: { location?: { country?: string } }[] }
    const country = data.targets?.[0]?.location?.country
    if (typeof country === 'string') return { status: 'Yes', region: regionLabel(country) }
  } catch {
    /* fall back to title probes */
  }
  try {
    const [a, b] = await Promise.all(
      ['81280792', '70143836'].map((id) => fetcher(`https://www.netflix.com/title/${id}`))
    )
    if (a.status === 404 && b.status === 404) return { status: 'Originals Only' }
    if (a.status === 403 || b.status === 403) return { status: 'No' }
    if ([a.status, b.status].some((code) => code === 200 || code === 301)) {
      try {
        const res = await fetcher('https://www.netflix.com/title/80018499')
        const country = res.headers.get('location')?.split('/')[3]?.split('-')[0] || 'us'
        return { status: 'Yes', region: regionLabel(country) }
      } catch {
        return { status: 'Yes (但无法获取区域)' }
      }
    }
    return { status: `Failed (状态码: ${a.status}_${b.status})` }
  } catch {
    return { status: 'Failed' }
  }
}

export async function runMediaUnlockCheck(
  name: MediaUnlockName,
  fetcher: Fetcher
): Promise<Result> {
  switch (name) {
    case '哔哩哔哩大陆':
    case '哔哩哔哩港澳台': {
      const query =
        name === '哔哩哔哩大陆'
          ? 'avid=82846771&qn=0&type=&otype=json&ep_id=307247&fourk=1&fnver=0&fnval=16&module=bangumi'
          : 'avid=18281381&cid=29892777&qn=0&type=&otype=json&ep_id=183799&fourk=1&fnver=0&fnval=16&module=bangumi'
      try {
        const data = (await (
          await fetcher(`https://api.bilibili.com/pgc/player/web/playurl?${query}`)
        ).json()) as { code?: number }
        return { status: data.code === 0 ? 'Yes' : data.code === -10403 ? 'No' : 'Failed' }
      } catch {
        return { status: 'Failed' }
      }
    }
    case 'ChatGPT Web': {
      const loc = await trace(fetcher, 'https://chat.openai.com/cdn-cgi/trace')
      const body = await text(fetcher, 'https://api.openai.com/compliance/cookie_requirements')
      return {
        status:
          body === undefined
            ? 'Failed'
            : body.toLowerCase().includes('unsupported_country')
              ? 'Unsupported Country/Region'
              : 'Yes',
        region: loc === undefined ? null : regionLabel(loc)
      }
    }
    case 'Claude': {
      const loc = (await trace(fetcher, 'https://claude.ai/cdn-cgi/trace'))?.trim().toUpperCase()
      if (loc === undefined) return { status: 'Failed' }
      return {
        status: ['AF', 'BY', 'CN', 'CU', 'HK', 'IR', 'KP', 'MO', 'RU', 'SY'].includes(loc)
          ? 'No'
          : 'Yes',
        region: regionLabel(loc)
      }
    }
    case 'Gemini': {
      const body = await text(fetcher, 'https://gemini.google.com')
      const code = body?.match(/,2,1,200,"([A-Z]{3})/)?.[1]
      if (!code) return { status: 'Failed' }
      return {
        status: ['CHN', 'RUS', 'BLR', 'CUB', 'IRN', 'PRK', 'SYR', 'HKG', 'MAC'].includes(code)
          ? 'No'
          : 'Yes',
        region: regionLabel(code)
      }
    }
    case 'Muse AI': {
      const code = (await trace(fetcher, 'https://www.cloudflare.com/cdn-cgi/trace'))
        ?.trim()
        .toUpperCase()
      const region = code === undefined ? null : regionLabel(code)
      try {
        const response = await fetcher('https://muse.ai')
        const body = await response.text().catch(() => '')
        const risky =
          new URL(response.url).hostname === 'auth.muse.ai' ||
          ['Sorry, something went wrong', 'static.facebook.com/images/logos'].some((s) =>
            body.includes(s)
          )
        return {
          status: risky ? 'Risky' : response.ok ? 'Yes' : (restricted(response.status) ?? 'Failed'),
          region
        }
      } catch {
        return { status: 'Failed (Network Connection)', region }
      }
    }
    case 'YouTube Premium': {
      try {
        const response = await fetcher('https://www.youtube.com/premium?hl=en')
        const body = await response.text()
        const low = body.toLowerCase()
        const code =
          ['GL', 'countryCode', 'country_code']
            .map((key) => quoted(body, key))
            .find((v) => v !== undefined) ??
          body.match(/id=["']country-code["'][^>]*>\s*([^<]+)</)?.[1]?.trim()
        const no = [
          'youtube premium is not available in your country',
          'premium is not available in your country',
          'premium is not available in your region'
        ].some((s) => low.includes(s))
        const yes =
          response.ok &&
          ['youtube premium', 'ad-free', '"browseid":"spunlimited"'].some((s) => low.includes(s))
        return {
          status: no ? 'No' : yes ? 'Yes' : 'Failed',
          region: code === undefined ? null : regionLabel(code.toUpperCase())
        }
      } catch {
        return { status: 'Failed' }
      }
    }
    case 'Bahamut Anime': {
      const headers = {
        'user-agent':
          'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36'
      }
      let device: string
      try {
        device = (
          (await (
            await fetcher('https://ani.gamer.com.tw/ajax/getdeviceid.php', { headers })
          ).json()) as { deviceid: string }
        ).deviceid
        if (typeof device !== 'string') throw new Error()
      } catch {
        return { status: 'Failed' }
      }
      const token = await text(
        (url) => fetcher(url, { headers }),
        `https://ani.gamer.com.tw/ajax/token.php?adID=89422&sn=37783&device=${encodeURIComponent(device)}`
      )
      if (!token?.includes('animeSn')) return { status: 'No' }
      const home = await text((url) => fetcher(url, { headers }), 'https://ani.gamer.com.tw/')
      const code = home?.match(/data-geo="([^"]*)"/)?.[1]
      return { status: 'Yes', region: code === undefined ? null : regionLabel(code) }
    }
    case 'Netflix':
      return netflix(fetcher)
    case 'Disney+':
      return disney(fetcher)
    case 'Prime Video': {
      let body: string
      try {
        const res = await fetcher('https://www.primevideo.com')
        try {
          body = await res.text()
        } catch {
          return { status: 'Failed (Cannot Read Response)' }
        }
      } catch {
        return { status: 'Failed (Network Connection)' }
      }
      if (body.includes('isServiceRestricted')) return { status: 'No (Service Not Available)' }
      const code = body.match(/"currentTerritory":"([^"]*)"/)?.[1]
      return code === undefined
        ? { status: 'Failed (PAGE ERROR)' }
        : { status: 'Yes', region: regionLabel(code) }
    }
    case 'Spotify': {
      try {
        const res = await fetcher(
          'https://www.spotify.com/api/content/v1/country-selector?platform=web&format=json'
        )
        const body = await res.text().catch(() => '')
        const segment = new URL(res.url).pathname.split('/')[1]
        const code =
          segment && segment !== 'api'
            ? segment.split('-')[0].toUpperCase()
            : body.match(/"countryCode":"([^"]*)"/)?.[1]?.toUpperCase()
        return {
          status:
            restricted(res.status) ??
            (body.toLowerCase().includes('not available in your country') ? 'No' : 'Yes'),
          region: code ? regionLabel(code) : null
        }
      } catch {
        return { status: 'Failed' }
      }
    }
    case 'TikTok': {
      const check = async (url: string): Promise<Result> => {
        try {
          const res = await fetcher(url)
          const body = await res.text()
          const low = body.toLowerCase()
          const code = quoted(body, 'region')?.split('-')[0].toUpperCase()
          return {
            status:
              restricted(res.status) ??
              (['access denied', 'not available in your region', 'tiktok is not available'].some(
                (s) => low.includes(s)
              )
                ? 'No'
                : 'Yes'),
            region: code ? regionLabel(code) : null
          }
        } catch {
          return { status: 'Failed' }
        }
      }
      const first = await check('https://www.tiktok.com/cdn-cgi/trace')
      if (first.region && first.status !== 'Failed') return first
      const second = await check('https://www.tiktok.com/')
      return {
        status: first.status === 'No' ? 'No' : second.status,
        region: first.region ?? second.region
      }
    }
  }
}

function checked(name: MediaUnlockName, result: Result): MediaUnlockItem {
  const now = new Date()
  const pad = (n: number): string => String(n).padStart(2, '0')
  return {
    name,
    status: result.status,
    region: result.region ?? null,
    check_time: `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())} ${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}`
  }
}

export function defaultMediaUnlockItems(): MediaUnlockItem[] {
  return MEDIA_UNLOCK_NAMES.map((name) => ({
    name,
    status: 'Pending',
    region: null,
    check_time: null
  }))
}

export async function checkMediaUnlockItem(input: string): Promise<MediaUnlockItem> {
  if (!(MEDIA_UNLOCK_NAMES as readonly string[]).includes(input))
    throw new Error(`未知的流媒体检测项目: ${input}`)
  const name = input as MediaUnlockName
  const previous = queues.get(name) ?? Promise.resolve()
  const next = previous
    .catch(() => {})
    .then(async () => {
      const controller = new AbortController()
      let timer: ReturnType<typeof setTimeout> | undefined
      const timeout = new Promise<Result>((resolve) => {
        timer = setTimeout(() => {
          controller.abort()
          resolve({ status: 'Failed' })
        }, timeoutMs)
      })
      try {
        const work = (async (): Promise<Result> => {
          const config = await getRuntimeConfig()
          const mixed = config['mixed-port'] ?? 0
          const http = config.port ?? 0
          const port = mixed > 0 ? mixed : http > 0 ? http : 0
          if (!Number.isInteger(port) || port < 1 || port > 65535 || controller.signal.aborted)
            return { status: 'Failed' }
          const isolated = session.fromPartition(
            `media-unlock-${MEDIA_UNLOCK_NAMES.indexOf(name)}`,
            { cache: false }
          )
          await isolated.closeAllConnections()
          await isolated.clearStorageData()
          await isolated.clearAuthCache()
          if (controller.signal.aborted) return { status: 'Failed' }
          await isolated.setProxy({
            mode: 'fixed_servers',
            proxyRules: `http=127.0.0.1:${port};https=127.0.0.1:${port}`,
            proxyBypassRules: '<-loopback>'
          })
          if (controller.signal.aborted) return { status: 'Failed' }
          const credential = config.authentication?.find((value) => value.includes(':'))
          const fetcher: Fetcher = (url, init) =>
            mediaUnlockRequest(isolated, port, credential, url, init, controller.signal)
          return runMediaUnlockCheck(name, fetcher)
        })()
        return checked(name, await Promise.race([work, timeout]))
      } catch {
        return checked(name, { status: 'Failed' })
      } finally {
        if (timer) clearTimeout(timer)
      }
    })
  queues.set(name, next)
  try {
    return await next
  } finally {
    if (queues.get(name) === next) queues.delete(name)
  }
}
