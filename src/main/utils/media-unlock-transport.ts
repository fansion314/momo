import { net } from 'electron'

const browserUserAgent =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36'
const maxResponseBytes = 8 * 1024 * 1024

// ClientRequest's login event belongs to this request, unlike the global app
// event. Never send proxy credentials to a destination server challenge.
export function mediaUnlockRequest(
  isolated: Electron.Session,
  port: number,
  credential: string | undefined,
  url: string,
  init: RequestInit | undefined,
  signal: AbortSignal
): Promise<Response> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) return reject(new Error('Request aborted'))
    let currentUrl = url
    let redirects = 0
    let attempts = 0
    const request = net.request({
      url,
      method: init?.method ?? 'GET',
      session: isolated,
      useSessionCookies: true
    })
    const headers = new Headers(init?.headers)
    if (!headers.has('user-agent')) headers.set('user-agent', browserUserAgent)
    headers.forEach((value, key) => request.setHeader(key, value))
    const abort = (): void => request.abort()
    const finish = (): void => signal.removeEventListener('abort', abort)
    signal.addEventListener('abort', abort, { once: true })
    request.on('login', (info, callback) => {
      if (
        !info.isProxy ||
        info.host !== '127.0.0.1' ||
        info.port !== port ||
        !credential ||
        attempts++ > 0
      ) {
        callback()
        return
      }
      const index = credential.indexOf(':')
      if (index < 0) callback()
      else callback(credential.slice(0, index), credential.slice(index + 1))
    })
    request.on('redirect', (_status, _method, target) => {
      if (++redirects > 10 || !/^https?:/i.test(target)) {
        request.abort()
        return
      }
      currentUrl = target
      request.followRedirect()
    })
    request.on('error', (error) => {
      finish()
      reject(error)
    })
    request.on('abort', () => {
      finish()
      reject(new Error('Request aborted'))
    })
    request.on('response', (incoming) => {
      const chunks: Buffer[] = []
      let size = 0
      incoming.on('data', (chunk: Buffer) => {
        size += chunk.length
        if (size > maxResponseBytes) {
          request.abort()
          return
        }
        chunks.push(chunk)
      })
      incoming.on('error', (error) => {
        finish()
        reject(error)
      })
      incoming.on('end', () => {
        finish()
        const responseHeaders = new Headers()
        for (const [key, values] of Object.entries(incoming.headers)) {
          for (const value of Array.isArray(values) ? values : [values]) {
            if (value !== undefined) responseHeaders.append(key, String(value))
          }
        }
        const status = incoming.statusCode
        const body =
          status === 204 || status === 205 || status === 304 ? null : Buffer.concat(chunks)
        const response = new Response(body, { status, headers: responseHeaders })
        Object.defineProperty(response, 'url', { value: currentUrl })
        resolve(response)
      })
    })
    if (typeof init?.body === 'string') request.write(init.body)
    request.end()
  })
}
