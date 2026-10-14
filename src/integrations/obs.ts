import OBSWebSocket from "obs-websocket-js";
import { withCancellation } from "../runtime/cancellation";
import type { AppDocument, Json } from "../shared/schema";
export class ObsConnections {
  private state = new Map<string, Record<string, Json>>();
  private generation = 0;
  private update(id: string, patch: Record<string, Json>) {
    const value = { ...this.state.get(id), ...patch };
    this.state.set(id, value);
    this.observe(id, value);
  }
  private clients = new Map<string, OBSWebSocket>();
  private connecting = new Map<string, Promise<OBSWebSocket>>();
  constructor(private observe: (id: string, value: Json) => void) {}
  async get(
    connection: AppDocument["connections"][number],
    password?: string,
  ): Promise<OBSWebSocket> {
    const existing = this.clients.get(connection.id);
    if (existing) return existing;
    const pending = this.connecting.get(connection.id);
    if (pending) return pending;
    const generation = this.generation;
    const promise = (async () => {
      const client = new OBSWebSocket();
      client.on("ConnectionClosed", () => {
        this.clients.delete(connection.id);
        this.update(connection.id, { connected: false });
      });
      client.on("ConnectionError", (error) =>
        this.update(connection.id, { connected: false, error: error.message }),
      );
      client.on("CurrentProgramSceneChanged", (data) =>
        this.update(connection.id, { connected: true, scene: data.sceneName }),
      );
      client.on("InputMuteStateChanged", (data) =>
        this.update(connection.id, {
          connected: true,
          [`mute:${data.inputName}`]: data.inputMuted,
        }),
      );
      client.on("RecordStateChanged", (data) =>
        this.update(connection.id, {
          connected: true,
          recording: data.outputActive,
        }),
      );
      client.on("StreamStateChanged", (data) =>
        this.update(connection.id, {
          connected: true,
          streaming: data.outputActive,
        }),
      );
      client.on("SceneItemEnableStateChanged", (data) =>
        this.update(connection.id, {
          connected: true,
          [`source:${data.sceneName}:${data.sceneItemId}`]:
            data.sceneItemEnabled,
        }),
      );
      try {
        await withCancellation(
          client.connect(connection.url, password),
          AbortSignal.timeout(5000),
          0,
        );
        if (generation !== this.generation)
          throw new Error("OBS configuration changed");
        this.clients.set(connection.id, client);
        const scene = await withCancellation(
          client.call("GetCurrentProgramScene"),
          AbortSignal.timeout(3000),
          0,
        );
        this.update(connection.id, {
          connected: true,
          scene: scene.currentProgramSceneName,
        });
        const observe = async () => {
          const [recording, streaming, inputs, scenes] = await Promise.all([
            client.call("GetRecordStatus"),
            client.call("GetStreamStatus"),
            client.call("GetInputList"),
            client.call("GetSceneList"),
          ]);
          this.update(connection.id, {
            recording: recording.outputActive,
            streaming: streaming.outputActive,
          });
          await Promise.allSettled(
            inputs.inputs.slice(0, 64).map(async (input) => {
              const inputName = String(input.inputName);
              const result = await client.call("GetInputMute", { inputName });
              this.update(connection.id, {
                [`mute:${inputName}`]: result.inputMuted,
              });
            }),
          );
          await Promise.allSettled(
            scenes.scenes.slice(0, 64).map(async (scene) => {
              const sceneName = String(scene.sceneName),
                result = await client.call("GetSceneItemList", { sceneName });
              this.update(
                connection.id,
                Object.fromEntries(
                  result.sceneItems.map((item) => [
                    `source:${sceneName}:${item.sceneItemId}`,
                    Boolean(item.sceneItemEnabled),
                  ]),
                ),
              );
            }),
          );
        };
        void withCancellation(observe(), AbortSignal.timeout(5000), 0).catch(
          () => {},
        );
        return client;
      } catch (error) {
        this.clients.delete(connection.id);
        await client.disconnect().catch(() => {});
        throw error;
      }
    })();
    this.connecting.set(connection.id, promise);
    try {
      return await promise;
    } finally {
      this.connecting.delete(connection.id);
    }
  }
  async execute(
    connection: AppDocument["connections"][number],
    password: string | undefined,
    config: Record<string, Json>,
    signal: AbortSignal,
  ): Promise<Json> {
    const client = await withCancellation(
      this.get(connection, password),
      signal,
      0,
    );
    signal.throwIfAborted();
    const name = String(config.name ?? ""),
      enabled = Boolean(config.enabled);
    switch (config.operation) {
      case "scene":
        await client.call("SetCurrentProgramScene", { sceneName: name });
        break;
      case "source":
        await client.call("SetSceneItemEnabled", {
          sceneName: name,
          sceneItemId: Number(config.sourceId),
          sceneItemEnabled: enabled,
        });
        break;
      case "mute":
        await client.call("SetInputMute", {
          inputName: name,
          inputMuted: enabled,
        });
        break;
      case "recording": {
        const status = await client.call("GetRecordStatus");
        signal.throwIfAborted();
        if (status.outputActive !== enabled)
          await client.call(enabled ? "StartRecord" : "StopRecord");
        break;
      }
      case "streaming": {
        const status = await client.call("GetStreamStatus");
        signal.throwIfAborted();
        if (status.outputActive !== enabled)
          await client.call(enabled ? "StartStream" : "StopStream");
        break;
      }
      default:
        throw new Error("Unsupported OBS operation");
    }
    return { accepted: true };
  }
  async close() {
    this.generation++;
    await Promise.allSettled(
      [...this.clients.values()].map((client) => client.disconnect()),
    );
    this.clients.clear();
  }
}
