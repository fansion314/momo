import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  config: { enableTrafficLogger: true, trafficHistoryRetentionDays: 30 } as IAppConfig,
  running: true,
  reload: vi.fn(),
  patch: vi.fn()
}))
vi.mock('./mihomoApi', () => ({ getAxios: vi.fn(), mihomoHotReloadConfig: () => mocks.reload() }))
vi.mock('./manager', () => ({ hasCoreProcess: () => mocks.running }))
vi.mock('../config/app', () => ({
  getAppConfig: async () => structuredClone(mocks.config),
  patchAppConfig: (patch: Partial<IAppConfig>) => mocks.patch(patch)
}))

beforeEach(() => {
  vi.resetModules()
  mocks.running = true
  mocks.config = { enableTrafficLogger: true, trafficHistoryRetentionDays: 30 } as IAppConfig
  mocks.reload.mockReset().mockResolvedValue(undefined)
  mocks.patch.mockReset().mockImplementation(async (patch) => {
    Object.assign(mocks.config, patch)
  })
})

describe('history settings apply to the running kernel', () => {
  it('applies enable and retention changes and avoids reloads for UI-only changes', async () => {
    const { patchAppConfigWithHistory } = await import('./traffic-history')
    await patchAppConfigWithHistory({ enableTrafficLogger: false })
    expect(mocks.reload).toHaveBeenCalledOnce()
    await patchAppConfigWithHistory({ trafficHistoryRetentionDays: 60 })
    expect(mocks.reload).toHaveBeenCalledTimes(2)
    await patchAppConfigWithHistory({ zoomFactor: 1.2 })
    await patchAppConfigWithHistory({ enableTrafficLogger: false })
    expect(mocks.reload).toHaveBeenCalledTimes(2)
  })

  it('persists preferences for the next startup when the kernel is absent', async () => {
    const { patchAppConfigWithHistory } = await import('./traffic-history')
    mocks.running = false
    await patchAppConfigWithHistory({ enableTrafficLogger: false })
    expect(mocks.config.enableTrafficLogger).toBe(false)
    expect(mocks.reload).not.toHaveBeenCalled()
  })

  it('serializes rapid disable and enable so the second reload cannot overtake the first', async () => {
    const { patchAppConfigWithHistory } = await import('./traffic-history')
    let finishReload!: () => void
    mocks.reload.mockReturnValueOnce(
      new Promise<void>((resolve) => {
        finishReload = resolve
      })
    )
    const disable = patchAppConfigWithHistory({ enableTrafficLogger: false })
    const enable = patchAppConfigWithHistory({ enableTrafficLogger: true })
    for (let i = 0; i < 8; ++i) await Promise.resolve()
    expect(mocks.patch).toHaveBeenCalledTimes(1)
    expect(mocks.config.enableTrafficLogger).toBe(false)
    finishReload()
    await Promise.all([disable, enable])
    expect(mocks.config.enableTrafficLogger).toBe(true)
    expect(mocks.reload).toHaveBeenCalledTimes(2)
  })

  it('reports apply failures and keeps the queue usable for retry', async () => {
    const { patchAppConfigWithHistory } = await import('./traffic-history')
    mocks.reload.mockRejectedValueOnce(new Error('kernel unavailable'))
    await expect(patchAppConfigWithHistory({ enableTrafficLogger: false })).rejects.toThrow(
      'kernel unavailable'
    )
    expect(mocks.config.enableTrafficLogger).toBe(true)
    await expect(patchAppConfigWithHistory({ enableTrafficLogger: false })).resolves.toBeUndefined()
    expect(mocks.reload).toHaveBeenCalledTimes(3)
  })

  it('rolls back both history preferences while preserving unrelated saved settings', async () => {
    const { patchAppConfigWithHistory } = await import('./traffic-history')
    const applied: Partial<IAppConfig>[] = []
    mocks.reload.mockImplementation(async () => {
      applied.push(structuredClone(mocks.config))
      if (applied.length === 1) throw new Error('apply rejected')
    })
    await expect(
      patchAppConfigWithHistory({
        enableTrafficLogger: false,
        trafficHistoryRetentionDays: 90,
        zoomFactor: 1.25
      })
    ).rejects.toThrow('apply rejected')
    expect(
      applied.map((config) => [config.enableTrafficLogger, config.trafficHistoryRetentionDays])
    ).toEqual([
      [false, 90],
      [true, 30]
    ])
    expect(mocks.config).toMatchObject({
      enableTrafficLogger: true,
      trafficHistoryRetentionDays: 30,
      zoomFactor: 1.25
    })
  })

  it('does not run rollback when the initial preference write fails', async () => {
    const { patchAppConfigWithHistory } = await import('./traffic-history')
    mocks.patch.mockRejectedValueOnce(new Error('disk full'))
    await expect(patchAppConfigWithHistory({ enableTrafficLogger: false })).rejects.toThrow(
      'disk full'
    )
    expect(mocks.patch).toHaveBeenCalledOnce()
    expect(mocks.reload).not.toHaveBeenCalled()
  })

  it('reports unconfirmed capture state if restoring preferences cannot be saved', async () => {
    const { patchAppConfigWithHistory } = await import('./traffic-history')
    mocks.reload.mockRejectedValueOnce(new Error('apply rejected'))
    mocks.patch
      .mockImplementationOnce(async (patch) => {
        Object.assign(mocks.config, patch)
      })
      .mockRejectedValueOnce(new Error('rollback disk full'))
    await expect(patchAppConfigWithHistory({ enableTrafficLogger: false })).rejects.toThrow(
      'capture state is unconfirmed'
    )
    await expect(patchAppConfigWithHistory({ enableTrafficLogger: true })).resolves.toBeUndefined()
  })

  it('reports unconfirmed capture state if the restored runtime cannot be reapplied', async () => {
    const { patchAppConfigWithHistory } = await import('./traffic-history')
    mocks.reload
      .mockRejectedValueOnce(new Error('apply rejected'))
      .mockRejectedValueOnce(new Error('rollback rejected'))
    await expect(patchAppConfigWithHistory({ enableTrafficLogger: false })).rejects.toThrow(
      'capture state is unconfirmed'
    )
    expect(mocks.config.enableTrafficLogger).toBe(true)
    await expect(patchAppConfigWithHistory({ enableTrafficLogger: false })).resolves.toBeUndefined()
    expect(mocks.reload).toHaveBeenCalledTimes(3)
  })
})
