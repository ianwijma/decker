import OBSWebSocket from 'obs-websocket-js'
import type { Config, Json } from '../shared/schema'
import { abortError, abortable } from '../runtime/data'
export class OBSConnections {
  private clients = new Map<string, { client: OBSWebSocket; identity: string }>()
  private connecting = new Map<string, Promise<OBSWebSocket>>()
  constructor(
    private observed: (id: string, value: Json) => void,
    private credential: (ref: string) => Promise<string>
  ) {}
  async get(connection: Config['connections'][number]): Promise<OBSWebSocket> {
    const identity = JSON.stringify(connection)
    const cached = this.clients.get(connection.id)
    if (cached?.identity === identity) return cached.client
    const pending = this.connecting.get(connection.id)
    if (pending) {
      await pending.catch(() => {})
      return this.get(connection)
    }
    const promise = this.connect(connection, identity)
    this.connecting.set(connection.id, promise)
    try {
      return await promise
    } finally {
      this.connecting.delete(connection.id)
    }
  }
  private async connect(
    connection: Config['connections'][number],
    identity: string
  ): Promise<OBSWebSocket> {
    const cached = this.clients.get(connection.id)
    if (cached) await cached.client.disconnect()
    const client = new OBSWebSocket()
    client.on('ConnectionClosed', () => {
      if (this.clients.get(connection.id)?.client === client) this.clients.delete(connection.id)
      this.observed(connection.id, { connected: false })
    })
    client.on('CurrentProgramSceneChanged', (e) =>
      this.observed(connection.id, { scene: e.sceneName, connected: true })
    )
    client.on('InputMuteStateChanged', (e) =>
      this.observed(`${connection.id}:${e.inputName}`, { muted: e.inputMuted })
    )
    client.on('SceneItemEnableStateChanged', (e) =>
      this.observed(`${connection.id}:source:${e.sceneName}:${e.sceneItemId}`, {
        enabled: e.sceneItemEnabled
      })
    )
    client.on('RecordStateChanged', (e) =>
      this.observed(`${connection.id}:record`, { active: e.outputActive })
    )
    client.on('StreamStateChanged', (e) =>
      this.observed(`${connection.id}:stream`, { active: e.outputActive })
    )
    try {
      await abortable(
        client.connect(
          connection.url,
          connection.credentialRef ? await this.credential(connection.credentialRef) : undefined,
          { eventSubscriptions: 2047 }
        ),
        AbortSignal.timeout(5000)
      )
      this.clients.set(connection.id, { client, identity })
      const scene = await client.call('GetCurrentProgramScene')
      this.observed(connection.id, { connected: true, scene: scene.sceneName })
      await Promise.all([
        client
          .call('GetRecordStatus')
          .then((s) => this.observed(`${connection.id}:record`, { active: s.outputActive })),
        client
          .call('GetStreamStatus')
          .then((s) => this.observed(`${connection.id}:stream`, { active: s.outputActive })),
        client.call('GetInputList').then(async (inputs) => {
          await Promise.all(
            inputs.inputs.map(async (input) => {
              try {
                const name = String(input.inputName),
                  mute = await client.call('GetInputMute', { inputName: name })
                this.observed(`${connection.id}:${name}`, { muted: mute.inputMuted })
              } catch {}
            })
          )
        })
      ])
      return client
    } catch (error) {
      await client.disconnect().catch(() => {})
      this.clients.delete(connection.id)
      throw error
    }
  }
  async call(
    connection: Config['connections'][number],
    request: string,
    data: Record<string, Json>,
    signal: AbortSignal
  ): Promise<Json> {
    abortError(signal)
    const client = await abortable(this.get(connection), signal)
    abortError(signal)
    const result = await abortable(
      client.call(request as 'SetCurrentProgramScene', data as unknown as { sceneName: string }),
      signal
    )
    return (result ?? null) as Json
  }
  async sync(connections: Config['connections']): Promise<void> {
    for (const [id, { client }] of this.clients)
      if (!connections.some((c) => c.id === id)) {
        this.clients.delete(id)
        await client.disconnect()
      }
    await Promise.all(
      connections.map(async (c) => {
        try {
          await this.get(c)
        } catch (e) {
          this.observed(c.id, { connected: false, error: String(e) })
        }
      })
    )
  }
  async close(): Promise<void> {
    await Promise.all([...this.clients.values()].map((c) => c.client.disconnect()))
    this.clients.clear()
  }
}
