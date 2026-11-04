import http from 'http'
import https from 'https'
import { execFileSync } from 'child_process'
import { mkdtemp, readFile, rm, writeFile, lstat } from 'fs/promises'
import { tmpdir } from 'os'
import path from 'path'
import { once } from 'events'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import WebSocket, { WebSocketServer } from 'ws'
import { createExternalController, controllerClientAuth } from './external-controller'

let root: string
let upstream: http.Server
let sockets: WebSocketServer
let controller: Awaited<ReturnType<typeof createExternalController>> | undefined
let seen: { url?: string; headers: http.IncomingHttpHeaders; body: string }[]
beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'momo-ctl-'))
  seen = []
  upstream = http.createServer(async (req, res) => {
    let body = ''
    for await (const chunk of req) body += chunk
    seen.push({ url: req.url, headers: req.headers, body })
    res.setHeader('Content-Type', 'application/json')
    res.setHeader('Access-Control-Allow-Origin', 'https://private-controller.invalid')
    res.end(JSON.stringify({ ok: true }))
  })
  sockets = new WebSocketServer({ server: upstream })
  sockets.on('connection', (socket, req) => {
    seen.push({ url: req.url, headers: req.headers, body: '' })
    socket.send('traffic-frame')
    socket.on('message', (data) => socket.send(data))
  })
  upstream.listen(path.join(root, 'core.sock'))
  await once(upstream, 'listening')
})
afterEach(async () => {
  await controller?.stop()
  controller = undefined
  for (const client of sockets.clients) client.terminate()
  sockets.close()
  await new Promise<void>((resolve) => upstream.close(() => resolve()))
  await rm(root, { recursive: true, force: true })
})
const start = async (
  extra: Partial<Parameters<typeof createExternalController>[0]> = {}
): Promise<string> => {
  controller = await createExternalController({
    address: '127.0.0.1:0',
    secret: 'public-secret',
    socketPath: path.join(root, 'core.sock'),
    headers: () => ({ 'X-Momo-Session': 'private-session' }),
    ...extra
  })
  return `http://127.0.0.1:${controller.port}`
}

