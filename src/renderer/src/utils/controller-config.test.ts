import { describe, expect, it } from 'vitest'
import { needsControllerRestart } from './controller-config'

describe('controller configuration', () => {
  it('restarts for controller listener and authentication changes, including clearing them', () => {
    expect(needsControllerRestart({ 'external-controller': '127.0.0.1:9097' })).toBe(true)
    expect(needsControllerRestart({ 'external-controller': '' })).toBe(true)
    expect(needsControllerRestart({ secret: '' })).toBe(true)
    expect(needsControllerRestart({ 'external-ui': 'ui' })).toBe(true)
    expect(needsControllerRestart({ 'external-ui-url': '' })).toBe(true)
  })

  it('allows unrelated settings to use hot reload', () => {
    expect(needsControllerRestart({ 'mixed-port': 7890 })).toBe(false)
  })
})
