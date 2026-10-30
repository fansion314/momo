import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { SWRConfig } from 'swr'
import { describe, expect, it, vi } from 'vitest'
import type { TiziStatus } from '../../../shared/tizi'
import TiziPage from './tizi'

vi.mock('@renderer/components/base/base-page', () => ({
  default: ({ children }: { children: React.ReactNode }) => <main>{children}</main>
}))

function render(status?: TiziStatus): string {
  return renderToStaticMarkup(
    <SWRConfig
      value={{ provider: () => new Map(), fallback: status ? { 'tizi/local-status': status } : {} }}
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
})
