import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { SWRConfig, unstable_serialize } from 'swr'
import { describe, expect, it, vi } from 'vitest'
import type { TiziStatus, TiziUsage } from '../../../shared/tizi'
import TiziPage from './tizi'

vi.mock('@renderer/components/base/base-page', () => ({
  default: ({ children }: { children: React.ReactNode }) => <main>{children}</main>
}))

function render(status?: TiziStatus, usage?: TiziUsage, error?: Error): string {
  const usageKey = unstable_serialize(['tizi/usage', status?.device_id])
  return renderToStaticMarkup(
    <SWRConfig
      value={{
        provider: () => new Map(error ? [[usageKey, { data: usage, error }]] : []),
        fallback: {
          ...(status ? { 'tizi/local-status': status } : {}),
          ...(usage ? { [usageKey]: usage } : {})
        }
      }}
    >
      <TiziPage />
    </SWRConfig>
  )
}

describe('tizi account loading', () => {
  it('shows loading instead of a login form before local session state is known', () => {
    const html = render()
    expect(html).toContain('正在读取登录状态')
    expect(html).not.toContain('登录并绑定设备')
    expect(html).not.toContain('申请注册')
  })

  it('keeps a cached authenticated view while remote usage is still loading', () => {
    const html = render({
      supported: true,
      keyReady: true,
      logged_in: true,
      active: false,
      email: 'fixture@example.test',
      device_id: 'fixture-device'
    })
    expect(html).toContain('fixture@example.test')
    expect(html).toContain('使用团购订阅')
    expect(html).toContain('退出登录')
    expect(html).not.toContain('登录并绑定设备')
    expect(html).not.toContain('申请注册')
  })

  it('shows login only after local state confirms the user is logged out', () => {
    const html = render({ supported: true, keyReady: true, logged_in: false, active: false })
    expect(html).toContain('登录并绑定设备')
    expect(html).toContain('申请注册')
    expect(html).not.toContain('退出登录')
  })

  const active: TiziStatus = {
    supported: true,
    keyReady: true,
    logged_in: true,
    active: true,
    device_id: 'fixture-device',
    email: 'fixture@example.test'
  }
  const emptyUsage: TiziUsage = { email: 'fixture@example.test', days: [], cycles: [], devices: [] }

  it('treats a successful empty first-use result as empty history rather than a network error', () => {
    const html = render(active, emptyUsage)
    expect(html).toContain('暂无已上报记录')
    expect(html).not.toContain('用量更新失败')
    expect(html).not.toContain('尚未取得服务端用量数据')
  })

  it('describes first-request failure without pretending there was cached usage', () => {
    const html = render(
      active,
      undefined,
      new Error('Tizi service is unreachable: cached subscription remains available')
    )
    expect(html).toContain('尚未取得服务端用量数据')
    expect(html).toContain('检查网络和 DNS 设置')
    expect(html).not.toContain('上次成功获取的数据')
    expect(html).not.toContain('登录并绑定设备')
    expect(html).toContain('正在使用团购订阅')
  })

  it('retains authenticated selection and distinguishes stale usage from a successful empty response', () => {
    const html = render(active, emptyUsage, new Error('Tizi service is unreachable'))
    expect(html).toContain('当前显示上次成功获取的数据')
    expect(html).toContain('返回私人订阅')
    expect(html).not.toContain('登录并绑定设备')
  })

  it('explains that an old copied kernel needs upgrading instead of silently ignoring Smart settings', () => {
    expect(render(active)).toContain('当前内核尚不支持完整的团购 DNS 和 Smart 设置')
    expect(render({ ...active, managed_config_version: 2 })).not.toContain(
      '当前内核尚不支持完整的团购 DNS 和 Smart 设置'
    )
  })
})
