import { describe, expect, it } from 'vitest'
import { normalizeRuntimeAppConfig, normalizeZoomFactor, parseZoomFactor } from './appConfig'

describe('window zoom', () => {
  it('accepts explicit percentages and factors with hundredth precision', () => {
    expect(parseZoomFactor('125%')).toBe(1.25)
    expect(parseZoomFactor('1.25')).toBe(1.25)
    expect(parseZoomFactor(' 50 % ')).toBe(0.5)
    expect(parseZoomFactor('2.00')).toBe(2)
    expect(normalizeZoomFactor(1.234)).toBe(1.23)
  })

  it('rejects malformed and out of range input without changing stored zoom', () => {
    for (const input of ['', 'abc', '100', '0.49', '201%', '1.2abc', 'Infinity', '-1']) {
      expect(parseZoomFactor(input)).toBeNull()
    }
    for (const value of [NaN, Infinity, undefined, '1.5']) {
      expect(normalizeZoomFactor(value)).toBe(1)
    }
    expect(normalizeZoomFactor(0.1)).toBe(0.5)
    expect(normalizeZoomFactor(4)).toBe(2)
  })
})

describe('system runtime config migration', () => {
  it.each(['mihomo', 'mihomo-alpha', 'mihomo-smart', 'mihomo-specific'])(
    'migrates %s to the system Smart core without changing the override preference',
    (core) => {
      const config = normalizeRuntimeAppConfig({
        core,
        enableSmartCore: false,
        enableSmartOverride: false,
        specificVersion: 'v1',
        autoQuitWithoutCoreMode: 'core'
      } as unknown as IAppConfig)
      expect(config.core).toBe('mihomomo')
      expect(config.enableSmartCore).toBe(true)
      expect(config.enableSmartOverride).toBe(false)
      expect(config.specificVersion).toBeUndefined()
      expect(config.autoQuitWithoutCoreMode).toBe('tray')
      expect(config.autoQuitWithoutCoreDelay).toBe(60)
      expect(config.zoomFactor).toBe(1)
      expect(config.trafficHistoryRetentionDays).toBe(30)
      expect(config.autoCheckUpdate).toBe(false)
    }
  )

  it('preserves valid retention and zoom and repairs invalid persisted values', () => {
    const config = normalizeRuntimeAppConfig({
      zoomFactor: 1.37,
      trafficHistoryRetentionDays: 120,
      autoQuitWithoutCoreDelay: 0
    } as IAppConfig)
    expect(config.zoomFactor).toBe(1.37)
    expect(config.trafficHistoryRetentionDays).toBe(120)
    expect(config.autoQuitWithoutCoreDelay).toBe(0)
    config.trafficHistoryRetentionDays = -1
    config.autoQuitWithoutCoreDelay = NaN
    normalizeRuntimeAppConfig(config)
    expect(config.trafficHistoryRetentionDays).toBe(30)
    expect(config.autoQuitWithoutCoreDelay).toBe(60)
  })
})
