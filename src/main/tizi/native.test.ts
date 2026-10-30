import { EventEmitter } from 'events'
import { PassThrough } from 'stream'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { invokeTiziNative, validateTiziRequest } from './native'

const mocks = vi.hoisted(() => ({ spawn: vi.fn() }))
vi.mock('child_process', () => ({ spawn: mocks.spawn }))

function processFixture() {
  const process = Object.assign(new EventEmitter(), {
    stdin: new PassThrough(),
    stdout: new PassThrough(),
    stderr: new PassThrough(),
    kill: vi.fn()
  })
  mocks.spawn.mockReturnValue(process)
  return process
}

beforeEach(() => mocks.spawn.mockReset())
afterEach(() => vi.useRealTimers())

describe('tizi native boundary', () => {
  it('does not accept filesystem arguments, unlisted actions or non-HTTPS service URLs', () => {
    expect(() => validateTiziRequest('decrypt', {})).toThrow('Unknown')
    expect(() => validateTiziRequest('login', { state_dir: '/tmp/other' })).toThrow('field')
    expect(() => validateTiziRequest('status', { server_url: 'https://example.com' })).toThrow(
      'field'
    )
    for (const server_url of [
      'http://example.com',
      'https://name:secret@example.com',
      'https://example.com/path',
      'https://example.com?token=secret',
      'file:///etc/passwd'
    ])
      expect(() => validateTiziRequest('login', { server_url })).toThrow()
    expect(
      validateTiziRequest('login', {
        server_url: 'https://example.com/',
        email: 'user@example.com'
      })
    ).toEqual({
      action: 'login',
      payload: { server_url: 'https://example.com', email: 'user@example.com' }
    })
  })

  it('sends credentials only through stdin and unwraps a successful response', async () => {
    const process = processFixture()
    let input = ''
    process.stdin.on('data', (chunk) => (input += String(chunk)))
    const request = { email: 'user@example.com', password: 'test-password-only' }
    const result = invokeTiziNative('/usr/bin/mihomomo', '/private/state', 'login', request)
    process.stderr.write('private diagnostics are discarded')
    process.stdout.write(JSON.stringify({ ok: true, data: { device_id: 'a-device' } }))
    process.emit('close', 0)
    await expect(result).resolves.toEqual({ device_id: 'a-device' })
    expect(JSON.parse(input)).toEqual(request)
    expect(mocks.spawn.mock.calls[0][1]).toEqual(['tizi', '--state-dir', '/private/state', 'login'])
    expect(mocks.spawn.mock.calls[0][2]).not.toHaveProperty('shell')
  })

  it('rejects an old core without exposing its diagnostics', async () => {
    const process = processFixture()
    const result = invokeTiziNative('/core', '/state', 'status', {})
    process.stdout.write('old core help')
    process.emit('close', 1)
    await expect(result).rejects.toThrow('tizi support')
  })

  it('bounds response size and terminates stalled native requests', async () => {
    const process = processFixture()
    const result = invokeTiziNative('/core', '/state', 'usage', {})
    process.stdout.write(Buffer.alloc(2 * 1024 * 1024 + 1))
    await expect(result).rejects.toThrow('size')
    expect(process.kill).toHaveBeenCalledOnce()

    vi.useFakeTimers()
    const stalled = processFixture()
    const pending = invokeTiziNative('/core', '/state', 'status', {})
    const assertion = expect(pending).rejects.toThrow('timed out')
    await vi.advanceTimersByTimeAsync(60000)
    await assertion
    expect(stalled.kill).toHaveBeenCalledOnce()
  })
})
