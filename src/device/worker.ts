import { observedBinding } from '../shared/observed'
import { listStreamDecks, openStreamDeck, type StreamDeck } from '@elgato-stream-deck/node'
import { defaultConfig, type DeviceStatus, type Json } from '../shared/schema'
import { workerMessage } from '../shared/process'
import { keyImage, ImageQueue } from './images'
let config = defaultConfig(),
  assets = '',
  stopping = false,
  scanning = false
const send = (data: unknown) => process.parentPort?.postMessage(data)
const devices = new Map<
  string,
  { deck: StreamDeck; status: DeviceStatus; queue: ImageQueue; last: Map<number, string> }
>()
const feedback = new Map<number, string>()
let observed: Record<string, Json> = {}
const report = () =>
  send({
    type: 'devices',
    value: [
      ...(config.settings.simulator
        ? [
            {
              id: 'simulator',
              name: 'Stream Deck XL · simulator',
              connected: true,
              simulated: true,
              rows: 4,
              columns: 8,
              keySize: 96
            }
          ]
        : []),
      ...[...devices.values()].map((d) => d.status)
    ]
  })
async function disconnect(id: string, error?: unknown): Promise<void> {
  const d = devices.get(id)
  if (!d) return
  devices.delete(id)
  d.queue.clear()
  await d.deck.close().catch(() => {})
  send({ type: 'disconnected', deviceId: id })
  if (error)
    send({ type: 'devices', value: [{ ...d.status, connected: false, error: String(error) }] })
  else report()
}
function redraw(): void {
  const page = config.profiles
    .find((p) => p.id === config.activeProfile)
    ?.pages.find((p) => p.id === config.activePage)
  for (const [id, d] of devices) {
    d.queue.enqueue(-1, () => d.deck.setBrightness(config.settings.brightness))
    for (const control of d.deck.modelInfo.controls) {
      if (control.type !== 'button' || control.feedbackType !== 'lcd') continue
      const b = observedBinding(page?.keys[String(control.index)], observed),
        status = feedback.get(control.index) ?? 'idle'
      const signature = JSON.stringify([b?.appearance, config.settings.accent, status])
      if (d.last.get(control.index) === signature) continue
      d.queue.enqueue(control.index, async () => {
        const buffer = await keyImage(
          b,
          control.pixelSize.width,
          config.settings.accent,
          status,
          assets
        )
        if (devices.get(id) !== d) return
        await d.deck.fillKeyBuffer(control.index, buffer, { format: 'rgb' })
        d.last.set(control.index, signature)
      })
    }
  }
}
async function scan(): Promise<void> {
  if (scanning || stopping) return
  scanning = true
  try {
    const detected = await listStreamDecks()
    const ids = new Set<string>()
    for (const info of detected) {
      const id = info.serialNumber || `session:${info.path}`
      if (config.settings.deviceSerial && info.serialNumber !== config.settings.deviceSerial)
        continue
      ids.add(id)
      if (devices.has(id)) continue
      try {
        const deck = await openStreamDeck(info.path)
        const controls = deck.modelInfo.controls.filter((c) => c.type === 'button')
        const lcd = controls.find((c) => c.type === 'button' && c.feedbackType === 'lcd')
        const status: DeviceStatus = {
          id,
          name: deck.modelInfo.name,
          connected: true,
          simulated: false,
          rows: Math.max(...controls.map((c) => c.row)) + 1,
          columns: Math.max(...controls.map((c) => c.column)) + 1,
          keySize: lcd?.type === 'button' && lcd.feedbackType === 'lcd' ? lcd.pixelSize.width : 96
        }
        const queue = new ImageQueue((e) => void disconnect(id, e))
        devices.set(id, { deck, status, queue, last: new Map() })
        deck.on('down', (c) => {
          if (c.type === 'button')
            send({ type: 'key', deviceId: id, index: c.index, event: 'down' })
        })
        deck.on('up', (c) => {
          if (c.type === 'button') send({ type: 'key', deviceId: id, index: c.index, event: 'up' })
        })
        deck.on('error', (e) => void disconnect(id, e))
        redraw()
      } catch (e) {
        send({
          type: 'devices',
          value: [
            {
              id,
              name: info.modelInfo.name,
              connected: false,
              simulated: false,
              rows: 4,
              columns: 8,
              keySize: 96,
              error: `Cannot open HID: ${String(e)}. Check desktop-user udev permissions and close other deck applications.`
            }
          ]
        })
      }
    }
    for (const id of devices.keys()) if (!ids.has(id)) await disconnect(id)
    if (devices.size || !detected.length) report()
  } catch (e) {
    send({
      type: 'devices',
      value: [
        {
          id: 'hardware',
          name: 'Hardware discovery',
          connected: false,
          simulated: false,
          rows: 4,
          columns: 8,
          keySize: 96,
          error: String(e)
        }
      ]
    })
  } finally {
    scanning = false
  }
}
process.parentPort?.on('message', async (event) => {
  const parsed = workerMessage.safeParse(event.data)
  if (!parsed.success) return
  const m = parsed.data
  if (m.type === 'config') {
    config = m.config
    assets = m.assets ?? assets
    feedback.clear()
    redraw()
    report()
    void scan()
  }
  if (m.type === 'observed') {
    observed = m.value
    redraw()
  }
  if (m.type === 'feedback') {
    feedback.set(m.index, m.status)
    redraw()
  }
  if (m.type === 'stop') {
    stopping = true
    clearInterval(timer)
    await Promise.all([...devices.keys()].map((id) => disconnect(id)))
    process.exit(0)
  }
})
const timer = setInterval(() => void scan(), 2000)
void scan()
