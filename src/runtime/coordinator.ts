import type { Workflow, Json, RunRecord, Binding } from '../shared/schema'
import { execute, type Execution, type Handler } from './engine'
export class Coordinator {
  private active = new Map<string, Execution>()
  private groups = new Map<string, Set<string>>()
  private queues = new Map<string, Array<{ workflowId: string; start: () => void }>>()
  constructor(
    private handler: Handler,
    private update: (record: RunRecord) => void
  ) {}
  start(
    flow: Workflow,
    all: Workflow[],
    input: Record<string, Json> = {},
    binding?: Binding,
    groupKey?: string,
    generation?: number
  ): string {
    const group = groupKey ?? binding?.id ?? crypto.randomUUID(),
      current = this.groups.get(group) ?? new Set<string>()
    if (current.size && binding) {
      if (binding.policy === 'ignore') return [...current][0]
      if (binding.policy === 'queue' || binding.policy === 'restart') {
        const queue = this.queues.get(group) ?? []
        if (binding.policy === 'restart') {
          queue.length = 0
          for (const id of current) this.active.get(id)?.cancel()
        }
        if (queue.length >= binding.limit) throw new Error('Binding queue is full')
        const queuedFlow = structuredClone(flow),
          queuedAll = structuredClone(all),
          queuedInput = structuredClone(input),
          queuedBinding = structuredClone(binding)
        queue.push({
          workflowId: flow.id,
          start: () =>
            this.start(queuedFlow, queuedAll, queuedInput, queuedBinding, groupKey, generation)
        })
        this.queues.set(group, queue)
        return [...current][0]
      }
      if (current.size >= binding.limit) throw new Error('Concurrent run limit reached')
    }
    if (this.active.size >= 64) throw new Error('Active run limit reached')
    const execution = execute(flow, all, this.handler, input, this.update, binding?.id, generation)
    this.active.set(execution.record.id, execution)
    current.add(execution.record.id)
    this.groups.set(group, current)
    void execution.done.finally(() => {
      this.active.delete(execution.record.id)
      current.delete(execution.record.id)
      const queue = this.queues.get(group)
      if (!current.size) {
        const next = queue?.shift()
        if (!next) {
          this.groups.delete(group)
          this.queues.delete(group)
        } else next.start()
      }
    })
    return execution.record.id
  }
  cancel(id: string): void {
    this.active.get(id)?.cancel()
  }
  cancelWorkflow(id: string): void {
    for (const [group, queue] of this.queues)
      this.queues.set(
        group,
        queue.filter((item) => item.workflowId !== id)
      )
    for (const run of this.active.values()) if (run.record.workflowId === id) run.cancel()
  }
  stop(): void {
    this.queues.clear()
    for (const run of this.active.values()) run.cancel()
  }
}
export function bindingFlow(binding: Binding, actions = binding.actions): Workflow {
  return {
    id: `binding:${binding.id}`,
    name: binding.appearance.label || 'Key action',
    revision: 1,
    inputs: [],
    outputs: [],
    timeoutMs: 60000,
    nodes: [
      {
        id: 'start',
        label: 'Key pressed',
        kind: 'trigger',
        config: {},
        position: { x: 0, y: 0 },
        timeoutMs: 30000,
        retries: 0,
        retrySafe: false
      },
      ...actions.map((action, i) => ({
        id: `action-${i}`,
        label: action.type,
        kind: 'action' as const,
        action,
        config: {},
        position: { x: 0, y: 0 },
        timeoutMs: 30000,
        retries: 0,
        retrySafe: false
      }))
    ],
    edges: actions.map((_, i) => ({
      id: `edge-${i}`,
      source: i === 0 ? 'start' : `action-${i - 1}`,
      target: `action-${i}`,
      port: 'next'
    }))
  }
}
