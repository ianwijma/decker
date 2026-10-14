import { access, readFile } from "node:fs/promises";
import { constants } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { appearanceSchema } from "../shared/schema";
import { Images } from "./images";
import { accessProbe, probeDeviceAccess } from "../adapters/linux/diagnostics";
import { hardwareIdentity } from "./session";
import { DeviceSessions } from "./session";

const port = process.parentPort!,
  send = (data: unknown) => port.postMessage(data),
  images = new Images();
// Keep the worker alive when the native driver cannot load, so native availability
// can be reported independently from the configured devices' readiness.
let driver: Promise<typeof import("@elgato-stream-deck/node")> | undefined;
const native = () => (driver ??= import("@elgato-stream-deck/node"));
const sessions = new DeviceSessions(
  {
    discover: async () => {
      const discovered = await (await native()).listStreamDecks();
      if (process.platform === "linux") {
        const evidence = await Promise.all(
          discovered.map(async (info) => [
            hardwareIdentity(info),
            await probeDeviceAccess(info.path, info.model, accessProbe),
          ]),
        );
        send({ type: "hardwareAccess", value: Object.fromEntries(evidence) });
      }
      return discovered;
    },
    open: async (path) => (await native()).openStreamDeck(path),
    permissionDenied: async (path) => {
      if (process.platform !== "linux") return false;
      try {
        await access(path, constants.R_OK | constants.W_OK);
        return false;
      } catch (error) {
        return ["EACCES", "EPERM"].includes(
          (error as NodeJS.ErrnoException).code ?? "",
        );
      }
    },
    render: async (appearance, size, directory) => {
      const asset = appearance.asset
        ? await readFile(join(directory, appearance.asset)).catch(
            () => undefined,
          )
        : undefined;
      return images.render(appearance, size, asset);
    },
  },
  send,
);
const frameSchema = z.object({
  deckId: z.string(),
  hardwareId: z.string(),
  name: z.string().optional(),
  rows: z.number().int().positive().optional(),
  columns: z.number().int().positive().optional(),
  brightness: z.number().int().min(0).max(100),
  page: z.record(
    z.string(),
    appearanceSchema.extend({ stateLabel: z.string().max(40).optional() }),
  ),
});
const schema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("configure"),
    frames: z.array(frameSchema).max(64),
    assetDirectory: z.string(),
  }),
  z.object({ type: z.literal("refresh"), id: z.string().optional() }),
  z.object({ type: z.literal("stop") }),
]);
port.on("message", async (event) => {
  try {
    const message = schema.parse(event.data);
    if (message.type === "configure")
      sessions.configure(message.frames, message.assetDirectory);
    else if (message.type === "refresh") sessions.refresh(message.id);
    else {
      clearInterval(scanning);
      await sessions.stop();
      process.exit(0);
    }
  } catch (error) {
    send({ type: "diagnostic", error: String(error) });
  }
});
const scanning = setInterval(() => void sessions.scan(), 2000);
scanning.unref();
send({ type: "ready" });
void sessions.scan();
