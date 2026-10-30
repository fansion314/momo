import { describe, expect, it } from 'vitest'
import { orderedProviderNames, runtimeProxyGroups } from './proxy-groups'

describe('managed group metadata without plaintext runtime configuration', () => {
  const proxies = {
    proxies: {
      GLOBAL: { name: 'GLOBAL', type: 'Selector', all: ['node'] },
      managed: { name: 'managed', type: 'Selector', all: ['node'] },
      automatic: { name: 'automatic', type: 'URLTest', all: ['node'] },
      hidden: { name: 'hidden', type: 'Selector', all: ['node'], hidden: true },
      node: { name: 'node', type: 'VLESS' }
    }
  } as unknown as IMihomoProxies

  it('shows all live native groups for a sealed wrapper instead of only GLOBAL', () => {
    const wrapper = {
      'tizi-managed': { 'state-dir': '/private/sealed' }
    } as unknown as IMihomoConfig
    expect(runtimeProxyGroups(wrapper, proxies, false).map(({ group }) => group.name)).toEqual([
      'managed',
      'automatic',
      'GLOBAL'
    ])
    expect(runtimeProxyGroups(wrapper, proxies, true)).toHaveLength(4)
    expect(wrapper).not.toHaveProperty('proxy-groups')
    expect(wrapper).not.toHaveProperty('proxies')
  })

  it('preserves configured private group order and provider hints for ordinary subscriptions', () => {
    const runtime = {
      'proxy-groups': [
        { name: 'automatic', url: 'https://example.com', use: ['provider'] },
        { name: 'managed' }
      ]
    } as unknown as IMihomoConfig
    const groups = runtimeProxyGroups(runtime, proxies, false, ['managed', 'GLOBAL'])
    expect(groups.map(({ group }) => group.name)).toEqual(['automatic', 'managed'])
    expect(groups[0]).toMatchObject({
      providers: ['provider'],
      group: { testUrl: 'https://example.com' }
    })
  })

  it('uses original provider order instead of the alphabetically encoded proxy map, including emoji names', () => {
    const names = ['🚀 节点选择', '手动切换', '♻️ 自动选择']
    const sorted = Object.fromEntries(
      ['GLOBAL', ...names].sort().map((name) => [name, { name, type: 'Selector', all: ['node'] }])
    )
    const live = {
      proxies: { ...sorted, node: { name: 'node', type: 'Trojan' } }
    } as unknown as IMihomoProxies
    const wrapper = { 'tizi-managed': {} } as unknown as IMihomoConfig
    const provider = { proxies: [{ name: 'node' }, ...names.map((name) => ({ name }))] }
    expect(
      runtimeProxyGroups(wrapper, live, false, orderedProviderNames(provider)).map(
        ({ group }) => group.name
      )
    ).toEqual([...names, 'GLOBAL'])
  })

  it('retains explicitly configured GLOBAL position and ignores missing or duplicate names without dropping groups', () => {
    const wrapper = { 'tizi-managed': {} } as unknown as IMihomoConfig
    expect(
      runtimeProxyGroups(wrapper, proxies, false, [
        'automatic',
        'GLOBAL',
        'missing',
        'automatic',
        'node'
      ]).map(({ group }) => group.name)
    ).toEqual(['automatic', 'GLOBAL', 'managed'])
    expect(
      runtimeProxyGroups(wrapper, proxies, false, ['hidden', 'managed', 'automatic']).map(
        ({ group }) => group.name
      )
    ).toEqual(['managed', 'automatic', 'GLOBAL'])
    expect(
      runtimeProxyGroups(wrapper, proxies, true, ['hidden', 'managed', 'automatic']).map(
        ({ group }) => group.name
      )
    ).toEqual(['hidden', 'managed', 'automatic', 'GLOBAL'])
  })

  it('falls back to GLOBAL member order when ordered provider metadata is unavailable', () => {
    const wrapper = { 'tizi-managed': {} } as unknown as IMihomoConfig
    const live = structuredClone(proxies)
    ;(live.proxies.GLOBAL as IMihomoGroup).all = [
      'automatic',
      'node',
      'missing',
      'managed',
      'automatic'
    ]
    expect(
      runtimeProxyGroups(wrapper, live, false, orderedProviderNames({ error: 'unavailable' })).map(
        ({ group }) => group.name
      )
    ).toEqual(['automatic', 'managed', 'GLOBAL'])
  })

  it('normalizes safe provider metadata without exposing or requiring raw config', () => {
    expect(
      orderedProviderNames({ proxies: ['first', { name: 'second' }, null, { notName: 'ignored' }] })
    ).toEqual(['first', 'second'])
    expect(orderedProviderNames({ proxies: [] })).toBeUndefined()
    expect(orderedProviderNames({ proxies: {} })).toBeUndefined()
  })
})
