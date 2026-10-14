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
  send = (data: unknown) => port.postMessage(data),
  images = new Images();
const frameSchema = z.object({
  deckId: z.string(),
  hardwareId: z.string(),
  brightness: z.number().int().min(0).max(100),
  page: z.record(z.string(), appearanceSchema),
});
type Frame = z.infer<typeof frameSchema>;
let frames: Frame[] = [],
  assetDirectory = "",
  scanning = false,
  stopping = false,
  foundDevices: DeviceStatus[] = [];
const connections = new Map<
  string,
  {
    deck: StreamDeck;
    queue: WriteQueue;
    path: string;
    desired: Map<number, string>;
  }
>();
const report = () => send({ type: "devices", devices: foundDevices });
function draw(id: string) {
  const connection = connections.get(id),
    frame = frames.find((f) => f.hardwareId === id);
  if (!connection || !frame) return;
  const brightness = frame.brightness;
  connection.queue.set(-1, () => connection.deck.setBrightness(brightness));
  for (const control of connection.deck.CONTROLS) {
    if (control.type !== "button" || control.feedbackType !== "lcd") continue;
    const key = control.index,
      appearance = frame.page[key] ?? {
        label: "",
        icon: "",
        background: "#111214",
        running: "#5865f2",
        success: "#23a559",
        error: "#f23f42",
      },
      signature = JSON.stringify(appearance);
    if (connection.desired.get(key) === signature) continue;
    connection.desired.set(key, signature);
    connection.queue.set(key, async () => {
      const asset = appearance.asset
        ? await readFile(join(assetDirectory, appearance.asset)).catch(
            () => undefined,
          )
        : undefined;
      const image = await images.render(
        appearance,
        control.pixelSize.width,
        asset,
      );
      await connection.deck.fillKeyBuffer(key, image, { format: "rgb" });
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
      error: `${id}: ${String(error)}. Check USB and udev permissions.`,
    });
}
async function scan() {
  if (scanning || stopping) return;
  scanning = true;
  try {
    const found = await listStreamDecks();
    send({ type: "nativeReady" });
    foundDevices = [];
    for (const info of found) {
      const id = info.serialNumber
          ? `${info.model}:${info.serialNumber}`
          : `session:${info.path}`,
        controls = info.modelInfo.controls.filter((c) => c.type === "button"),
        first = controls.find((c) => c.feedbackType === "lcd");
      foundDevices.push({
        id,
        name: info.modelInfo.name,
        connected: true,
        simulated: false,
        rows: Math.max(1, ...controls.map((c) => c.row + 1)),
        columns: Math.max(1, ...controls.map((c) => c.column + 1)),
        iconSize: first?.feedbackType === "lcd" ? first.pixelSize.width : 96,
      });
      if (!frames.some((f) => f.hardwareId === id) || connections.has(id))
        continue;
      try {
        const deck = await openStreamDeck(info.path),
          queue = new WriteQueue((error) => {
            void disconnect(id, error);
          });
        connections.set(id, {
          deck,
          queue,
          path: info.path,
          desired: new Map(),
        });
        deck.on("down", (c) => {
          if (c.type === "button")
            send({ type: "key", id, key: c.index, down: true });
        });
        deck.on("up", (c) => {
          if (c.type === "button")
            send({ type: "key", id, key: c.index, down: false });
        });
        deck.on("error", (error) => {
          void disconnect(id, error);
        });
        draw(id);
      } catch (error) {
        send({
          type: "diagnostic",
          error: `Cannot open ${info.modelInfo.name}: ${String(error)}. Check udev permissions; run without root.`,
        });
      }
    }
    for (const [id, c] of connections)
      if (
        !found.some((d) => d.path === c.path) ||
        !frames.some((f) => f.hardwareId === id)
      )
        await disconnect(id);
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
    frames: z.array(frameSchema).max(64),
    assetDirectory: z.string(),
  }),
  z.object({ type: z.literal("refresh") }),
  z.object({ type: z.literal("stop") }),
]);
port.on("message", async (event) => {
  try {
    const m = schema.parse(event.data);
    if (m.type === "configure") {
      frames = m.frames;
      assetDirectory = m.assetDirectory;
      for (const id of connections.keys()) draw(id);
      void scan();
    } else if (m.type === "refresh") {
      for (const c of connections.values()) c.desired.clear();
      for (const id of connections.keys()) draw(id);
      void scan();
    } else {
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
