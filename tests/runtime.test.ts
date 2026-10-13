import { describe, it, expect, vi } from 'vitest'
import {
  workflowSchema,
  nodeSchema,
  bindingSchema,
  defaultConfig,
  configSchema,
  type Workflow,
  type Json
} from '../src/shared/schema'
import { execute, type Handler } from '../src/runtime/engine'
import { bindingFlow, Coordinator } from '../src/runtime/coordinator'
import { validateWorkflow } from '../src/runtime/validate'
import { delay, resolve, redact } from '../src/runtime/data'
import { Triggers } from '../src/device/triggers'
import { ImageQueue } from '../src/device/images'
import { ResourceLocks } from '../src/adapters/linux'
const node = (id: string, kind: string, config: Record<string, Json> = {}) =>
  nodeSchema.parse({
    id,
    kind,
    label: id,
    config,
    position: { x: 0, y: 0 },
    ...(kind === 'action' ? { action: { type: 'clipboard', config: { text: id } } } : {})
  })
const flow = (
  nodes: ReturnType<typeof node>[],
  edges: Array<[string, string, string?]>,
  id = 'test'
): Workflow =>
  workflowSchema.parse({
    id,
    name: id,
    revision: 1,
    nodes: [node('start', 'trigger'), ...nodes],
    edges: edges.map(([source, target, port = 'next'], i) => ({
      id: String(i),
      source,
      target,
      port
    }))
  })
