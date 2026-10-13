import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import {
  listStreamDecks,
  openStreamDeck,
  type StreamDeck,
} from "@elgato-stream-deck/node";
import {
  appearanceSchema,
  type DeviceStatus,
  type KeyBinding,
} from "../shared/schema";
import { Images, WriteQueue } from "./images";
const port = process.parentPort!,
  send = (data: unknown) => port.postMessage(data);
const images = new Images();
let page: Record<string, KeyBinding["appearance"]> = {},
  brightness = 70,
  simulator = true,
  assetDirectory = "",
  scanning = false,
  stopping = false;
const connections = new Map<
  string,
  {
    deck: StreamDeck;
    queue: WriteQueue;
    status: DeviceStatus;
    path: string;
    sent: Map<number, string>;
  }
>();
const report = () =>
  send({
    type: "devices",
    devices: [
      ...(simulator
        ? [
            {
              id: "simulator-xl",
              name: "Stream Deck XL · Simulator",
              connected: true,
              simulated: true,
              rows: 4,
              columns: 8,
              iconSize: 96,
            },
          ]
        : []),
      ...[...connections.values()].map((c) => c.status),
    ],
  });
function draw(id: string) {
  const connection = connections.get(id);
  if (!connection) return;
  connection.queue.set(-1, () => connection.deck.setBrightness(brightness));
  for (const control of connection.deck.CONTROLS) {
    if (control.type !== "button" || control.feedbackType !== "lcd") continue;
    const key = control.index,
      appearance = page[key] ?? {
        label: "",
        icon: "",
        background: "#111214",
        running: "#5865f2",
        success: "#23a559",
        error: "#f23f42",
      },
      signature = JSON.stringify(appearance);
    if (connection.sent.get(key) === signature) continue;
    connection.sent.set(key, signature);
    connection.queue.set(key, async () => {
      const asset =
        appearance.asset && assetDirectory
          ? await readFile(join(assetDirectory, appearance.asset)).catch(
              () => undefined,
            )
          : undefined;
      const buffer = await images.render(
        appearance,
        control.pixelSize.width,
        asset,
      );
      await connection.deck.fillKeyBuffer(key, buffer, { format: "rgb" });
    });
  }
}
async function disconnect(id: string, error?: unknown) {
  const c = connections.get(id);
  if (!c) return;
  connections.delete(id);
  c.queue.close();
  send({ type: "disconnect", id });
  await c.deck.close().catch(() => {});
  if (error)
    send({
      type: "diagnostic",
      error: `${c.status.name}: ${String(error)}. Check USB connection and udev permissions.`,
    });
  report();
}
async function scan() {
  if (scanning || stopping) return;
  scanning = true;
  try {
    const found = await listStreamDecks();
    for (const [id, c] of connections)
      if (!found.some((d) => d.path === c.path)) await disconnect(id);
    for (const info of found) {
      const id = info.serialNumber
        ? `${info.model}:${info.serialNumber}`
        : `session:${info.path}`;
      if (connections.has(id)) continue;
      try {
        const deck = await openStreamDeck(info.path),
          controls = deck.CONTROLS.filter((c) => c.type === "button"),
          first = controls.find((c) => c.feedbackType === "lcd");
        const status: DeviceStatus = {
          id,
          name: deck.PRODUCT_NAME,
          connected: true,
          simulated: false,
          rows: Math.max(...controls.map((c) => c.row)) + 1,
          columns: Math.max(...controls.map((c) => c.column)) + 1,
          iconSize: first?.feedbackType === "lcd" ? first.pixelSize.width : 96,
        };
        const queue = new WriteQueue((error) => {
          void disconnect(id, error);
        });
        connections.set(id, {
          deck,
          queue,
          status,
          path: info.path,
          sent: new Map(),
        });
        deck.on("down", (control) => {
          if (control.type === "button")
            send({ type: "key", id, key: control.index, down: true });
        });
        deck.on("up", (control) => {
          if (control.type === "button")
            send({ type: "key", id, key: control.index, down: false });
        });
        deck.on("error", (error) => {
          void disconnect(id, error);
        });
        draw(id);
      } catch (error) {
        send({
          type: "diagnostic",
          error: `Cannot open ${info.modelInfo.name}: ${String(error)}. Install the documented udev rule and reconnect; do not run Decker as root.`,
        });
      }
    }
    report();
  } catch (error) {
    send({ type: "diagnostic", error: String(error) });
  } finally {
    scanning = false;
  }
}
const schema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("configure"),
    page: z.record(z.string(), appearanceSchema),
    brightness: z.number().min(0).max(100),
    simulator: z.boolean(),
    assetDirectory: z.string(),
  }),
  z.object({
    type: z.literal("simulate"),
    key: z.number().int().min(0).max(31),
    down: z.boolean(),
  }),
  z.object({ type: z.literal("refresh") }),
  z.object({ type: z.literal("stop") }),
]);
port.on("message", async (event) => {
  try {
    const message = schema.parse(event.data);
    switch (message.type) {
      case "configure":
        page = message.page;
        brightness = message.brightness;
        assetDirectory = message.assetDirectory;
        if (simulator && !message.simulator)
          send({ type: "disconnect", id: "simulator-xl" });
        simulator = message.simulator;
        for (const id of connections.keys()) draw(id);
        report();
        break;
      case "simulate":
        if (simulator)
          send({
            type: "key",
            id: "simulator-xl",
            key: message.key,
            down: message.down,
          });
        break;
      case "refresh":
        for (const c of connections.values()) c.sent.clear();
        for (const id of connections.keys()) draw(id);
        void scan();
        break;
      case "stop":
        stopping = true;
        await Promise.all([...connections.keys()].map((id) => disconnect(id)));
        process.exit(0);
    }
  } catch (error) {
    send({ type: "diagnostic", error: String(error) });
  }
});
setInterval(() => void scan(), 2000).unref();
send({ type: "ready" });
void scan();
