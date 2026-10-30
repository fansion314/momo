import { describe, expect, it } from 'vitest'
import { resolveTiziBuildFeatures } from './build-features'

describe('formal release feature defaults', () => {
  it('enables tizi in ordinary packages without opting into test identity or bundled-core behavior', () => {
    expect(resolveTiziBuildFeatures({})).toEqual({ tiziEnabled: true, tiziTestBuild: false })
  })
  it('retains an explicit feature-off build without changing normal packaging identity', () => {
    expect(resolveTiziBuildFeatures({ MOMO_TIZI_ENABLED: 'false' })).toEqual({
      tiziEnabled: false,
      tiziTestBuild: false
    })
  })
  it('keeps the manual isolated test package explicit and refuses a contradictory disabled build', () => {
    expect(resolveTiziBuildFeatures({ MOMO_TIZI_TEST_BUILD: 'true' })).toEqual({
      tiziEnabled: true,
      tiziTestBuild: true
    })
    expect(() =>
      resolveTiziBuildFeatures({ MOMO_TIZI_ENABLED: 'false', MOMO_TIZI_TEST_BUILD: 'true' })
    ).toThrow('require')
  })
})