const fake: Handler = async (action) => action.config
async function run(f: Workflow, handler: Handler = fake, all = [f], input = {}) {
  return execute(f, all, handler, input).done
}
describe('structured workflow runtime', () => {
  it('sequences actions once and binds prior outputs', async () => {
    const f = flow(
      [node('a', 'action'), node('b', 'action')],
      [
        ['start', 'a'],
        ['a', 'b']
      ]
    )
    f.nodes[2].action!.config = { text: '{{nodes.a.text}}' }
    const handler = vi.fn(fake)
    const r = await run(f, handler)
    expect(r.status).toBe('success')
    expect(r.output).toEqual({ text: 'a' })
    expect(handler).toHaveBeenCalledTimes(2)
  })
  it('selects exactly one condition path and switch default', async () => {
    const f = flow(
      [
        node('c', 'condition', { left: true, operator: 'equals', right: true }),
        node('yes', 'action'),
        node('no', 'action')
      ],
      [
        ['start', 'c'],
        ['c', 'yes', 'true'],
        ['c', 'no', 'false']
      ]
    )
    const handler = vi.fn(fake)
    expect((await run(f, handler)).output).toEqual({ text: 'yes' })
    expect(handler).toHaveBeenCalledTimes(1)
    const s = flow(
      [node('s', 'switch', { value: 'unknown' }), node('default', 'action')],
      [
        ['start', 's'],
        ['s', 'default', 'default']
      ]
    )
    expect((await run(s)).output).toEqual({ text: 'default' })
  })
  it('joins nested parallel branches with isolated data and skipped paths', async () => {
    const f = flow(
      [
        node('p', 'parallel'),
        node('nested', 'parallel'),
        node('a', 'set', { values: { x: 1 } }),
        node('b', 'set', { values: { x: 2 } }),
        node('skip', 'condition', { left: false, operator: 'truthy' }),
        node('result', 'return', { value: '{{nodes.p}}' })
      ],
      [
        ['start', 'p'],
        ['p', 'nested', 'branch:left'],
        ['nested', 'a', 'branch:a'],
        ['nested', 'b', 'branch:b'],
        ['p', 'skip', 'branch:right'],
        ['p', 'result']
      ]
    )
    const r = await run(f)
    expect(r.status).toBe('success')
    expect(r.output).toEqual({
      left: {
        status: 'success',
        output: {
          a: { status: 'success', output: { x: 1 } },
          b: { status: 'success', output: { x: 2 } }
        }
      },
      right: { status: 'success', output: false }
    })
  })
  it('cancels siblings on parallel failure and can collect failures', async () => {
    const f = flow(
      [node('p', 'parallel'), node('fail', 'action'), node('wait', 'delay', { ms: 5000 })],
      [
        ['start', 'p'],
        ['p', 'fail', 'branch:a'],
        ['p', 'wait', 'branch:b']
      ]
    )
    const r = await run(f, async () => {
      throw new Error('offline')
    })
    expect(r.status).toBe('error')
    expect(r.nodes.find((n) => n.nodeId === 'wait')?.endedAt).toBeDefined()
    f.nodes[1].config.mode = 'collect'
    f.nodes[3].config.ms = 1
    expect(
      (
        await run(f, async () => {
          throw new Error('offline')
        })
      ).status
    ).toBe('success')
  })
  it('runs bounded repeat and concurrent foreach in separate iteration scopes', async () => {
    const f = flow(
      [
        node('loop', 'foreach', { items: ['a', 'b', 'c'], maxIterations: 3, concurrency: 2 }),
        node('body', 'return', { value: '{{item}}' }),
        node('result', 'return', { value: '{{nodes.loop}}' })
      ],
      [
        ['start', 'loop'],
        ['loop', 'body', 'body'],
        ['loop', 'result']
      ]
    )
    expect((await run(f)).output).toEqual(['a', 'b', 'c'])
    f.nodes[1].config.maxIterations = 2
    expect((await run(f)).error).toContain('iteration limit')
    f.nodes[1].kind = 'repeat'
    f.nodes[1].config = { count: 3, maxIterations: 3, concurrency: 1 }
    f.nodes[2].config.value = '{{index}}'
    expect((await run(f)).output).toEqual([0, 1, 2])
  })
  it('pins subflows and preserves immutable snapshots during edits', async () => {
    const child = flow(
      [node('return', 'return', { value: '{{inputs.value}}' })],
      [['start', 'return']],
      'child'
    )
    const f = flow(
      [
        node('wait', 'delay', { ms: 10 }),
        node('call', 'subflow', { workflowId: 'child', revision: 1, input: { value: 42 } })
      ],
      [
        ['start', 'wait'],
        ['wait', 'call']
      ]
    )
    const execution = execute(f, [f, child], fake)
    child.nodes[1].config.value = 999
    expect((await execution.done).output).toBe(42)
    child.revision = 2
    expect(validateWorkflow(f, [f, child]).join()).toContain('revision mismatch')
  })
  it('propagates failed subflow errors and explicit recovery', async () => {
    const child = flow([node('bad', 'action')], [['start', 'bad']], 'child')
    const f = flow(
      [
        node('call', 'subflow', { workflowId: 'child', revision: 1, input: {} }),
        node('recover', 'return', { value: '{{error.nodeId}}' })
      ],
      [
        ['start', 'call'],
        ['call', 'recover', 'error']
      ]
    )
    const r = await run(f, async () => {
      throw new Error('bad')
    }, [f, child])
    expect(r.status).toBe('success')
    expect(r.output).toBe('call')
  })
  it('propagates cancellation, node and run timeouts without future work', async () => {
    const f = flow(
      [node('wait', 'delay', { ms: 5000 }), node('later', 'action')],
      [
        ['start', 'wait'],
        ['wait', 'later']
      ]
    )
    const execution = execute(f, [f], fake)
    execution.cancel()
    expect((await execution.done).status).toBe('cancelled')
    expect(execution.record.nodes.some((n) => n.nodeId === 'later')).toBe(false)
    f.timeoutMs = 5
    expect((await run(f)).error).toContain('Run timeout')
    f.timeoutMs = 500
    f.nodes[1].timeoutMs = 5
    expect((await run(f)).status).toBe('error')
  })
  it('requires explicit retry safety and bounds retries', async () => {
    const f = flow([node('a', 'action')], [['start', 'a']])
    f.nodes[1].retries = 1
    expect(validateWorkflow(f, [f]).join()).toContain('idempotency')
    f.nodes[1].retrySafe = true
    let attempts = 0
    const r = await run(f, async () => {
      if (attempts++ === 0) throw new Error('temporary')
      return true
    })
    expect(r.status).toBe('success')
    expect(attempts).toBe(2)
  })
  it('rejects backedges, recursion and unavailable conditional outputs', () => {
    const f = flow(
      [
        node('c', 'condition', { left: true, operator: 'truthy' }),
        node('a', 'action'),
        node('b', 'return', { value: '{{nodes.a.text}}' })
      ],
      [
        ['start', 'c'],
        ['c', 'a', 'true'],
        ['c', 'b', 'false'],
        ['a', 'b']
      ]
    )
    expect(validateWorkflow(f, [f]).join()).toContain('not available')
    f.nodes[3].config.value = '{{nodes.a.text|none}}'
    expect(validateWorkflow(f, [f])).toEqual([])
    f.edges.push({ id: 'cycle', source: 'b', target: 'c', port: 'next' })
    expect(validateWorkflow(f, [f]).join()).toContain('cycles')
    const recursive = flow(
      [node('call', 'subflow', { workflowId: 'test', revision: 1 })],
      [['start', 'call']]
    )
    expect(validateWorkflow(recursive, [recursive]).join()).toContain('Recursive')
  })
})
describe('coordinator, device and process boundaries', () => {
  it('ignores repeated presses, drains bounded FIFO, and restarts after cancellation', async () => {
    const b = bindingSchema.parse({
      id: 'key',
      appearance: { label: 'key' },
      policy: 'ignore',
      actions: [{ type: 'clipboard', config: { text: 'hi' } }]
    })
    const f = bindingFlow(b)
    let count = 0
    const records: string[] = []
    const coordinator = new Coordinator(
      async (_, signal) => {
        count++
        await delay(15, signal)
        return true
      },
      (r) => {
        if (r.status !== 'running') records.push(r.status)
      }
    )
    const first = coordinator.start(f, [f], {}, b)
    expect(coordinator.start(f, [f], {}, b)).toBe(first)
    await delay(25, new AbortController().signal)
    expect(count).toBe(1)
    b.policy = 'queue'
    b.limit = 1
    coordinator.start(f, [f], {}, b)
    coordinator.start(f, [f], {}, b)
    expect(() => coordinator.start(f, [f], {}, b)).toThrow('queue')
    await delay(50, new AbortController().signal)
    expect(count).toBe(3)
    b.policy = 'restart'
    coordinator.start(f, [f], {}, b)
    coordinator.start(f, [f], {}, b)
    await delay(50, new AbortController().signal)
    expect(records).toContain('cancelled')
    expect(count).toBe(5)
    coordinator.stop()
  })
  it('captures held binding at down time, resolves long vs short, clears on disconnect', () => {
    vi.useFakeTimers()
    const fire = vi.fn(),
      triggers = new Triggers(fire),
      b = bindingSchema.parse({
        id: 'old',
        appearance: {},
        actions: [],
        release: [{ type: 'clipboard', config: { text: 'release' } }],
        longPress: [{ type: 'clipboard', config: { text: 'long' } }]
      })
    triggers.down('deck', 0, b)
    b.id = 'new'
    vi.advanceTimersByTime(200)
    triggers.up('deck', 0)
    expect(fire.mock.calls.map((c) => [c[0].id, c[1]])).toEqual([
      ['old', 'press'],
      ['old', 'release']
    ])
    fire.mockClear()
    triggers.down('deck', 0, b)
    vi.advanceTimersByTime(700)
    triggers.up('deck', 0)
    expect(fire.mock.calls.map((c) => c[1])).toEqual(['long', 'release'])
    fire.mockClear()
    triggers.down('deck', 0, b)
    triggers.disconnect('deck')
    vi.advanceTimersByTime(700)
    triggers.up('deck', 0)
    expect(fire).not.toHaveBeenCalled()
    vi.useRealTimers()
  })
  it('coalesces image writes and serializes shared resources', async () => {
    let release!: () => void
    const writes: number[] = []
    const queue = new ImageQueue(() => {})
    queue.enqueue(0, () => new Promise<void>((r) => (release = r)))
    queue.enqueue(1, async () => {
      writes.push(1)
    })
    queue.enqueue(1, async () => {
      writes.push(2)
    })
    expect(queue.size).toBe(1)
    release()
    await delay(5, new AbortController().signal)
    expect(writes).toEqual([2])
    const locks = new ResourceLocks()
    const order: number[] = []
    await Promise.all([
      locks.use('keyboard', new AbortController().signal, async () => {
        await delay(5, new AbortController().signal)
        order.push(1)
      }),
      locks.use('keyboard', new AbortController().signal, async () => {
        order.push(2)
      })
    ])
    expect(order).toEqual([1, 2])
  })
  it('validates imported documents, resolves safe transforms and redacts traces', () => {
    const c = defaultConfig()
    expect(configSchema.parse(c)).toEqual(c)
    c.settings.accent = 'red'
    expect(configSchema.safeParse(c).success).toBe(false)
    expect(
      resolve(
        { $transform: 'upper', value: '{{inputs.name}}' },
        { inputs: { name: 'decker' }, vars: {}, nodes: {} }
      )
    ).toBe('DECKER')
    expect(() => resolve('{{inputs.constructor}}', { inputs: {}, vars: {}, nodes: {} })).toThrow(
      'Unsafe'
    )
    expect(
      redact({
        Authorization: 'abc',
        password: 'xyz',
        url: 'https://a?token=secret',
        long: 'x'.repeat(10000)
      })
    ).toMatchObject({
      Authorization: '[redacted]',
      password: '[redacted]',
      url: 'https://a?token=[redacted]'
    })
  })
})
