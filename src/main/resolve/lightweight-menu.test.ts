import { describe, expect, it, vi } from 'vitest'
import { LightweightState } from '../lightweight'
import { createLightweightMenuItem } from './lightweight-menu'

describe('lightweight tray checkbox', () => {
  it('reflects completed mode entry and toggles back to the main window', async () => {
    const state = new LightweightState()
    const enter = vi.fn(async () => {
      state.enterIfCurrent(state.requestEntry())
    })
    const leave = vi.fn(() => state.leave())
    const refresh = vi.fn()
    const actions = { isActive: () => state.isActive, enter, leave, refresh, onError: vi.fn() }
    const build = (): Electron.MenuItemConstructorOptions =>
      createLightweightMenuItem('Lightweight mode', 'Ctrl+L', actions)
    const click = async (item: Electron.MenuItemConstructorOptions): Promise<void> => {
      await item.click?.({} as Electron.MenuItem, undefined, {} as Electron.KeyboardEvent)
    }

    expect(build()).toMatchObject({ type: 'checkbox', checked: false, accelerator: 'Ctrl+L' })
    await click(build())
    expect(enter).toHaveBeenCalledOnce()
    expect(build().checked).toBe(true)
    await click(build())
    expect(leave).toHaveBeenCalledOnce()
    expect(build().checked).toBe(false)
    expect(refresh).toHaveBeenCalledTimes(2)
  })

  it('resynchronizes the checkbox after entry fails instead of leaving it checked', async () => {
    const failure = new Error('tray unavailable')
    const actions = {
      isActive: () => false,
      enter: vi.fn().mockRejectedValue(failure),
      leave: vi.fn(),
      refresh: vi.fn(),
      onError: vi.fn()
    }
    const item = createLightweightMenuItem('Lightweight mode', '', actions)
    await item.click?.({} as Electron.MenuItem, undefined, {} as Electron.KeyboardEvent)
    expect(actions.onError).toHaveBeenCalledWith(failure)
    expect(actions.refresh).toHaveBeenCalledOnce()
    expect(actions.leave).not.toHaveBeenCalled()
    expect(createLightweightMenuItem('Lightweight mode', '', actions).checked).toBe(false)
  })
})
