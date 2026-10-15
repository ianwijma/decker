import { createHash } from "node:crypto";
import { WebSocketServer, type WebSocket } from "ws";
const sha = (value: string) =>
  createHash("sha256").update(value).digest("base64");
export async function fakeObs(
  options: {
    password?: string;
    incompatible?: boolean;
    stall?: boolean;
    echo?: string;
  } = {},
) {
  const server = new WebSocketServer({
    host: "127.0.0.1",
    port: 0,
    handleProtocols: (protocols) =>
      options.incompatible
        ? false
        : protocols.has("obswebsocket.json")
          ? "obswebsocket.json"
          : false,
  });
  await new Promise<void>((resolve, reject) => {
    server.once("listening", resolve);
    server.once("error", reject);
  });
  const frames: { op: number; d: Record<string, unknown> }[] = [];
  let connections = 0,
    scene = "Fixture scene",
    recording = false,
    streaming = false;
  server.on("connection", (socket) => {
    connections++;
    const send = (op: number, d: unknown) =>
      socket.send(JSON.stringify({ op, d }));
    if (options.stall || options.incompatible) return;
    send(0, {
      obsWebSocketVersion: "5.0.6",
      rpcVersion: 1,
      ...(options.password
        ? {
            authentication: {
              challenge: "fixture-challenge",
              salt: "fixture-salt",
            },
          }
        : {}),
    });
    socket.on("message", (raw) => {
      const frame = JSON.parse(String(raw));
      frames.push(frame);
      if (frame.op === 1) {
        if (
          options.password &&
          frame.d.authentication !==
            sha(sha(options.password + "fixture-salt") + "fixture-challenge")
        ) {
          socket.close(4009, options.echo ?? "Authentication failed");
          return;
        }
        send(2, { negotiatedRpcVersion: 1 });
      } else if (frame.op === 6) {
        const responses: Record<string, unknown> = {
          GetVersion: {
            obsVersion: "30.0.0",
            obsWebSocketVersion: "5.0.6",
            rpcVersion: 1,
            echoed: options.echo,
          },
          GetCurrentProgramScene: { currentProgramSceneName: scene },
          GetRecordStatus: { outputActive: recording },
          GetStreamStatus: { outputActive: streaming },
          GetInputList: { inputs: [] },
          GetSceneList: { scenes: [] },
        };
        const response = responses[frame.d.requestType];
        send(7, {
          requestType: frame.d.requestType,
          requestId: frame.d.requestId,
          requestStatus: {
            result: Boolean(response),
            code: response ? 100 : 204,
          },
          responseData: response ?? {},
        });
      }
    });
  });
  return {
    url: `ws://127.0.0.1:${(server.address() as { port: number }).port}`,
    frames,
    emit: (eventType: string, eventData: Record<string, unknown>) => {
      if (eventType === "CurrentProgramSceneChanged")
        scene = String(eventData.sceneName);
      if (eventType === "RecordStateChanged")
        recording = Boolean(eventData.outputActive);
      if (eventType === "StreamStateChanged")
        streaming = Boolean(eventData.outputActive);
      for (const socket of server.clients)
        socket.send(
          JSON.stringify({
            op: 5,
            d: { eventType, eventIntent: 1, eventData },
          }),
        );
    },
    get connections() {
      return connections;
    },
    get clients() {
      return server.clients.size;
    },
    close: async () => {
      for (const socket of server.clients as Set<WebSocket>) socket.terminate();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}
