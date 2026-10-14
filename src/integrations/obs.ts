import type OBSWebSocket from "obs-websocket-js/json";
import { DisposableObsClient } from "./obs-client";
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
  private sessions = new Map<
    string,
    {
      client: DisposableObsClient;
      signature: string;
      abort: AbortController;
      promise: Promise<OBSWebSocket>;
    }
  >();
  constructor(
    private observe: (id: string, value: Json) => void,
    private create: () => DisposableObsClient = () => new DisposableObsClient(),
  ) {}
  async get(
    connection: AppDocument["connections"][number],
    password?: string,
  ): Promise<OBSWebSocket> {
    const signature = JSON.stringify([
      connection.url,
      connection.credentialRef,
      password,
    ]);
    const old = this.sessions.get(connection.id);
    if (old?.signature === signature) return old.promise;
    if (old) {
      this.sessions.delete(connection.id);
      this.state.delete(connection.id);
      this.update(connection.id, { connected: false });
      old.abort.abort();
      void old.client.dispose();
    }
    const generation = this.generation;
    const abort = new AbortController();
    const client = this.create();
    const current = () =>
      generation === this.generation &&
      this.sessions.get(connection.id)?.client === client;
    const update = (patch: Record<string, Json>) => {
      if (current()) this.update(connection.id, patch);
    };
    client.on("ConnectionClosed", () => {
      if (!current()) return;
      this.sessions.delete(connection.id);
      this.update(connection.id, { connected: false });
    });
    client.on("ConnectionError", () =>
      update({ connected: false, error: "OBS connection unavailable" }),
    );
    client.on("CurrentProgramSceneChanged", (data) =>
      update({ connected: true, scene: data.sceneName }),
    );
    client.on("InputMuteStateChanged", (data) =>
      update({ connected: true, [`mute:${data.inputName}`]: data.inputMuted }),
    );
    client.on("RecordStateChanged", (data) =>
      update({ connected: true, recording: data.outputActive }),
    );
    client.on("StreamStateChanged", (data) =>
      update({ connected: true, streaming: data.outputActive }),
    );
    client.on("SceneItemEnableStateChanged", (data) =>
      update({
        connected: true,
        [`source:${data.sceneName}:${data.sceneItemId}`]: data.sceneItemEnabled,
      }),
    );
    // Start after installing the session so even synchronous client seams are guarded.
    const promise = Promise.resolve().then(async () => {
      try {
        if (!current()) throw new Error("OBS configuration changed");
        await withCancellation(
          client.connect(connection.url, password),
          AbortSignal.any([abort.signal, AbortSignal.timeout(5000)]),
          0,
        );
        if (!current()) throw new Error("OBS configuration changed");
        const scene = await withCancellation(
          client.call("GetCurrentProgramScene"),
          AbortSignal.any([abort.signal, AbortSignal.timeout(3000)]),
          0,
        );
        if (!current()) throw new Error("OBS configuration changed");
        update({ connected: true, scene: scene.currentProgramSceneName });
        const observe = async () => {
          const [recording, streaming, inputs, scenes] = await Promise.all([
            client.call("GetRecordStatus"),
            client.call("GetStreamStatus"),
            client.call("GetInputList"),
            client.call("GetSceneList"),
          ]);
          if (!current()) return;
          update({
            recording: recording.outputActive,
            streaming: streaming.outputActive,
          });
          await Promise.allSettled(
            inputs.inputs.slice(0, 64).map(async (input) => {
              if (!current()) return;
              const inputName = String(input.inputName);
              const result = await client.call("GetInputMute", { inputName });
              update({ [`mute:${inputName}`]: result.inputMuted });
            }),
          );
          await Promise.allSettled(
            scenes.scenes.slice(0, 64).map(async (scene) => {
              if (!current()) return;
              const sceneName = String(scene.sceneName);
              const result = await client.call("GetSceneItemList", {
                sceneName,
              });
              update(
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
        void withCancellation(
          observe(),
          AbortSignal.any([abort.signal, AbortSignal.timeout(5000)]),
          0,
        ).catch(() => {});
        return client;
      } catch (error) {
        if (current()) {
          this.sessions.delete(connection.id);
          this.update(connection.id, { connected: false });
        }
        await client.dispose();
        if (generation !== this.generation)
          throw new Error("OBS configuration changed");
        throw error;
      }
    });
    this.sessions.set(connection.id, { client, signature, abort, promise });
    return promise;
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
    const sessions = [...this.sessions.entries()];
    this.sessions.clear();
    this.state.clear();
    for (const [id, session] of sessions) {
      session.abort.abort();
      this.update(id, { connected: false });
    }
    await Promise.allSettled(
      sessions.map(async ([, session]) => {
        await session.client.dispose();
        await session.promise.catch(() => {});
      }),
    );
  }
}
