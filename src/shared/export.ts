import type { Config, Json } from './schema'
export function exportConfig(config: Config): Config {
  const copy = structuredClone(config)
  const scrub = (value: Json): Json => {
    if (typeof value === 'string')
      return value
        .replace(/([?&](?:token|key|password|secret)=)[^&#\s]+/gi, '$1[redacted]')
        .replace(/(Bearer\s+)[\w.\-/+=]+/gi, '$1[redacted]')
    if (Array.isArray(value)) return value.map(scrub)
    if (value && typeof value === 'object')
      return Object.fromEntries(
        Object.entries(value).map(([key, val]) => [
          key,
          /^(?:password|secret|token|authorization|cookie|api.?key)$/i.test(key)
            ? '[redacted]'
            : scrub(val)
        ])
      )
    return value
  }
  for (const p of copy.profiles)
    for (const page of p.pages)
      for (const b of Object.values(page.keys))
        for (const action of [...b.actions, ...b.release, ...b.longPress])
          action.config = scrub(action.config) as Record<string, Json>
  for (const flow of copy.workflows)
    for (const node of flow.nodes) {
      node.config = scrub(node.config) as Record<string, Json>
      if (node.action) node.action.config = scrub(node.action.config) as Record<string, Json>
    }
  copy.connections = copy.connections.map(({ credentialRef, ...c }) => c)
  return copy
}
