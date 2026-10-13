import type { Workflow, Json } from '../shared/schema'
import { validateAction } from '../shared/catalog'
export function validateWorkflow(flow: Workflow, all: Workflow[]): string[] {
  const errors: string[] = []
  const nodes = new Map(flow.nodes.map((n) => [n.id, n]))
  if (nodes.size !== flow.nodes.length) errors.push('Node IDs must be unique')
  if (flow.nodes.filter((n) => n.kind === 'trigger').length !== 1)
    errors.push('Exactly one trigger is required')
  if (new Set(flow.edges.map((e) => e.id)).size !== flow.edges.length)
    errors.push('Edge IDs must be unique')
  const ports = new Set<string>()
  for (const e of flow.edges) {
    if (!nodes.has(e.source) || !nodes.has(e.target)) errors.push(`Dangling edge ${e.id}`)
    const key = e.source + ':' + e.port
    if (ports.has(key)) errors.push(`Only one connection is allowed on ${key}`)
    ports.add(key)
    const kind = nodes.get(e.source)?.kind
    const allowed =
      kind === 'condition'
        ? ['true', 'false', 'error']
        : kind === 'parallel'
          ? null
          : kind === 'repeat' || kind === 'foreach'
            ? ['body', 'next', 'error']
            : kind === 'switch'
              ? null
              : ['next', 'error']
    if (allowed && !allowed.includes(e.port)) errors.push(`Invalid port ${key}`)
  }
  const visiting = new Set<string>(),
    visited = new Set<string>()
  const visit = (id: string) => {
    if (visiting.has(id)) {
      errors.push('Canvas cycles are forbidden; use Repeat / For Each')
      return
    }
    if (visited.has(id)) return
    visiting.add(id)
    for (const e of flow.edges.filter((e) => e.source === id)) visit(e.target)
    visiting.delete(id)
    visited.add(id)
  }
  for (const n of flow.nodes) visit(n.id)
  const reachable = (start: string | undefined, seen = new Set<string>()): Set<string> => {
    if (!start || seen.has(start)) return seen
    seen.add(start)
    for (const e of flow.edges.filter((e) => e.source === start)) reachable(e.target, seen)
    return seen
  }
  for (const n of flow.nodes.filter((n) => ['parallel', 'repeat', 'foreach'].includes(n.kind))) {
    const bodies = flow.edges.filter(
      (e) => e.source === n.id && (e.port.startsWith('branch:') || e.port === 'body')
    )
    const continuation = reachable(
      flow.edges.find((e) => e.source === n.id && e.port === 'next')?.target
    )
    const owned = new Set<string>()
    for (const body of bodies)
      for (const id of reachable(body.target)) {
        if (continuation.has(id))
          errors.push(
            `${n.label}: body/branch cannot enter its continuation; connect next on the structured node`
          )
        if (owned.has(id))
          errors.push(
            `${n.label}: parallel branches must have separate nodes and join through next`
          )
        owned.add(id)
      }
  }
  const calls = (f: Workflow, chain: string[]) => {
    if (chain.includes(f.id)) {
      errors.push('Recursive subflow calls are forbidden')
      return
    }
    for (const n of f.nodes.filter((n) => n.kind === 'subflow' || n.action?.type === 'workflow')) {
      const id = String(n.config.workflowId ?? n.action?.config.workflowId ?? '')
      const child = all.find((w) => w.id === id)
      if (!child) errors.push(`Missing subflow at ${n.label}`)
      else {
        if (n.kind === 'subflow' && n.config.revision !== child.revision)
          errors.push(`Subflow revision mismatch at ${n.label}`)
        calls(child, [...chain, f.id])
      }
    }
  }
  calls(flow, [])
  for (const n of flow.nodes) {
    if (n.retries && !n.retrySafe)
      errors.push(`${n.label}: retry requires an explicit idempotency acknowledgement`)
    if (n.kind === 'action') {
      if (!n.action) errors.push(`${n.label}: select an action`)
      else if (!JSON.stringify(n.action.config).includes('{{'))
        try {
          validateAction(n.action)
        } catch (e) {
          errors.push(`${n.label}: ${String(e)}`)
        }
    }
    if (
      n.kind === 'delay' &&
      !(typeof n.config.ms === 'number' && n.config.ms >= 0 && n.config.ms <= 300000)
    )
      errors.push(`${n.label}: delay must be 0–300000 ms`)
    if (['repeat', 'foreach'].includes(n.kind)) {
      const max = n.config.maxIterations,
        concurrency = n.config.concurrency ?? 1
      if (typeof max !== 'number' || !Number.isInteger(max) || max < 1 || max > 1000)
        errors.push(`${n.label}: maxIterations must be 1–1000`)
      if (
        typeof concurrency !== 'number' ||
        !Number.isInteger(concurrency) ||
        concurrency < 1 ||
        concurrency > 16
      )
        errors.push(`${n.label}: concurrency must be 1–16`)
      if (!flow.edges.some((e) => e.source === n.id && e.port === 'body'))
        errors.push(`${n.label}: connect a body`)
    }
    if (
      n.kind === 'parallel' &&
      !flow.edges.some((e) => e.source === n.id && e.port.startsWith('branch:'))
    )
      errors.push(`${n.label}: connect at least one branch`)
    if (
      n.kind === 'condition' &&
      !['equals', 'notEquals', 'greater', 'less', 'contains', 'truthy'].includes(
        String(n.config.operator)
      )
    )
      errors.push(`${n.label}: choose a supported comparison`)
    // A referenced output must dominate the consumer on every possible incoming path.
    const ancestors = (id: string, seen = new Set<string>()): Set<string> => {
      if (seen.has(id)) return new Set()
      seen.add(id)
      const incoming = flow.edges.filter((e) => e.target === id)
      if (!incoming.length) return new Set()
      const sets = incoming.map((e) => new Set([e.source, ...ancestors(e.source, new Set(seen))]))
      return new Set([...sets[0]].filter((x) => sets.every((s) => s.has(x))))
    }
    const available = ancestors(n.id)
    for (const group of flow.nodes.filter((node) =>
      ['parallel', 'repeat', 'foreach'].includes(node.kind)
    )) {
      const bodies = flow.edges.filter(
        (e) => e.source === group.id && (e.port === 'body' || e.port.startsWith('branch:'))
      )
      if (bodies.some((e) => reachable(e.target).has(n.id))) available.delete(group.id)
    }
    const check = (v: Json) => {
      if (typeof v === 'string')
        for (const match of v.matchAll(/\{\{nodes\.([\w-]+)[^}|]*(\|[^}]*)?\}\}/g))
          if (!match[2] && !available.has(match[1]))
            errors.push(
              `${n.label}: output ${match[1]} is not available on every path; add a fallback`
            )
      if (Array.isArray(v)) v.forEach(check)
      else if (v && typeof v === 'object') Object.values(v).forEach(check)
    }
    check(n.config)
    if (n.action) check(n.action.config)
  }
  return [...new Set(errors)]
}
