import {
  findWorkflow,
  resolveWorkflowId,
  type WorkflowAliases,
} from "../shared/workflow-identity";
import { actionById } from "../shared/catalog";
import type { Graph, Json, WorkflowDefinition } from "../shared/schema";
export function validateWorkflow(
  workflow: WorkflowDefinition,
  all: WorkflowDefinition[],
  aliases: WorkflowAliases = {},
): string[] {
  const errors: string[] = [];
  const calls = new Set<string>();
  function graph(g: Graph, prefix: string, outerAvailable = new Set<string>()) {
    const ids = new Set(g.nodes.map((n) => n.id));
    if (ids.size !== g.nodes.length)
      errors.push(`${prefix}: duplicate node IDs`);
    if (!ids.has(g.entry)) errors.push(`${prefix}: entry node missing`);
    const incoming = new Map<string, string[]>();
    for (const e of g.edges) {
      if (!ids.has(e.source) || !ids.has(e.target))
        errors.push(`${prefix}: dangling edge ${e.id}`);
      incoming.set(e.target, [...(incoming.get(e.target) ?? []), e.source]);
    }
    const visiting = new Set<string>(),
      visited = new Set<string>();
    function walk(id: string) {
      if (visiting.has(id)) {
        errors.push(`${prefix}: back-edges are not allowed; use Repeat`);
        return;
      }
      if (visited.has(id)) return;
      visiting.add(id);
      for (const e of g.edges.filter((e) => e.source === id)) walk(e.target);
      visiting.delete(id);
      visited.add(id);
    }
    walk(g.entry);
    for (const n of g.nodes)
      if (!visited.has(n.id))
        errors.push(`${prefix}: ${n.name} is unreachable`);
    const dominators = new Map<string, Set<string>>();
    for (const n of g.nodes)
      dominators.set(n.id, n.id === g.entry ? new Set() : new Set(ids));
    for (let i = 0; i < g.nodes.length; i++)
      for (const n of g.nodes.filter((n) => n.id !== g.entry)) {
        const parents = incoming.get(n.id) ?? [];
        let common: Set<string> | undefined;
        for (const p of parents) {
          const set = new Set([...(dominators.get(p) ?? []), p]);
          common = common
            ? new Set([...common].filter((x) => set.has(x)))
            : set;
        }
        dominators.set(n.id, common ?? new Set());
      }
    const refs = (value: Json, available: Set<string>, label: string) => {
      if (Array.isArray(value)) value.forEach((v) => refs(v, available, label));
      else if (value && typeof value === "object") {
        if (typeof value.$ref === "string") {
          const [root, key] = value.$ref.split(".");
          if (
            root === "outputs" &&
            !available.has(key) &&
            !Object.hasOwn(value, "fallback")
          )
            errors.push(
              `${label}: output ${key} is not available on every path; add a fallback`,
            );
          if (
            value.$ref
              .split(".")
              .some((p) =>
                ["__proto__", "constructor", "prototype"].includes(p),
              )
          )
            errors.push(`${label}: unsafe data path`);
        } else Object.values(value).forEach((v) => refs(v, available, label));
      }
    };
    for (const n of g.nodes) {
      const label = `${prefix} / ${n.name}`,
        available = new Set([
          ...outerAvailable,
          ...(dominators.get(n.id) ?? []),
        ]);
      refs(n.config, available, label);
      if (n.action) refs(n.action.config, available, label);
      const allowedPorts =
        n.kind === "condition"
          ? ["true", "false", "error"]
          : n.kind === "switch"
            ? [
                ...(Array.isArray(n.config.cases)
                  ? n.config.cases.map(String)
                  : []),
                "default",
                "error",
              ]
            : n.kind === "return"
              ? []
              : ["next", "error"];
      for (const edge of g.edges.filter((e) => e.source === n.id))
        if (!allowedPorts.includes(edge.port))
          errors.push(`${label}: invalid output port ${edge.port}`);
      const ports = g.edges.filter((e) => e.source === n.id).map((e) => e.port);
      if (new Set(ports).size !== ports.length)
        errors.push(
          `${label}: only one edge per output is allowed; use Parallel`,
        );
      if (n.kind === "action") {
        const def = n.action && actionById(n.action.type);
        if (!def) errors.push(`${label}: unknown action`);
        else {
          if (n.action!.version !== def.version)
            errors.push(`${label}: unsupported action version`);
          const literal = Object.values(n.action!.config).every(
            (v) => !v || typeof v !== "object",
          );
          if (literal) {
            const result = def.schema.safeParse(n.action!.config);
            if (!result.success)
              errors.push(
                `${label}: ${result.error.issues.map((i) => i.path.join(".") + " " + i.message).join(", ")}`,
              );
          }
          if (n.retries && !def.idempotent && !n.retrySafe)
            errors.push(
              `${label}: retries require explicit confirmation for this side effect`,
            );
        }
        for (const field of def?.fields ?? []) {
          if (field.type !== "workflow") continue;
          const ref = n.action!.config[field.key];
          if (typeof ref === "string") {
            if (n.action!.type === "workflow.run")
              calls.add(resolveWorkflowId(ref, aliases));
            else if (!findWorkflow(all, ref, aliases))
              errors.push(`${label}: missing workflow`);
          } else if (
            !ref ||
            Array.isArray(ref) ||
            typeof ref !== "object" ||
            typeof ref.$ref !== "string"
          )
            errors.push(`${label}: use a workflow choice or data reference`);
        }
      }
      if (n.kind === "subflow") {
        const ref = n.config.workflowId;
        if (typeof ref === "string") {
          calls.add(resolveWorkflowId(ref, aliases));
          const child = findWorkflow(all, ref, aliases);
          if (child && n.config.revision !== child.revision)
            errors.push(
              `${label}: pin the current subflow revision (${child.revision})`,
            );
        } else if (
          !ref ||
          Array.isArray(ref) ||
          typeof ref !== "object" ||
          typeof ref.$ref !== "string"
        )
          errors.push(`${label}: missing subflow reference`);
      }
      if (n.kind === "repeat" || n.kind === "foreach") {
        if (!n.body) errors.push(`${label}: missing loop body`);
        if (
          !Number.isInteger(n.config.maxIterations) ||
          Number(n.config.maxIterations) < 1 ||
          Number(n.config.maxIterations) > 1000
        )
          errors.push(`${label}: maximum iterations must be 1–1000`);
        if (
          n.kind === "foreach" &&
          (Number(n.config.concurrency ?? 1) < 1 ||
            Number(n.config.concurrency ?? 1) > 16)
        )
          errors.push(`${label}: concurrency must be 1–16`);
      }
      if (n.kind === "parallel" && !n.branches?.length)
        errors.push(`${label}: add at least one branch`);
      if (n.body) graph(n.body, label, available);
      n.branches?.forEach((b, i) =>
        graph(b, `${label} / branch ${i + 1}`, available),
      );
    }
  }
  graph(workflow.graph, workflow.name);
  const scanCalls = (g: Graph): string[] =>
    g.nodes.flatMap((n) => [
      ...(n.kind === "subflow" && typeof n.config.workflowId === "string"
        ? [resolveWorkflowId(n.config.workflowId, aliases)]
        : n.action?.type === "workflow.run" &&
            typeof n.action.config.workflowId === "string"
          ? [resolveWorkflowId(n.action.config.workflowId, aliases)]
          : []),
      ...(n.body ? scanCalls(n.body) : []),
      ...(n.branches?.flatMap(scanCalls) ?? []),
    ]);
  const checked = new Set([workflow.id]);
  function visit(id: string, path: string[]) {
    if (path.includes(id)) {
      errors.push(`Recursive subflow: ${[...path, id].join(" → ")}`);
      return;
    }
    const f = all.find((w) => w.id === id);
    if (!f) {
      errors.push(`Missing subflow: ${id}`);
      return;
    }
    if (!checked.has(id)) {
      checked.add(id);
      graph(f.graph, f.name);
    }
    for (const ref of scanCalls(f.graph)) visit(ref, [...path, id]);
  }
  for (const ref of calls) visit(ref, [workflow.id]);
  return [...new Set(errors)];
}
