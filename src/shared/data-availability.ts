import type { Graph } from "./schema";

/** The validator's existing dominator calculation. Output presence includes
 * recovered errors; callers must distinguish presence from successful shape. */
export function outputAvailability(g: Graph, outer = new Set<string>()) {
  const ids = new Set(g.nodes.map((n) => n.id));
  const incoming = new Map<string, string[]>();
  for (const e of g.edges)
    incoming.set(e.target, [...(incoming.get(e.target) ?? []), e.source]);
  const dominators = new Map<string, Set<string>>();
  for (const n of g.nodes)
    dominators.set(n.id, n.id === g.entry ? new Set() : new Set(ids));
  for (let i = 0; i < g.nodes.length; i++)
    for (const n of g.nodes.filter((n) => n.id !== g.entry)) {
      let common: Set<string> | undefined;
      for (const p of incoming.get(n.id) ?? []) {
        const set = new Set([...(dominators.get(p) ?? []), p]);
        common = common ? new Set([...common].filter((x) => set.has(x))) : set;
      }
      dominators.set(n.id, common ?? new Set());
    }
  return new Map(
    g.nodes.map((n) => [
      n.id,
      new Set([...outer, ...(dominators.get(n.id) ?? [])]),
    ]),
  );
}

export function reachable(g: Graph, from: string, to: string): boolean {
  const seen = new Set<string>(),
    pending = [from];
  while (pending.length) {
    const id = pending.pop()!;
    if (id === to) return true;
    if (seen.has(id)) continue;
    seen.add(id);
    pending.push(
      ...g.edges.filter((e) => e.source === id).map((e) => e.target),
    );
  }
  return false;
}

/** A dominating producer can still have returned structured error data. */
export function successfulOutput(g: Graph, producer: string, consumer: string) {
  return !g.edges.some(
    (e) =>
      e.source === producer &&
      e.port === "error" &&
      reachable(g, e.target, consumer),
  );
}
