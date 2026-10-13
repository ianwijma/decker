import { createActor, fromPromise } from 'xstate'
import type { Action, Workflow, RunRecord, Json, NodeRecord } from '../shared/schema'
import { validateWorkflow } from './validate'
import { abortError, abortable, delay, redact, resolve, type Scope } from './data'
export type Handler = (
  action: Action,
  signal: AbortSignal,
  context: {
    runId: string
    bindingId?: string
    workflow: (id: string, input: Record<string, Json>) => Promise<Json>
  }
) => Promise<Json>
export interface Execution {
  record: RunRecord
  done: Promise<RunRecord>
  cancel(): void
}
export function execute(
  flow: Workflow,
  all: Workflow[],
  handler: Handler,
  input: Record<string, Json> = {},
  onUpdate: (record: RunRecord) => void = () => {},
  bindingId?: string,
  bindingGeneration?: number
): Execution {
  const snapshots = structuredClone(all),
    snapshot = structuredClone(flow)
  const errors = validateWorkflow(snapshot, snapshots)
  for (const child of snapshots) errors.push(...validateWorkflow(child, snapshots))
  if (errors.length) throw new Error(errors.join('\n'))
  for (const required of flow.inputs)
    if (!Object.hasOwn(input, required)) throw new Error(`Missing input: ${required}`)
  const controller = new AbortController()
  const record: RunRecord = {
    id: crypto.randomUUID(),
    bindingId,
    bindingGeneration,
    workflowId: flow.id,
    name: flow.name,
    revision: flow.revision,
    status: 'running',
    startedAt: Date.now(),
    nodes: []
  }
  const emit = () => onUpdate(structuredClone(record))
  const timer = setTimeout(() => controller.abort(new Error('Run timeout')), flow.timeoutMs)
  const childFlow = async (
    id: string,
    values: Record<string, Json>,
    scope: Scope,
    path: string,
    signal: AbortSignal
  ): Promise<Json> => {
    const child = snapshots.find((f) => f.id === id)
    if (!child) throw new Error('Missing subflow')
    for (const key of child.inputs)
      if (!Object.hasOwn(values, key)) throw new Error(`Missing subflow input: ${key}`)
    const entry = child.nodes.find((n) => n.kind === 'trigger')!
    const output = await walk(
      child,
      entry.id,
      { inputs: values, vars: {}, nodes: {} },
      path,
      AbortSignal.any([signal, AbortSignal.timeout(child.timeoutMs)])
    )
    checkOutputs(child, output)
    return output
  }
  const walk = async (
    f: Workflow,
    start: string | undefined,
    scope: Scope,
    path: string,
    signal: AbortSignal
  ): Promise<Json> => {
    let id = start,
      last: Json = null
    while (id) {
      abortError(signal)
      const n = f.nodes.find((n) => n.id === id)
      if (!n) throw new Error(`Missing node ${id}`)
      const trace: NodeRecord = {
        nodeId: n.id,
        path: `${path}/${n.id}`,
        status: 'running',
        startedAt: Date.now(),
        input: redact(scope)
      }
      if (record.nodes.length >= 1000) throw new Error('Run trace limit reached (1000 nodes)')
      record.nodes.push(trace)
      emit()
      const budget = AbortSignal.timeout(n.timeoutMs),
        nodeSignal = AbortSignal.any([signal, budget])
      const edge = (port: string) =>
        f.edges.find((e) => e.source === n.id && e.port === port)?.target
      let port = 'next'
      try {
        let attempts = 0
        while (true)
          try {
            const c = resolve(n.config, scope) as Record<string, Json>
            switch (n.kind) {
              case 'trigger':
                last = scope.inputs
                break
              case 'action': {
                const a = {
                  ...n.action!,
                  config: resolve(n.action!.config, scope) as Action['config']
                }
                trace.input = redact(a.config)
                last = await abortable(
                  handler(a, nodeSignal, {
                    runId: record.id,
                    bindingId,
                    workflow: (id, values) => childFlow(id, values, scope, trace.path, nodeSignal)
                  }),
                  nodeSignal
                )
                break
              }
              case 'delay':
                await delay(Number(c.ms), nodeSignal)
                last = null
                break
              case 'set': {
                const values = c.values
                if (!values || typeof values !== 'object' || Array.isArray(values))
                  throw new Error('Set values must be an object')
                Object.assign(scope.vars, values)
                last = values
                break
              }
              case 'condition': {
                const l = c.left,
                  r = c.right
                const yes =
                  c.operator === 'truthy'
                    ? Boolean(l)
                    : c.operator === 'equals'
                      ? JSON.stringify(l) === JSON.stringify(r)
                      : c.operator === 'notEquals'
                        ? JSON.stringify(l) !== JSON.stringify(r)
                        : c.operator === 'greater'
                          ? Number(l) > Number(r)
                          : c.operator === 'less'
                            ? Number(l) < Number(r)
                            : String(l).includes(String(r))
                port = yes ? 'true' : 'false'
                last = yes
                break
              }
              case 'switch':
                port = `case:${String(c.value)}`
                if (!edge(port)) port = 'default'
                last = c.value
                break
              case 'parallel': {
                const branches = f.edges.filter(
                  (e) => e.source === n.id && e.port.startsWith('branch:')
                )
                const siblings = new AbortController(),
                  combined = AbortSignal.any([nodeSignal, siblings.signal])
                let firstError: unknown
                const results = await Promise.all(
                  branches.map(async (e) => {
                    try {
                      return [
                        e.port.slice(7),
                        {
                          status: 'success',
                          output: await walk(
                            f,
                            e.target,
                            structuredClone(scope),
                            `${trace.path}/${e.port}`,
                            combined
                          )
                        }
                      ] as const
                    } catch (error) {
                      if (c.mode !== 'collect') {
                        firstError ??= error
                        siblings.abort(error)
                      }
                      return [e.port.slice(7), { status: 'error', error: String(error) }] as const
                    }
                  })
                )
                if (firstError) throw firstError
                last = Object.fromEntries(results)
                break
              }
              case 'repeat':
              case 'foreach': {
                const items =
                  n.kind === 'repeat'
                    ? Array.from(
                        { length: Math.min(Number(c.count), Number(c.maxIterations) + 1) },
                        (_, i) => i
                      )
                    : c.items
                if (!Array.isArray(items)) throw new Error('For Each items must be an array')
                if (
                  n.kind === 'repeat' &&
                  (!Number.isInteger(Number(c.count)) || Number(c.count) < 0)
                )
                  throw new Error('Repeat count must be a nonnegative integer')
                if (items.length > Number(c.maxIterations))
                  throw new Error('Loop iteration limit exceeded')
                const outputs: Json[] = Array(items.length).fill(null)
                let cursor = 0
                const siblings = new AbortController(),
                  combined = AbortSignal.any([nodeSignal, siblings.signal])
                let firstError: unknown
                await Promise.all(
                  Array.from(
                    { length: Math.min(Number(c.concurrency ?? 1), items.length) },
                    async () => {
                      while (cursor < items.length) {
                        const i = cursor++
                        try {
                          outputs[i] = await walk(
                            f,
                            edge('body'),
                            { ...structuredClone(scope), item: items[i], index: i },
                            `${trace.path}/${i}`,
                            combined
                          )
                        } catch (e) {
                          firstError ??= e
                          siblings.abort(e)
                          break
                        }
                      }
                    }
                  )
                )
                if (firstError) throw firstError
                last = outputs
                break
              }
              case 'subflow':
                last = await childFlow(
                  String(c.workflowId),
                  (c.input ?? {}) as Record<string, Json>,
                  scope,
                  trace.path,
                  nodeSignal
                )
                break
              case 'return':
                last = c.value ?? scope.vars
                break
            }
            abortError(nodeSignal)
            break
          } catch (e) {
            if (attempts++ >= n.retries || nodeSignal.aborted) throw e
            await delay(Math.min(1000 * attempts, 5000), nodeSignal)
          }
        scope.nodes[n.id] = last
        trace.status = 'success'
        trace.output = redact(last)
      } catch (e) {
        trace.status = signal.aborted ? 'cancelled' : 'error'
        trace.error = String(redact(String(e)))
        if (edge('error') && !signal.aborted) {
          scope.error = { message: trace.error, nodeId: n.id }
          port = 'error'
        } else throw e
      } finally {
        trace.endedAt = Date.now()
        emit()
      }
      if (n.kind === 'return' && port !== 'error') return last
      id = edge(port)
    }
    return last
  }
  const entry = snapshot.nodes.find((n) => n.kind === 'trigger')!
  let finish!: (r: RunRecord) => void
  const done = new Promise<RunRecord>((r) => (finish = r))
  const actor = createActor(
    fromPromise(async () =>
      walk(
        snapshot,
        entry.id,
        { inputs: structuredClone(input), vars: {}, nodes: {} },
        snapshot.id,
        controller.signal
      )
    )
  )
  actor.subscribe({
    next: (s) => {
      if (s.status === 'done') {
        record.status = 'success'
        try {
          checkOutputs(snapshot, s.output)
          record.output = redact(s.output)
        } catch (e) {
          record.status = 'error'
          record.error = String(e)
        }
        complete()
      }
    },
    error: (e) => {
      record.status =
        controller.signal.aborted && String(controller.signal.reason).includes('Cancelled')
          ? 'cancelled'
          : 'error'
      record.error = String(redact(String(e)))
      complete()
    }
  })
  const complete = () => {
    clearTimeout(timer)
    record.endedAt = Date.now()
    emit()
    finish(structuredClone(record))
  }
  emit()
  actor.start()
  return { record, done, cancel: () => controller.abort(new Error('Cancelled')) }
}

function checkOutputs(flow: Workflow, output: Json): void {
  for (const field of flow.outputs)
    if (
      !output ||
      typeof output !== 'object' ||
      Array.isArray(output) ||
      !Object.hasOwn(output, field)
    )
      throw new Error(`Missing declared output: ${field}`)
}
