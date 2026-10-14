import { parsePath } from "./data-contract";
import type { GraphPath } from "./data-presentation";
import type {
  Json,
  NodeExecutionRecord,
  RunRecord,
  WorkflowDefinition,
} from "./schema";
import { resolveWorkflowId, type WorkflowAliases } from "./workflow-identity";

/** Match the whole runtime graph path, never a substring or a node ID alone. */
export function matchesGraphPath(
  runtimePath: string,
  workflowId: string,
  path: GraphPath,
) {
  let positions = [workflowId];
  for (const step of path) {
    if (step.branch !== undefined)
      positions = positions.map(
        (p) => `${p}/${step.nodeId}/branch:${step.branch}`,
      );
    else {
      // Runtime loop suffix is a nonnegative decimal index; IDs may contain dots/slashes.
      const prefixes = positions.map((p) => `${p}/${step.nodeId}/iteration:`);
      const next: string[] = [];
      for (const prefix of prefixes) {
        if (!runtimePath.startsWith(prefix)) continue;
        const index = runtimePath
          .slice(prefix.length)
          .match(/^(0|[1-9]\d*)(?=\/|$)/)?.[0];
        if (index !== undefined) next.push(prefix + index);
      }
      positions = next;
    }
  }
  return positions.includes(runtimePath);
}
export function previewLocation(
  workflow: WorkflowDefinition,
  path: GraphPath,
  runtimePath: string,
  runtimeRoot = workflow.id,
) {
  let graph = workflow.graph,
    prefix = runtimeRoot;
  const labels: string[] = [];
  for (const step of path) {
    const parent = graph.nodes.find((n) => n.id === step.nodeId);
    if (step.branch !== undefined) {
      labels.push(
        `${parent?.name ?? "Previous node"} / branch ${step.branch + 1}`,
      );
      prefix += `/${step.nodeId}/branch:${step.branch}`;
      graph = parent?.branches?.[step.branch] ?? graph;
    } else {
      prefix += `/${step.nodeId}/iteration:`;
      const index = runtimePath
        .slice(prefix.length)
        .match(/^(0|[1-9]\d*)(?=\/|$)/)?.[0];
      labels.push(
        `${parent?.name ?? "Previous loop"} / iteration ${index === undefined ? "unknown" : Number(index) + 1}`,
      );
      prefix += index ?? "";
      graph = parent?.body ?? graph;
    }
  }
  return labels.join(" → ").slice(0, 512) || "Root graph";
}
export function lastNodePreview(
  runs: RunRecord[],
  workflow: WorkflowDefinition,
  path: GraphPath,
  nodeId: string,
  aliases: WorkflowAliases = {},
) {
  const run = runs
    .filter(
      (r) =>
        resolveWorkflowId(r.workflowId, aliases) === workflow.id &&
        r.status !== "running",
    )
    .reduce<RunRecord | undefined>(
      (latest, r) => (!latest || r.startedAt >= latest.startedAt ? r : latest),
      undefined,
    );
  if (!run) return { run: undefined, records: [], stale: false };
  const records = run.nodes
    .filter(
      (n) =>
        n.nodeId === nodeId && matchesGraphPath(n.path, run.workflowId, path),
    )
    .slice(-50);
  return { run, records, stale: run.revision !== workflow.revision };
}
/** Extra display bounds over already-sanitized history. Never reads live scopes. */
export function previewText(value: unknown) {
  let visits = 0,
    remaining = 6000,
    limited = false,
    redacted = false;
  const visit = (v: unknown, depth: number): Json => {
    if (++visits > 120 || depth > 5 || remaining < 32) {
      limited = true;
      return "[preview limited]";
    }
    if (typeof v === "string") {
      redacted ||= v.includes("[redacted]");
      limited ||= /\[(?:size|depth) limited\]/.test(v);
      const size = Math.min(v.length, 512, remaining);
      remaining -= size;
      if (size < v.length) {
        limited = true;
        return v.slice(0, size) + "…";
      }
      return v;
    }
    if (v === null || typeof v === "number" || typeof v === "boolean") {
      remaining -= 8;
      return v;
    }
    if (!v || typeof v !== "object") return "[missing data]";
    const result: Record<string, Json> = {};
    const keys = Object.keys(v);
    if (keys.length > 20) limited = true;
    for (const key of keys.slice(0, 20)) {
      if (remaining < 32 || visits >= 120) {
        limited = true;
        break;
      }
      const d = Object.getOwnPropertyDescriptor(v, key);
      if (key === "truncated" && d && "value" in d && d.value === true)
        limited = true;
      remaining -= Math.min(key.length, 128) + 4;
      if (!d || !("value" in d)) {
        limited = true;
        continue;
      }
      // Defense in depth only; upstream run records are the redaction boundary.
      if (
        /authorization|cookie|password|token|secret|credential|api.?key/i.test(
          key,
        )
      ) {
        result[key.slice(0, 128)] = "[redacted]";
        redacted = true;
      } else result[key.slice(0, 128)] = visit(d.value, depth + 1);
    }
    return Array.isArray(v) ? Object.values(result) : result;
  };
  const text = JSON.stringify(visit(value, 0), null, 2);
  return {
    text: text.slice(0, 8000),
    limited: limited || text.length > 8000,
    redacted,
  };
}
export function samplePaths(
  record: NodeExecutionRecord,
): (string | number)[][] {
  const paths: (string | number)[][] = [];
  let visits = 0;
  const walk = (value: unknown, path: (string | number)[], depth: number) => {
    if (
      ++visits > 100 ||
      depth > 4 ||
      paths.length >= 30 ||
      !value ||
      typeof value !== "object"
    )
      return;
    for (const key of Object.keys(value).slice(0, 20)) {
      const next = [...path, Array.isArray(value) ? Number(key) : key];
      try {
        parsePath(next);
      } catch {
        continue;
      }
      const d = Object.getOwnPropertyDescriptor(value, key);
      if (
        !d ||
        !("value" in d) ||
        /authorization|cookie|password|token|secret|credential|api.?key/i.test(
          key,
        )
      )
        continue;
      if (paths.length >= 30) break;
      paths.push(next);
      walk(d.value, next, depth + 1);
    }
  };
  walk(record.output, [], 0);
  return paths;
}
