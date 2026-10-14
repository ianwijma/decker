import { createActor, fromPromise } from "xstate";
import { setTimeout as sleep } from "node:timers/promises";
import { randomUUID } from "node:crypto";
import type {
  ActionInstance,
  FlowNode,
  Graph,
  Json,
  NodeExecutionRecord,
  RunRecord,
  WorkflowDefinition,
} from "../shared/schema";
import { checkCondition, redact, resolve, type Scope } from "./data";
import { withCancellation } from "./cancellation";
import { validateWorkflow } from "./validate";
export type ActionContext = {
  signal: AbortSignal;
  runId: string;
  bindingId?: string;
  generation?: number;
  workflowId: string;
  deckId?: string;
};
export type Handler = (
  action: ActionInstance,
  context: ActionContext,
) => Promise<Json>;
export type RunHandle = {
  record: RunRecord;
  cancel: () => void;
  done: Promise<RunRecord>;
};
export class Engine {
  constructor(
    private handler: Handler,
    private emit: (record: RunRecord) => void,
    private secrets: () => string[] = () => [],
  ) {}
  start(
    definition: WorkflowDefinition,
    definitions: WorkflowDefinition[],
    inputs: Record<string, Json> = {},
    binding?: { bindingId?: string; generation?: number; deckId?: string },
  ): RunHandle {
    const workflow = structuredClone(definition),
      all = structuredClone(definitions),
      issues = validateWorkflow(workflow, all);
    if (issues.length) throw new Error(issues.join("\n"));
    for (const input of workflow.inputs)
      if (!Object.hasOwn(inputs, input))
        throw new Error(`Missing workflow input: ${input}`);
    const controller = new AbortController(),
      deadline = AbortSignal.timeout(workflow.timeoutMs),
      signal = AbortSignal.any([controller.signal, deadline]);
    const record: RunRecord = {
      id: randomUUID(),
      workflowId: workflow.id,
      workflowName: workflow.name,
      revision: workflow.revision,
      ...binding,
      startedAt: Date.now(),
      status: "running",
      nodes: [],
    };
    const publish = () => {
      while (record.nodes.length > 1 && JSON.stringify(record).length > 256000)
        record.nodes.shift();
      this.emit(structuredClone(record));
    };
    let steps = 0;
    const safe = (v: unknown) => redact(v, this.secrets());
    const runGraph = async (
      g: Graph,
      scope: Scope,
      parentSignal: AbortSignal,
      path: string,
    ): Promise<Json> => {
      let current: string | undefined = g.entry,
        last: Json = null;
      while (current) {
        parentSignal.throwIfAborted();
        if (steps % 32 === 31)
          await sleep(0, undefined, { signal: parentSignal });
        if (++steps > 10000)
          throw new Error("Run exceeded the 10,000 node budget");
        const n: FlowNode = g.nodes.find((n) => n.id === current)!;
        if (!n) throw new Error("Missing node");
        let port = "next",
          output: Json = null;
        const nodeSignal = AbortSignal.any([
          parentSignal,
          AbortSignal.timeout(n.timeoutMs),
        ]);
        for (let attempt = 0; attempt <= n.retries; attempt++) {
          const trace: NodeExecutionRecord = {
            id: randomUUID(),
            nodeId: n.id,
            name: n.name,
            path,
            startedAt: Date.now(),
            status: "running",
            attempt,
          };
          record.nodes.push(trace);
          if (record.nodes.length > 1000)
            record.nodes.splice(0, record.nodes.length - 1000);
          publish();
          try {
            nodeSignal.throwIfAborted();
            const c = resolve(n.config, scope) as Record<string, Json>;
            trace.input = safe(n.action ? resolve(n.action.config, scope) : c);
            const child = async (
              id: string,
              childInputs: Record<string, Json>,
            ): Promise<Json> => {
              const f = all.find((f) => f.id === id);
              if (!f) throw new Error(`Missing subflow: ${id}`);
              for (const key of f.inputs)
                if (!Object.hasOwn(childInputs, key))
                  throw new Error(`Missing subflow input: ${key}`);
              const result = await runGraph(
                f.graph,
                { inputs: childInputs, outputs: {}, vars: {} },
                AbortSignal.any([nodeSignal, AbortSignal.timeout(f.timeoutMs)]),
                `${path}/${n.id}:${id}@${f.revision}`,
              );
              if (
                f.outputs.length &&
                (!result ||
                  typeof result !== "object" ||
                  Array.isArray(result) ||
                  f.outputs.some((key) => !Object.hasOwn(result, key)))
              )
                throw new Error(
                  "Subflow return does not match declared outputs",
                );
              return result;
            };
            switch (n.kind) {
              case "trigger":
                output = scope.inputs;
                break;
              case "action": {
                if (!n.action) throw new Error("Action is missing");
                const action = {
                  ...n.action,
                  config: resolve(n.action.config, scope) as Record<
                    string,
                    Json
                  >,
                };
                output =
                  action.type === "workflow.run"
                    ? await child(
                        String(action.config.workflowId),
                        scope.inputs,
                      )
                    : await withCancellation(
                        this.handler(action, {
                          signal: nodeSignal,
                          runId: record.id,
                          ...binding,
                          workflowId: workflow.id,
                        }),
                        nodeSignal,
                      );
                break;
              }
              case "delay": {
                const ms = Number(c.ms);
                if (!Number.isFinite(ms) || ms < 0 || ms > 3600000)
                  throw new Error("Delay must be 0–3600000 ms");
                await sleep(ms, undefined, { signal: nodeSignal });
                output = ms;
                break;
              }
              case "set":
                scope.vars = { ...scope.vars, ...c };
                output = c;
                break;
              case "condition":
                port = checkCondition(c) ? "true" : "false";
                output = port === "true";
                break;
              case "switch":
                port = String(c.value);
                if (!g.edges.some((e) => e.source === n.id && e.port === port))
                  port = "default";
                output = c.value;
                break;
              case "return":
                output = c;
                break;
              case "subflow":
                output = await child(
                  String(c.workflowId),
                  (c.inputs ?? {}) as Record<string, Json>,
                );
                break;
              case "parallel": {
                const cancel = new AbortController(),
                  branchSignal = AbortSignal.any([nodeSignal, cancel.signal]);
                const results = await Promise.allSettled(
                  (n.branches ?? []).map(async (b, i) => {
                    try {
                      return await runGraph(
                        b,
                        structuredClone(scope),
                        branchSignal,
                        `${path}/${n.id}/branch:${i}`,
                      );
                    } catch (error) {
                      if (c.mode !== "collect") cancel.abort(error);
                      throw error;
                    }
                  }),
                );
                if (c.mode !== "collect") {
                  const failed = results.find((r) => r.status === "rejected");
                  if (failed?.status === "rejected") throw failed.reason;
                }
                output = Object.fromEntries(
                  results.map(
                    (r, i) =>
                      [
                        String(i),
                        r.status === "fulfilled"
                          ? { status: "success", value: r.value }
                          : {
                              status: "failure",
                              error: String(safe(String(r.reason))),
                            },
                      ] as [string, Json],
                  ),
                );
                break;
              }
              case "repeat":
              case "foreach": {
                const max = Number(c.maxIterations);
                const items =
                  n.kind === "repeat"
                    ? Array.from(
                        {
                          length: Math.max(
                            0,
                            Math.min(Number(c.count), max + 1),
                          ),
                        },
                        (_, i) => i,
                      )
                    : c.items;
                if (!Array.isArray(items))
                  throw new Error("For Each requires an array");
                if (
                  items.length > max ||
                  !Number.isInteger(max) ||
                  max < 1 ||
                  max > 1000
                )
                  throw new Error("Loop iteration limit exceeded");
                if (
                  n.kind === "repeat" &&
                  (!Number.isInteger(c.count) || Number(c.count) < 0)
                )
                  throw new Error("Repeat count must be a nonnegative integer");
                const results: Json[] = new Array(items.length);
                let next = 0;
                const cancellation = new AbortController(),
                  loopSignal = AbortSignal.any([
                    nodeSignal,
                    cancellation.signal,
                  ]);
                const workers = Array.from(
                  {
                    length: Math.min(
                      items.length,
                      n.kind === "repeat"
                        ? 1
                        : Math.max(1, Math.min(16, Number(c.concurrency ?? 1))),
                    ),
                  },
                  async () => {
                    while (next < items.length) {
                      const i = next++;
                      try {
                        results[i] = await runGraph(
                          n.body!,
                          {
                            ...structuredClone(scope),
                            item: items[i],
                            index: i,
                          },
                          loopSignal,
                          `${path}/${n.id}/iteration:${i}`,
                        );
                      } catch (error) {
                        cancellation.abort(error);
                        throw error;
                      }
                    }
                  },
                );
                const settled = await Promise.allSettled(workers);
                const failed = settled.find((r) => r.status === "rejected");
                if (failed?.status === "rejected") throw failed.reason;
                output = results;
                break;
              }
            }
            nodeSignal.throwIfAborted();
            trace.output = safe(output);
            trace.status = "success";
            trace.endedAt = Date.now();
            publish();
            break;
          } catch (error) {
            trace.status = parentSignal.aborted ? "cancelled" : "failure";
            trace.error = String(
              safe(error instanceof Error ? error.message : String(error)),
            );
            trace.endedAt = Date.now();
            publish();
            if (parentSignal.aborted) throw error;
            if (attempt < n.retries && !nodeSignal.aborted) {
              await sleep(Math.min(1000, 100 * 2 ** attempt), undefined, {
                signal: parentSignal,
              });
              continue;
            }
            if (g.edges.some((e) => e.source === n.id && e.port === "error")) {
              port = "error";
              scope.error = { message: trace.error, nodeId: n.id };
              output = scope.error;
              break;
            }
            throw error;
          }
        }
        if (JSON.stringify(output).length > 1_000_000)
          throw new Error("Node output exceeds the 1 MB data limit");
        scope.outputs[n.id] = output;
        if (JSON.stringify(scope).length > 4_000_000)
          throw new Error("Flow scope exceeds the 4 MB data limit");
        last = output;
        if (n.kind === "return") return output;
        current = g.edges.find(
          (e) => e.source === n.id && e.port === port,
        )?.target;
      }
      return last;
    };
    publish();
    const done = new Promise<RunRecord>((resolveDone) => {
      // Async work is an invoked promise actor; underlying operations share our abort signal.
      const actor = createActor(
        fromPromise(async () => {
          const result = await runGraph(
            workflow.graph,
            { inputs: structuredClone(inputs), outputs: {}, vars: {} },
            signal,
            workflow.id,
          );
          if (
            workflow.outputs.length &&
            (!result ||
              typeof result !== "object" ||
              Array.isArray(result) ||
              workflow.outputs.some((key) => !Object.hasOwn(result, key)))
          )
            throw new Error("Workflow return does not match declared outputs");
          return result;
        }),
      );
      const finish = (error?: unknown) => {
        record.endedAt = Date.now();
        record.status = controller.signal.aborted
          ? "cancelled"
          : error
            ? "failure"
            : "success";
        if (error)
          record.error = String(
            safe(
              deadline.aborted
                ? "Run timeout exceeded"
                : error instanceof Error
                  ? error.message
                  : String(error),
            ),
          );
        publish();
        resolveDone(record);
        actor.stop();
      };
      actor.subscribe({ complete: () => finish(), error: finish });
      actor.start();
    });
    return {
      record,
      cancel: () => controller.abort(new Error("Run cancelled")),
      done,
    };
  }
}
