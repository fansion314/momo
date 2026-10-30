export function resolveTiziBuildFeatures(env: Record<string, string | undefined>): {
  tiziEnabled: boolean
  tiziTestBuild: boolean
} {
  const tiziEnabled = env.MOMO_TIZI_ENABLED !== 'false'
  const tiziTestBuild = env.MOMO_TIZI_TEST_BUILD === 'true'
  if (tiziTestBuild && !tiziEnabled)
    throw new Error('Tizi test builds require MOMO_TIZI_ENABLED=true')
  return { tiziEnabled, tiziTestBuild }
}
