import { afterEach, describe, expect, it, vi } from 'vitest'
import { assertConfigurationBackupAllowed, managedTiziActive, managedTiziOverlay } from './policy'

const mocks = vi.hoisted(() => ({ config: { tiziActive: true } }))
vi.mock('../config/app', () => ({ getAppConfig: async () => mocks.config }))
afterEach(() => vi.unstubAllGlobals())

describe('managed subscription protections', () => {
  it('allows previous backup preferences again after switching back to a private subscription', async () => {
    vi.stubGlobal('__TIZI_ENABLED__', true)
    mocks.config.tiziActive = true
    await expect(assertConfigurationBackupAllowed()).rejects.toThrow('备份')
    mocks.config.tiziActive = false
    await expect(assertConfigurationBackupAllowed()).resolves.toBeUndefined()
    mocks.config.tiziActive = true
    vi.stubGlobal('__TIZI_ENABLED__', false)
    expect(managedTiziActive(mocks.config)).toBe(false)
    await expect(assertConfigurationBackupAllowed()).resolves.toBeUndefined()
  })

  it('retains internal IPC while excluding remote controllers, nodes and arbitrary config', () => {
    const overlay = managedTiziOverlay({
      'mixed-port': 7890,
      'external-controller-unix': '/private/core.sock',
      'external-controller': '0.0.0.0:9090',
      'external-controller-tls': '0.0.0.0:9091',
      'external-ui': 'ui',
      'external-ui-url': 'https://example.com',
      'external-controller-cors': { 'allow-origins': ['*'] },
      'ss-config': 'server-secret',
      'vmess-config': 'server-secret',
      proxies: [{ name: 'private' }],
      'proxy-providers': { private: {} },
      rules: ['MATCH,private'],
      'post-up': 'arbitrary-command'
    })
    expect(overlay).toEqual({
      'mixed-port': 7890,
      'external-controller-unix': '/private/core.sock'
    })
  })
})
