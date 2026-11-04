import http, { type IncomingMessage, type ServerResponse } from 'http'
import type { Socket } from 'net'
import net from 'net'
import https from 'https'
import { chmod, lstat, mkdir, unlink } from 'fs/promises'
import path from 'path'
import { timingSafeEqual } from 'crypto'
import express from 'express'

interface ControllerOptions {
  address?: string
  unixPath?: string
  tls?: https.ServerOptions
  requireClientCertificate?: boolean
  verifyClientCertificateIfGiven?: boolean
  secret?: string
  cors?: IMihomoConfig['external-controller-cors']
  socketPath: string
  headers: () => Record<string, string>
  uiDirectory?: string
  handle?: (req: IncomingMessage) => Promise<ControllerReply | undefined>
  onError?: (error: unknown) => void
}

export interface ControllerReply {
  status?: number
  body?: unknown
  afterResponse?: () => Promise<void>
}

export function controllerClientAuth(
  type: string | undefined,
  hasCertificate: boolean
): {
  requireClientCertificate: boolean
  verifyClientCertificateIfGiven: boolean
  requestCert: boolean
  rejectUnauthorized: boolean
} {
  const known = ['request', 'require-any', 'verify-if-given', 'require-and-verify']
  const mode = known.includes(type || '') ? type : hasCertificate ? 'require-and-verify' : ''
  return {
    requireClientCertificate: mode === 'require-any',
    verifyClientCertificateIfGiven: mode === 'verify-if-given',
    requestCert: Boolean(mode),
    rejectUnauthorized: mode === 'require-and-verify'
  }
}

export async function readControllerJSON<T>(req: IncomingMessage): Promise<T> {
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of req) {
    size += chunk.length
    if (size > 16 * 1024 * 1024) throw new Error('Controller request exceeds 16 MiB')
    chunks.push(Buffer.from(chunk))
  }
  return JSON.parse(Buffer.concat(chunks).toString() || '{}') as T
}

