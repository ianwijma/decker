import { defaultConfig, type Json } from '../shared/schema'
import { workerMessage } from '../shared/process'
import { Coordinator, bindingFlow } from './coordinator'
import { handlers } from '../actions/handlers'
import { capabilities, observeAudio, observeMedia } from '../adapters/linux'
let config = defaultConfig()
const send = (data: unknown) => process.parentPort?.postMessage(data)
const pending = new Map<
  string,
  {
    resolve: (value: Json) => void
    reject: (error: Error) => void
    timer: ReturnType<typeof setTimeout>
  }
>()
const bridge = (type: string, data: Record<string, Json>) =>
  new Promise<Json>((resolve, reject) => {
    const id = crypto.randomUUID()
    const timer = setTimeout(() => {
      pending.delete(id)
      reject(new Error('Main-process request timeout'))
    }, 10000)
    pending.set(id, { resolve, reject, timer })
    send({ type: 'bridge', id, action: type, data })
  })
const { handler, obs } = handlers(
  () => config,
  bridge,
  (id, value) => send({ type: 'observed', id, value })
)
const coordinator = new Coordinator(handler, (record) => send({ type: 'runUpdate', record }))
process.parentPort?.on('message', async (event) => {
  const parsed = workerMessage.safeParse(event.data)
  if (!parsed.success) {
    send({ type: 'error', error: 'Invalid runner message' })
    return
  }
  const m = parsed.data
  try {
    switch (m.type) {
      case 'config':
        config = m.config
        void obs.sync(config.connections)
        break
      case 'run': {
        const flow = config.workflows.find((w) => w.id === m.workflowId)
        if (!flow) throw new Error('Workflow not found')
        send({
          type: 'started',
          requestId: m.requestId,
          id: coordinator.start(flow, config.workflows, m.input)
        })
        break
      }
      case 'binding': {
        const b = m.binding
        if (!b.enabled) break
        const actions =
          m.event === 'release' ? b.release : m.event === 'long' ? b.longPress : b.actions
        const flow =
          m.event === 'press' && b.workflowId
            ? config.workflows.find((w) => w.id === b.workflowId)
            : bindingFlow(b, actions)
        if (!flow) throw new Error('Bound workflow is missing')
        coordinator.start(
          flow,
          [...config.workflows, ...(flow.id.startsWith('binding:') ? [flow] : [])],
          {},
          b,
          `${b.id}:${m.event}`,
          m.generation
        )
        break
      }
      case 'cancel':
        coordinator.cancel(m.id)
        break
      case 'cancelWorkflow':
        coordinator.cancelWorkflow(m.id)
        break
      case 'reply': {
        const p = pending.get(m.id)
        if (p) {
          clearTimeout(p.timer)
          pending.delete(m.id)
          if (m.error) p.reject(new Error(m.error))
          else p.resolve(m.value ?? null)
        }
        break
      }
      case 'stop':
        clearInterval(observationTimer)
        coordinator.stop()
        await obs.close()
        setTimeout(() => process.exit(0), 750)
        break
    }
  } catch (e) {
    send({ type: 'error', requestId: 'requestId' in m ? m.requestId : undefined, error: String(e) })
  }
})
void capabilities().then((value) => send({ type: 'capabilities', value }))

let observing = false
async function observe(): Promise<void> {
  if (observing) return
  observing = true
  try {
    const actions = config.profiles.flatMap((p) =>
      p.pages.flatMap((pg) => Object.values(pg.keys).flatMap((b) => b.actions))
    )
    const targets = [
      ...new Set(actions.filter((a) => a.type === 'audio').map((a) => a.config.target))
    ]
    const players = [
      ...new Set(
        actions.filter((a) => a.type === 'media').map((a) => String(a.config.player ?? ''))
      )
    ]
    await Promise.all([
      ...targets.map(async (target) =>
        send({
          type: 'observed',
          id: `audio:${target}`,
          value: await observeAudio(target === 'source' ? 'source' : 'sink')
        })
      ),
      ...players.map(async (player) =>
        send({ type: 'observed', id: `media:${player}`, value: await observeMedia(player) })
      )
    ])
    await obs.sync(config.connections)
  } finally {
    observing = false
  }
}
const observationTimer = setInterval(() => void observe(), 3000)
void observe()
