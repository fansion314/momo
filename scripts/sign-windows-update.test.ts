import { generateKeyPairSync, verify } from 'node:crypto'
import { describe, expect, it } from 'vitest'
// @ts-expect-error Release scripts run as JavaScript in the publishing runner.
import { signManifest } from './sign-windows-update.mjs'

describe('Windows update signing', () => {
  it('signs the exact payload and rejects a private key outside the embedded trust map', () => {
    const { publicKey, privateKey } = generateKeyPairSync('ed25519')
    const keys = { test: publicKey.export({ type: 'spki', format: 'der' }).toString('base64') }
    const pem = privateKey.export({ type: 'pkcs8', format: 'pem' })
    const payload = { tag: 'clash-momo-v2.0.4-5', revision: 5 }
    const envelope = signManifest(payload, pem, keys, 'test')
    const bytes = Buffer.from(envelope.payload, 'base64')
    expect(JSON.parse(bytes.toString())).toEqual(payload)
    expect(verify(null, bytes, publicKey, Buffer.from(envelope.signature, 'base64'))).toBe(true)
    expect(
      verify(null, Buffer.from('{}'), publicKey, Buffer.from(envelope.signature, 'base64'))
    ).toBe(false)
    expect(() => signManifest(payload, pem, {}, 'test')).toThrow('does not match')
  })
})
