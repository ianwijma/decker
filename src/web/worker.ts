import { readFile, writeFile, rename } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import { WebDeckServer, type StoredClient } from "./server";
import type { WebDeckView } from "../shared/schema";
const port = process.parentPort!,
  send = (message: unknown) => port.postMessage(message);
const view = z.object({
  id: z.string(),
  name: z.string(),
  rows: z.number().int().min(1).max(16),
  columns: z.number().int().min(1).max(16),
  pageName: z.string(),
  version: z.string(),
  accent: z.string().regex(/^#[a-f0-9]{6}$/i),
  keys: z.record(
    z.string(),
    z.object({
      stateLabel: z.string().max(40).optional(),
      imageStatus: z.literal("stale").optional(),
      refreshStatus: z.string().max(40).optional(),
      toggle: z
        .object({
          confirmed: z.enum(["on", "off", "unknown"]),
          busy: z.boolean(),
          disabled: z.boolean(),
          summary: z.string().max(400),
        })
        .strict()
        .optional(),
      label: z.string(),
      icon: z.string(),
      background: z.string().regex(/^#[a-f0-9]{6}$/i),
      asset: z
        .string()
        .regex(/^[a-f0-9]{64}$/)
        .optional(),
    }),
  ),
});
const schema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("configure"),
    views: z.array(view).max(64),
    enabled: z.boolean(),
    port: z.number().int().min(0).max(65535),
    rendererDirectory: z.string(),
    assetDirectory: z.string(),
    directory: z.string(),
  }),
  z.object({ type: z.literal("invite"), id: z.string(), deckId: z.string() }),
  z.object({
    type: z.literal("approve"),
    id: z.string(),
    pairingId: z.string(),
    approved: z.boolean(),
  }),
  z.object({ type: z.literal("revoke"), id: z.string(), clientId: z.string() }),
  z.object({ type: z.literal("stop") }),
  z.object({ type: z.literal("resetPairings") }),
]);
let server: WebDeckServer | undefined,
  runningPort = -1,
  pendingSave = Promise.resolve(),
  queue = Promise.resolve();
port.on("message", (event) => {
  queue = queue
    .catch(() => {})
    .then(async () => {
      try {
        const m = schema.parse(event.data);
        if (m.type === "configure") {
          if (!server)
            server = new WebDeckServer({
              rendererDirectory: m.rendererDirectory,
              assetDirectory: m.assetDirectory,
              loadClients: async () => {
                try {
                  return z
                    .array(
                      z.object({
                        id: z.string(),
                        deckId: z.string(),
                        name: z.string(),
                        tokenHash: z.string().regex(/^[a-f0-9]{64}$/),
                        createdAt: z.number(),
                        lastSeen: z.number(),
                      }),
                    )
                    .max(64)
                    .parse(
                      JSON.parse(
                        await readFile(
                          join(m.directory, "web-clients.json"),
                          "utf8",
                        ),
                      ),
                    );
                } catch {
                  return [];
                }
              },
              saveClients: (clients) => {
                const contents = JSON.stringify(clients);
                pendingSave = pendingSave
                  .catch(() => {})
                  .then(async () => {
                    const path = join(m.directory, "web-clients.json");
                    await writeFile(`${path}.tmp`, contents, { mode: 0o600 });
                    await rename(`${path}.tmp`, path);
                  });
                return pendingSave;
              },
              input: (event) => send({ type: "input", ...event }),
              visibilityLost: (source) =>
                send({ type: "visibilityLost", source }),
              visibility: (event) => send({ type: "visibility", ...event }),
              disconnect: (source) => send({ type: "disconnect", source }),
              status: (status) => send({ type: "status", status }),
              error: (error) => send({ type: "error", error: String(error) }),
            });
          if (!m.enabled) {
            await server.stop();
            runningPort = -1;
            return;
          }
          if (runningPort !== m.port) {
            await server.stop();
            server.configure(m.views as WebDeckView[]);
            await server.start(m.port);
            runningPort = m.port;
          } else server.configure(m.views as WebDeckView[]);
        } else if (m.type === "stop") {
          await server?.stop();
          await pendingSave;
          process.exit(0);
        } else if (m.type === "resetPairings") {
          await server?.resetPairings();
          await server?.stop();
          server = undefined;
          runningPort = -1;
          await pendingSave; /* Main replaces the persisted pairing file before the next configure. */
        } else {
          if (!server) throw new Error("Web decks are starting");
          let value: unknown = null;
          if (m.type === "invite") value = server.invite(m.deckId);
          else if (m.type === "approve")
            server.approve(m.pairingId, m.approved);
          else server.revoke(m.clientId);
          send({ type: "reply", id: m.id, value });
        }
      } catch (error) {
        const id = (event.data as { id?: string })?.id;
        send(
          id
            ? { type: "reply", id, error: String(error) }
            : { type: "error", error: String(error) },
        );
      }
    });
});
send({ type: "ready" });