// Public controller access belongs to the ordinary application process. Only
// core API requests are forwarded; helper lifecycle/network endpoints stay local.
export async function createExternalController(options: ControllerOptions): Promise<{
  port: number
  stop: () => Promise<void>
}> {
  const address = options.address?.startsWith(':') ? `[::]${options.address}` : options.address
  const listen = new URL(`http://${address || '127.0.0.1:0'}`)
  const port = Number(listen.port || 80)
  if (listen.pathname !== '/' || listen.username || listen.password || listen.search || listen.hash)
    throw new Error('Invalid external controller listen address')
  const sockets = new Set<Socket>()
  const requests = new Set<http.ClientRequest>()
  const origins = options.cors?.['allow-origins'] ?? ['*']
  const originAllowed = (origin: string): boolean =>
    origins.some((pattern) => {
      const escaped = pattern.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replaceAll('*', '.*')
      return new RegExp(`^${escaped}$`).test(origin)
    })
  const authorized = (req: IncomingMessage, upgrade = false): boolean => {
    if (!options.secret) return true
    const query = (req.url || '').indexOf('?')
    const queryToken =
      upgrade && query !== -1 ? new URLSearchParams(req.url?.slice(query + 1)).get('token') : null
    const bearer = req.headers.authorization?.startsWith('Bearer ')
      ? req.headers.authorization.slice(7)
      : ''
    const supplied = Buffer.from(queryToken ?? bearer)
    const expected = Buffer.from(options.secret)
    return supplied.length === expected.length && timingSafeEqual(supplied, expected)
  }
  const staticApp = express()
  if (options.uiDirectory) staticApp.use('/ui', express.static(options.uiDirectory))

  function forward(
    req: IncomingMessage,
    res?: ServerResponse,
    client?: Socket,
    head?: Buffer
  ): void {
    const raw = req.url || '/'
    // Do not let URL resolution turn an API path into a helper control path.
    if (!raw.startsWith('/') || raw.startsWith('//')) {
      res?.writeHead(400).end()
      client?.destroy()
      return
    }
    const headers: http.OutgoingHttpHeaders = { ...req.headers }
    for (const key of ['origin', 'authorization', 'cookie', 'host', 'x-momo-session'])
      delete headers[key]
    Object.assign(headers, options.headers(), { host: 'localhost' })
    const outgoing = http.request({
      socketPath: options.socketPath,
      path: `/core${raw}`,
      method: req.method,
      headers,
      agent: false
    })
    requests.add(outgoing)
    outgoing.once('close', () => requests.delete(outgoing))
    const timer = setTimeout(
      () => outgoing.destroy(new Error('Controller upstream timeout')),
      15000
    )
    outgoing.once('error', () => {
      clearTimeout(timer)
      if (res && !res.headersSent) res.writeHead(502).end('Core controller unavailable')
      else res?.destroy()
      client?.destroy()
    })
    outgoing.once('response', (upstream) => {
      clearTimeout(timer)
      if (!res) {
        client?.end(`HTTP/1.1 ${upstream.statusCode || 502} Rejected\r\nConnection: close\r\n\r\n`)
        upstream.resume()
        return
      }
      // The public listener owns CORS; the private controller cannot override it.
      const responseHeaders = { ...upstream.headers }
      for (const key of Object.keys(responseHeaders)) {
        if (key.startsWith('access-control-')) delete responseHeaders[key]
      }
      res.writeHead(upstream.statusCode || 502, responseHeaders)
      upstream.pipe(res)
      res.once('close', () => upstream.destroy())
      upstream.once('error', () => res.destroy())
    })
    outgoing.once('upgrade', (upstream, backend, backendHead) => {
      clearTimeout(timer)
      if (!client) {
        backend.destroy()
        return
      }
      sockets.add(backend)
      backend.once('close', () => sockets.delete(backend))
      const responseHeaders = upstream.rawHeaders
      client.write(
        `HTTP/1.1 101 Switching Protocols\r\n${responseHeaders.reduce((lines, value, i) => lines + (i % 2 ? `${value}\r\n` : `${value}: `), '')}\r\n`
      )
      if (backendHead.length) client.write(backendHead)
      if (head?.length) backend.write(head)
      backend.pipe(client).pipe(backend)
      backend.once('error', () => client.destroy())
      client.once('error', () => backend.destroy())
      client.once('close', () => backend.destroy())
      backend.once('close', () => client.destroy())
    })
    req.pipe(outgoing)
    if (res) res.once('close', () => outgoing.destroy())
  }

  const dispatch = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    const origin = req.headers.origin
    if (origin && originAllowed(origin)) {
      res.setHeader('Access-Control-Allow-Origin', origin)
      res.setHeader('Vary', 'Origin')
      res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, PATCH, DELETE, OPTIONS')
      res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization')
      if (options.cors?.['allow-private-network'] !== false)
        res.setHeader('Access-Control-Allow-Private-Network', 'true')
    }
    if (req.method === 'OPTIONS') {
      res.writeHead(origin && !originAllowed(origin) ? 403 : 204).end()
      return
    }
    // Static panel assets are public, just like Mihomo's /ui mount. API requests
    // still require the configured access token.
    if (options.uiDirectory && (req.url === '/ui' || req.url?.startsWith('/ui/'))) {
      staticApp(req, res)
      return
    }
    if (!authorized(req)) {
      res.writeHead(401).end('Unauthorized')
      return
    }
    const reply = await options.handle?.(req)
    if (reply) {
      req.resume()
      if (reply.afterResponse) {
        res.once('finish', () => {
          setTimeout(() => {
            void reply.afterResponse?.().catch(options.onError || (() => {}))
          }, 25)
        })
      }
      if (reply.body !== undefined) res.setHeader('Content-Type', 'application/json')
      res
        .writeHead(reply.status ?? 200)
        .end(reply.body === undefined ? undefined : JSON.stringify(reply.body))
      return
    }
    forward(req, res)
  }
  const handler = (req: IncomingMessage, res: ServerResponse): void => {
    void dispatch(req, res).catch((error) => {
      options.onError?.(error)
      if (res.headersSent) res.destroy()
      else
        res
          .writeHead(400, { 'Content-Type': 'application/json' })
          .end(JSON.stringify({ message: String(error) }))
    })
  }
  const server = options.tls ? https.createServer(options.tls, handler) : http.createServer(handler)
  if (server instanceof https.Server) {
    server.on('secureConnection', (socket) => {
      const certificate = socket.getPeerCertificate()
      if (
        (options.requireClientCertificate && !certificate.raw) ||
        (options.verifyClientCertificateIfGiven && certificate.raw && !socket.authorized)
      )
        socket.destroy()
    })
  }
  server.on('connection', (socket) => {
    sockets.add(socket)
    socket.once('close', () => sockets.delete(socket))
  })
  server.on('upgrade', (req, socket, head) => {
    const client = socket as Socket
    if (!authorized(req, true) || (req.headers.origin && !originAllowed(req.headers.origin))) {
      client.end('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n')
      return
    }
    forward(req, undefined, client, head)
  })
  const stop = async (): Promise<void> => {
    for (const outgoing of requests) outgoing.destroy()
    for (const socket of sockets) socket.destroy()
    await new Promise<void>((resolve) => server.close(() => resolve()))
  }
  try {
    if (options.unixPath) {
      await mkdir(path.dirname(options.unixPath), { recursive: true })
      const previous = await lstat(options.unixPath).catch((error: NodeJS.ErrnoException) => {
        if (error.code !== 'ENOENT') throw error
        return undefined
      })
      if (previous) {
        if (!previous.isSocket() || previous.uid !== process.getuid?.())
          throw new Error('Controller socket path is already occupied')
        await new Promise<void>((resolve, reject) => {
          const probe = net.createConnection({ path: options.unixPath || '' })
          probe.once('connect', () => {
            probe.destroy()
            reject(new Error('Controller socket is already in use'))
          })
          probe.once('error', (error: NodeJS.ErrnoException) => {
            if (error.code === 'ECONNREFUSED') resolve()
            else reject(error)
          })
          probe.setTimeout(1000, () => {
            probe.destroy()
            reject(new Error('Controller socket probe timed out'))
          })
        })
        const current = await lstat(options.unixPath)
        if (current.ino !== previous.ino || current.dev !== previous.dev)
          throw new Error('Controller socket path changed')
        await unlink(options.unixPath)
      }
    }
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject)
      const ready = (): void => {
        server.removeListener('error', reject)
        resolve()
      }
      if (options.unixPath) server.listen(options.unixPath, ready)
      else server.listen(port, listen.hostname.replace(/^\[|\]$/g, ''), ready)
    })
    if (options.unixPath) await chmod(options.unixPath, 0o600)
  } catch (error) {
    await stop()
    throw error
  }
  server.on('error', () => {
    void stop()
  })
  return {
    port:
      typeof server.address() === 'string'
        ? 0
        : (server.address() as import('net').AddressInfo).port,
    stop
  }
}