describe('macOS public controller transport', () => {
  it('matches the native core client-auth modes and requires verification when a CA is supplied', () => {
    expect(controllerClientAuth(undefined, false)).toEqual({
      requireClientCertificate: false,
      verifyClientCertificateIfGiven: false,
      requestCert: false,
      rejectUnauthorized: false
    })
    expect(controllerClientAuth(undefined, true).rejectUnauthorized).toBe(true)
    expect(controllerClientAuth('request', true)).toMatchObject({
      requestCert: true,
      rejectUnauthorized: false
    })
    expect(controllerClientAuth('require-any', true).requireClientCertificate).toBe(true)
    expect(controllerClientAuth('verify-if-given', true).verifyClientCertificateIfGiven).toBe(true)
    expect(controllerClientAuth('require-and-verify', true).rejectUnauthorized).toBe(true)
  })
  it('authenticates and forwards escaped group names without exposing helper controls or credentials', async () => {
    const base = await start()
    const name = encodeURIComponent('🚀 节点选择')
    expect((await fetch(`${base}/proxies/${name}`, { method: 'PUT' })).status).toBe(401)
    expect(seen).toHaveLength(0)
    const result = await fetch(`${base}/proxies/${name}`, {
      method: 'PUT',
      headers: {
        Authorization: 'Bearer public-secret',
        Origin: 'https://webui.example',
        Cookie: 'private-browser-data',
        'X-Momo-Session': 'forged-session',
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ name: '香港 01' })
    })
    expect(result.status).toBe(200)
    expect(result.headers.get('Access-Control-Allow-Origin')).toBe('https://webui.example')
    expect(await result.json()).toEqual({ ok: true })
    expect(seen[0]).toMatchObject({
      url: `/core/proxies/${name}`,
      body: JSON.stringify({ name: '香港 01' }),
      headers: { 'x-momo-session': 'private-session' }
    })
    for (const key of ['origin', 'authorization', 'cookie'])
      expect(seen[0].headers[key]).toBeUndefined()
    await fetch(`${base}/v1/core/stop`, { headers: { Authorization: 'Bearer public-secret' } })
    expect(seen[1].url).toBe('/core/v1/core/stop')
  })

  it('supports browser CORS/private-network preflights and configured origin restrictions', async () => {
    const base = await start({
      cors: { 'allow-origins': ['https://*.example'], 'allow-private-network': false }
    })
    const result = await fetch(`${base}/configs`, {
      method: 'OPTIONS',
      headers: { Origin: 'https://panel.example' }
    })
    expect(result.status).toBe(204)
    expect(result.headers.get('Access-Control-Allow-Headers')).toContain('Authorization')
    expect(result.headers.get('Access-Control-Allow-Private-Network')).toBeNull()
    expect(
      (
        await fetch(`${base}/configs`, {
          method: 'OPTIONS',
          headers: { Origin: 'https://other.invalid' }
        })
      ).status
    ).toBe(403)
    expect(seen).toHaveLength(0)
  })

  it('streams WebSockets with query-token authentication and closes them on shutdown', async () => {
    const base = await start()
    const client = new WebSocket(`${base.replace('http:', 'ws:')}/traffic?token=public-secret`, {
      origin: 'https://panel.example'
    })
    const [message] = await once(client, 'message')
    expect(message.toString()).toBe('traffic-frame')
    expect(seen[0].url).toBe('/core/traffic?token=public-secret')
    expect(seen[0].headers.origin).toBeUndefined()
    expect(seen[0].headers['x-momo-session']).toBe('private-session')
    const echo = once(client, 'message')
    client.send('test')
    expect((await echo)[0].toString()).toBe('test')
    const closed = once(client, 'close')
    await controller?.stop()
    controller = undefined
    await closed
  })

  it('serves local panel assets while requiring the token for the API', async () => {
    await writeFile(path.join(root, 'index.html'), '<h1>WebUI</h1>')
    const base = await start({ uiDirectory: root })
    expect(await (await fetch(`${base}/ui/`)).text()).toContain('<h1>WebUI</h1>')
    expect((await fetch(`${base}/version`)).status).toBe(401)
    expect(seen).toHaveLength(0)
  })

  it('reports address conflicts and releases the listener for the next start', async () => {
    await start()
    if (!controller) throw new Error('Controller did not start')
    const port = controller.port
    await expect(
      createExternalController({
        address: `127.0.0.1:${port}`,
        socketPath: '',
        headers: () => ({})
      })
    ).rejects.toMatchObject({ code: 'EADDRINUSE' })
    await controller.stop()
    controller = undefined
    await start({ address: `127.0.0.1:${port}` })
  })

  it('serves an authenticated Unix controller and removes its socket on stop', async () => {
    const socketPath = path.join(root, 'public.sock')
    await start({ unixPath: socketPath })
    const result = await new Promise<number>((resolve, reject) => {
      const req = http.get(
        { socketPath, path: '/version', headers: { Authorization: 'Bearer public-secret' } },
        (res) => {
          res.resume()
          res.on('end', () => resolve(res.statusCode || 0))
        }
      )
      req.on('error', reject)
    })
    expect(result).toBe(200)
    expect((await lstat(socketPath)).mode & 0o777).toBe(0o600)
    await controller?.stop()
    controller = undefined
    await expect(lstat(socketPath)).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it.skipIf(process.platform === 'win32')(
    'serves HTTPS and WSS using the configured certificate',
    async () => {
      const key = path.join(root, 'key.pem')
      const cert = path.join(root, 'cert.pem')
      execFileSync(
        'openssl',
        [
          'req',
          '-x509',
          '-newkey',
          'rsa:2048',
          '-nodes',
          '-keyout',
          key,
          '-out',
          cert,
          '-days',
          '1',
          '-subj',
          '/CN=localhost'
        ],
        { stdio: 'pipe' }
      )
      const base = (
        await start({ tls: { key: await readFile(key), cert: await readFile(cert) } })
      ).replace('http:', 'https:')
      const status = await new Promise<number>((resolve, reject) => {
        https
          .get(
            `${base}/version`,
            { rejectUnauthorized: false, headers: { Authorization: 'Bearer public-secret' } },
            (res) => {
              res.resume()
              res.on('end', () => resolve(res.statusCode || 0))
            }
          )
          .on('error', reject)
      })
      expect(status).toBe(200)
      const client = new WebSocket(
        `${base.replace('https:', 'wss:')}/traffic?token=public-secret`,
        { rejectUnauthorized: false }
      )
      expect((await once(client, 'message'))[0].toString()).toBe('traffic-frame')
      const closed = once(client, 'close')
      client.close()
      await closed
      await controller?.stop()
      controller = undefined
      const tls = { key: await readFile(key), cert: await readFile(cert) }
      const auth = controllerClientAuth(undefined, true)
      const protectedBase = (
        await start({
          ...auth,
          tls: {
            ...tls,
            ca: tls.cert,
            requestCert: auth.requestCert,
            rejectUnauthorized: auth.rejectUnauthorized
          }
        })
      ).replace('http:', 'https:')
      const get = (identity = false): Promise<number> =>
        new Promise((resolve, reject) => {
          https
            .get(
              `${protectedBase}/version`,
              {
                rejectUnauthorized: false,
                ...(identity ? tls : {}),
                headers: { Authorization: 'Bearer public-secret' }
              },
              (res) => {
                res.resume()
                res.on('end', () => resolve(res.statusCode || 0))
              }
            )
            .on('error', reject)
        })
      await expect(get()).rejects.toThrow()
      expect(await get(true)).toBe(200)
    }
  )

  it('authenticates management requests and replies before running deferred lifecycle work', async () => {
    let calls = 0
    let finish!: () => void
    const done = new Promise<void>((resolve) => {
      finish = resolve
    })
    const base = await start({
      handle: async (req) => {
        if (req.url !== '/restart') return undefined
        calls++
        return {
          body: { status: 'ok' },
          afterResponse: async () => {
            finish()
          }
        }
      }
    })
    expect((await fetch(`${base}/restart`, { method: 'POST' })).status).toBe(401)
    expect(calls).toBe(0)
    const response = await fetch(`${base}/restart`, {
      method: 'POST',
      headers: { Authorization: 'Bearer public-secret' }
    })
    expect(await response.json()).toEqual({ status: 'ok' })
    await done
    expect(calls).toBe(1)
    expect(seen).toHaveLength(0)
  })
})
