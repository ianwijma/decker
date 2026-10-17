import {
  launchSourceSchema,
  type ExecutionContext,
  type TrustedLaunch,
} from "../shared/trigger-context";
import {
  findWorkflow,
  resolveWorkflowId,
  type WorkflowAliases,
} from "../shared/workflow-identity";
import { boundedResult, type ExecutionResult } from "./results";
import { actionById } from "../shared/catalog";
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
import { Invocations, queuedWorkflows } from "./invocations";
import { validateWorkflow } from "./validate";
export type RunBinding = {
  bindingId?: string;
  generation?: number;
  deckId?: string;
  launch?: TrustedLaunch;
};
export type InvocationEvent = {
  type: "begin" | "end";
  runId: string;
  authority: string;
};
export type ActionContext = {
  execution?: ExecutionContext;
  authority?: string;
  actionId?: string;
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
  result: Promise<ExecutionResult>;
  containsWorkflow: (id: string) => boolean;
};
export class Engine {
  private active = new Map<
    string,
    { invocations: Invocations; cancel: () => void }
  >();
  get activeCount() {
    return this.active.size;
  }
  cancelWorkflow(id: string) {
    for (const root of this.active.values())
      if (root.invocations.has(id)) root.cancel();
  }
  cancelRun(id: string) {
    this.active.get(id)?.cancel();
  }
  discardLaunch(launch?: TrustedLaunch) {
    if (launch?.authority)
      this.lifecycle({
        type: "end",
        runId: launch.source.invocationId,
        authority: launch.authority,
      });
  }
  prepare(
    definition: WorkflowDefinition,
    definitions: WorkflowDefinition[],
    binding: RunBinding,
  ) {
    const workflow = structuredClone(definition),
      all = structuredClone(definitions),
      aliases = structuredClone(this.workflowAliases());
    binding = structuredClone(binding);
    const issues = validateWorkflow(workflow, all, aliases);
    if (issues.length) throw new Error(issues.join("\n"));
    for (const input of workflow.inputs)
      throw new Error(`Missing workflow input: ${input}`);
    return {
      matchesWorkflow: queuedWorkflows(workflow, all, aliases),
      discard: () => this.discardLaunch(binding.launch),
      launch: () => this.start(workflow, all, {}, binding, aliases),
    };
  }
  constructor(
    private handler: Handler,
    private emit: (record: RunRecord) => void,
    private secrets: () => string[] = () => [],
    private workflowAliases: () => WorkflowAliases = () => ({}),
    private lifecycle: (event: InvocationEvent) => void = () => {},
    private validLaunch: (launch: TrustedLaunch) => boolean = () => true,
  ) {}
  start(
    definition: WorkflowDefinition,
    definitions: WorkflowDefinition[],
    inputs: Record<string, Json> = {},
    binding?: RunBinding,
    aliasesSnapshot = this.workflowAliases(),
    options: { privateResult?: boolean } = {},
  ): RunHandle {
    if (binding?.launch && !this.validLaunch(binding.launch))
      throw new Error("Triggering button changed before launch");
    if (this.active.size >= 64)
      throw new Error("Maximum active runs reached (64)");
    const workflow = structuredClone(definition),
      all = structuredClone(definitions),
      aliases = structuredClone(aliasesSnapshot),
      issues = validateWorkflow(workflow, all, aliases);
    if (issues.length) throw new Error(issues.join("\n"));
    for (const input of workflow.inputs)
      if (!Object.hasOwn(inputs, input))
        throw new Error(`Missing workflow input: ${input}`);
    const controller = new AbortController(),
      deadline = AbortSignal.timeout(workflow.timeoutMs),
      signal = AbortSignal.any([controller.signal, deadline]);
    const invocations = new Invocations(aliases),
      leaveRoot = invocations.enter(workflow.id),
      cancel = () => controller.abort(new Error("Run cancelled"));
    const record: RunRecord = {
      id: randomUUID(),
      workflowId: workflow.id,
      workflowName: workflow.name,
      revision: workflow.revision,
      bindingId: binding?.bindingId,
      generation: binding?.generation,
      deckId: binding?.deckId,
      startedAt: Date.now(),
      status: "running",
      nodes: [],
    };
    const source = launchSourceSchema.parse(
      options.privateResult
        ? { kind: "probe", invocationId: randomUUID() }
        : (binding?.launch?.source ?? {
            kind: "manual",
            invocationId: randomUUID(),
          }),
    );
    const authority = options.privateResult
      ? undefined
      : binding?.launch?.authority;
    const rootContext: ExecutionContext = {
      source: {
        kind: source.kind,
        ...(source.schedule ? { schedule: source.schedule } : {}),
      },
      origin: source.origin ?? null,
      rootRunId: record.id,
      invocationId: source.invocationId,
      rootWorkflowId: workflow.id,
      workflowId: workflow.id,
      workflowInvocationId: randomUUID(),
    };
    record.context = structuredClone(rootContext);
    const end = () => {
      if (authority)
        this.lifecycle({ type: "end", runId: record.id, authority });
    };
    if (authority)
      this.lifecycle({ type: "begin", runId: record.id, authority });
    signal.addEventListener("abort", end, { once: true });
    this.active.set(record.id, { invocations, cancel });
    const publish = () => {
      while (record.nodes.length > 1 && JSON.stringify(record).length > 256000)
        record.nodes.shift();
      if (!options.privateResult) this.emit(structuredClone(record));
    };
    let steps = 0,
      timedOut = false;
    const safe = (v: unknown) => redact(v, this.secrets());
    const runGraph = async (
      g: Graph,
      scope: Scope,
      parentSignal: AbortSignal,
      path: string,
    ): Promise<Json> => {
      if (scope.context) {
        if (scope.context.source.schedule)
          Object.freeze(scope.context.source.schedule);
        Object.freeze(scope.context.source);
        if (scope.context.origin) Object.freeze(scope.context.origin);
        Object.freeze(scope.context);
        Object.defineProperty(scope, "context", {
          value: scope.context,
          writable: false,
          configurable: false,
          enumerable: true,
        });
      }
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
            if (!options.privateResult)
              trace.input = safe(
                n.action ? resolve(n.action.config, scope) : c,
              );
            const child = async (
              id: string,
              childInputs: Record<string, Json>,
              revision?: Json,
            ): Promise<Json> => {
              nodeSignal.throwIfAborted();
              const f = findWorkflow(all, id, aliases);
              if (!f) throw new Error(`Missing subflow: ${id}`);
              if (revision !== undefined && revision !== f.revision)
                throw new Error(
                  `Pin the current subflow revision (${f.revision})`,
                );
              for (const key of f.inputs)
                if (!Object.hasOwn(childInputs, key))
                  throw new Error(`Missing subflow input: ${key}`);
              const leave = invocations.enter(f.id);
              try {
                const result = await runGraph(
                  f.graph,
                  {
                    inputs: childInputs,
                    outputs: {},
                    vars: {},
                    context: {
                      ...scope.context!,
                      workflowId: f.id,
                      workflowInvocationId: randomUUID(),
                    },
                  },
                  AbortSignal.any([
                    nodeSignal,
                    AbortSignal.timeout(f.timeoutMs),
                  ]),
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
              } finally {
                leave();
              }
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
                const definition = actionById(action.type);
                if (!definition || action.version !== definition.version)
                  throw new Error(`Unsupported action: ${action.type}`);
                const parsed = definition.schema.safeParse(action.config);
                if (!parsed.success)
                  throw new Error(
                    parsed.error.issues
                      .map((i) => `${i.path.join(".")}: ${i.message}`)
                      .join(", "),
                  );
                for (const field of actionById(action.type)?.fields ?? [])
                  if (field.type === "workflow") {
                    const ref = action.config[field.key];
                    if (
                      typeof ref !== "string" ||
                      !findWorkflow(all, ref, aliases)
                    )
                      throw new Error("Workflow not found");
                    action.config[field.key] = resolveWorkflowId(ref, aliases);
                  }
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
                          bindingId: binding?.bindingId,
                          generation: binding?.generation,
                          deckId: binding?.deckId,
                          execution: scope.context,
                          authority,
                          actionId: randomUUID(),
                          workflowId: scope.context!.workflowId,
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
                if (!Number.isInteger(c.revision) || Number(c.revision) < 1)
                  throw new Error("Pin a subflow revision");
                output = await child(
                  String(c.workflowId),
                  (c.inputs ?? {}) as Record<string, Json>,
                  c.revision,
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
            if (!options.privateResult) trace.output = safe(output);
            trace.status = "success";
            trace.endedAt = Date.now();
            publish();
            break;
          } catch (error) {
            if (
              nodeSignal.aborted &&
              nodeSignal.reason?.name === "TimeoutError"
            )
              timedOut = true;
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
    let resolveResult!: (value: ExecutionResult) => void;
    const result = new Promise<ExecutionResult>((resolve) => {
      resolveResult = resolve;
    });
    let output: unknown;
    const done = new Promise<RunRecord>((resolveDone) => {
      // Async work is an invoked promise actor; underlying operations share our abort signal.
      const actor = createActor(
        fromPromise(async () => {
          const result = await runGraph(
            workflow.graph,
            {
              inputs: structuredClone(inputs),
              outputs: {},
              vars: {},
              context: rootContext,
            },
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
        resolveResult(
          controller.signal.aborted
            ? { status: "cancelled" }
            : error
              ? { status: deadline.aborted || timedOut ? "timeout" : "failure" }
              : { status: "success", output: boundedResult(output) },
        );
        end();
        signal.removeEventListener("abort", end);
        leaveRoot();
        this.active.delete(record.id);
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
      actor.subscribe({
        next: (snapshot) => {
          if (snapshot.status === "done") output = snapshot.output;
        },
        complete: () => finish(),
        error: finish,
      });
      actor.start();
    });
    return {
      record,
      cancel,
      containsWorkflow: (id) => invocations.has(id),
      done,
      result,
    };
  }
}
