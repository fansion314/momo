export function orderedProviderNames(value: unknown): string[] | undefined {
  if (!value || typeof value !== 'object' || !('proxies' in value) || !Array.isArray(value.proxies))
    return undefined
  const names = value.proxies.flatMap((proxy: unknown) => {
    if (typeof proxy === 'string') return [proxy]
    if (proxy && typeof proxy === 'object' && 'name' in proxy && typeof proxy.name === 'string')
      return [proxy.name]
    return []
  })
  return names.length ? names : undefined
}

export function runtimeProxyGroups(
  runtime: IMihomoConfig,
  proxies: IMihomoProxies,
  includeHidden: boolean,
  orderedNames?: readonly string[]
): { group: IMihomoGroup; providers: string[] }[] {
  if (Object.prototype.hasOwnProperty.call(runtime, 'tizi-managed')) {
    // The default provider keeps YAML order; the /proxies object is sorted by name during JSON encoding.
    const global = proxies.proxies.GLOBAL
    const preferred = orderedNames ?? (global && 'all' in global ? global.all : [])
    const seen = new Set<string>()
    const groups: { group: IMihomoGroup; providers: string[] }[] = []
    const append = (name: string): void => {
      if (seen.has(name)) return
      seen.add(name)
      const proxy = proxies.proxies[name]
      if (proxy && 'all' in proxy && (includeHidden || !proxy.hidden))
        groups.push({ group: proxy as IMihomoGroup, providers: [] })
    }
    for (const name of preferred) append(name)
    for (const name of Object.keys(proxies.proxies)) if (name !== 'GLOBAL') append(name)
    append('GLOBAL')
    return groups
  }
  return (runtime?.['proxy-groups'] ?? []).flatMap(
    (group: { name: string; url?: string; use?: string[] }) => {
      const proxy = proxies.proxies[group.name]
      return proxy && 'all' in proxy && (includeHidden || !proxy.hidden)
        ? [{ group: { ...proxy, testUrl: group.url } as IMihomoGroup, providers: group.use || [] }]
        : []
    }
  )
}
