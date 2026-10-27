import { describe, expect, it, vi } from 'vitest'
import { LightweightState } from './lightweight'

describe('lightweight lifecycle state', () => {
  it('does not allow a pending automatic entry to win after a tray reopen', () => {
    const state = new LightweightState()
    const notify = vi.fn()
    state.subscribe(notify)
    const entry = state.requestEntry()
    state.leave()
    expect(state.enterIfCurrent(entry)).toBe(false)
    expect(state.isActive).toBe(false)
    expect(notify.mock.calls).toEqual([[false]])
  })

  it('notifies stream subscribers once per actual transition and supports cleanup', () => {
    const state = new LightweightState()
    const notify = vi.fn()
    const unsubscribe = state.subscribe(notify)
    const entry = state.requestEntry()
    state.enterIfCurrent(entry)
    state.enterIfCurrent(entry)
    state.leave()
    state.leave()
    expect(notify.mock.calls).toEqual([[false], [true], [false]])
    unsubscribe()
    state.enterIfCurrent(state.requestEntry())
    expect(notify).toHaveBeenCalledTimes(3)
  })
})
