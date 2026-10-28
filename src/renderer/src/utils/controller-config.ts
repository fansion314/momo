// These settings are consumed by the controller server at process startup.
export function needsControllerRestart(patch: Partial<IMihomoConfig>): boolean {
  return ['external-controller', 'external-ui', 'external-ui-url', 'secret'].some((key) =>
    Object.hasOwn(patch, key)
  )
}
