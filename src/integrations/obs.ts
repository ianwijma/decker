import type OBSWebSocket from "obs-websocket-js/json";
import { DisposableObsClient } from "./obs-client";
import { withCancellation } from "../runtime/cancellation";
import type { AppDocument, Json, ObservationSource } from "../shared/schema";
export class ObsConnections {
  private state = new Map<string, Record<string, Json>>();
  private generation = 0;
  private revision = 0;
  private fieldRevisions = new Map<string, Map<string, number>>();
  private update(id: string, patch: Record<string, Json>, sampledAt?: number) {
    const version = sampledAt ?? ++this.revision;
    const revisions = this.fieldRevisions.get(id) ?? new Map<string, number>();
    const entries = Object.entries(patch).filter(
      ([key]) => (revisions.get(key) ?? -1) <= version,
    );
    if (!entries.length) return;
    const value = { ...this.state.get(id), ...Object.fromEntries(entries) };
    this.state.set(id, value);
    for (const [key] of entries) revisions.set(key, version);
    this.fieldRevisions.set(id, revisions);
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
      this.fieldRevisions.delete(connection.id);
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
    const revisions = () => ++this.revision;
    const sampled = (patch: Record<string, Json>, version: number) => {
      if (current()) this.update(connection.id, patch, version);
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
        const sceneBefore = revisions();
        const scene = await withCancellation(
          client.call("GetCurrentProgramScene"),
          AbortSignal.any([abort.signal, AbortSignal.timeout(3000)]),
          0,
        );
        if (!current()) throw new Error("OBS configuration changed");
        sampled(
          { connected: true, scene: scene.currentProgramSceneName },
          sceneBefore,
        );
        const observe = async () => {
          const before = revisions();
          const [recording, streaming, inputs, scenes] = await Promise.all([
            client.call("GetRecordStatus"),
            client.call("GetStreamStatus"),
            client.call("GetInputList"),
            client.call("GetSceneList"),
          ]);
          if (!current()) return;
          sampled(
            {
              recording: recording.outputActive,
              streaming: streaming.outputActive,
            },
            before,
          );
          await Promise.allSettled(
            inputs.inputs.slice(0, 64).map(async (input) => {
              if (!current()) return;
              const inputName = String(input.inputName);
              const before = revisions();
              const result = await client.call("GetInputMute", { inputName });
              sampled({ [`mute:${inputName}`]: result.inputMuted }, before);
            }),
          );
          await Promise.allSettled(
            scenes.scenes.slice(0, 64).map(async (scene) => {
              if (!current()) return;
              const sceneName = String(scene.sceneName);
              const before = revisions();
              const result = await client.call("GetSceneItemList", {
                sceneName,
              });
              sampled(
                Object.fromEntries(
                  result.sceneItems.map((item) => [
                    `source:${sceneName}:${item.sceneItemId}`,
                    typeof item.sceneItemEnabled === "boolean"
                      ? item.sceneItemEnabled
                      : null,
                  ]),
                ),
                before,
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
  /** Bounded read through the existing connection, never an arbitrary OBS request. */
  async readObservation(
    connection: AppDocument["connections"][number],
    password: string | undefined,
    source: Extract<ObservationSource, { kind: "obs" }>,
    accept: () => boolean,
  ): Promise<Record<string, Json>> {
    const client = await this.get(connection, password),
      generation = this.generation;
    const session = this.sessions.get(connection.id);
    const current = () =>
      accept() &&
      generation === this.generation &&
      this.sessions.get(connection.id)?.client === client;
    if (!session || !current()) throw new Error("OBS observation replaced");
    const key =
      source.property === "scene"
        ? "scene"
        : source.property === "mute"
          ? `mute:${source.name}`
          : source.property === "source"
            ? `source:${source.name}:${source.sourceId}`
            : source.property;
    const sampledAt = ++this.revision;
    const newer = () =>
      (this.fieldRevisions.get(connection.id)?.get(key) ?? -1) > sampledAt;
    try {
      const read = async (): Promise<Json> => {
        if (source.property === "scene")
          return (await client.call("GetCurrentProgramScene"))
            .currentProgramSceneName;
        if (source.property === "recording")
          return (await client.call("GetRecordStatus")).outputActive;
        if (source.property === "streaming")
          return (await client.call("GetStreamStatus")).outputActive;
        if (source.property === "mute")
          return (await client.call("GetInputMute", { inputName: source.name }))
            .inputMuted;
        const list = await client.call("GetSceneItemList", {
          sceneName: source.name,
        });
        const item = list.sceneItems.find(
          (item) => item.sceneItemId === source.sourceId,
        );
        return typeof item?.sceneItemEnabled === "boolean"
          ? item.sceneItemEnabled
          : null;
      };
      const value = await withCancellation(
        read(),
        AbortSignal.any([session.abort.signal, AbortSignal.timeout(3000)]),
        0,
      );
      if (!current()) throw new Error("OBS observation replaced");
      // An event received after the query started is newer than its response.
      if (!newer())
        this.update(
          connection.id,
          {
            connected: true,
            [key]:
              typeof value ===
              (source.property === "scene" ? "string" : "boolean")
                ? value
                : null,
          },
          sampledAt,
        );
      return { ...this.state.get(connection.id) };
    } catch (error) {
      if (current()) {
        if (newer()) return { ...this.state.get(connection.id) };
        this.update(connection.id, { [key]: null }, sampledAt);
      }
      throw error;
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
    const sessions = [...this.sessions.entries()];
    this.sessions.clear();
    this.state.clear();
    this.fieldRevisions.clear();
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
