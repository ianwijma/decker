import { open, readFile, rename, unlink } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { AppDocument } from "../shared/schema";
import { toggleBindings, toggleKey } from "../shared/toggle-contract";
import { toggleStamp, toggleDefinitionStamp } from "../runtime/targets";

const entrySchema = z
  .object({
    key: z.string().max(1000),
    stamp: z.string().regex(/^[a-f0-9]{64}$/),
    confirmed: z.enum(["on", "off"]).optional(),
    pending: z.string().max(160).optional(),
  })
  .strict();
export type StoredToggle = z.infer<typeof entrySchema>;
export type ToggleStorageRequest = {
  operation: "read" | "prepare" | "commit" | "recover";
  key: string;
  stamp: string;
  definitionStamp?: string;
  confirmed?: "on" | "off";
  token?: string;
};
export const toggleStorageRequestSchema = z
  .object({
    operation: z.enum(["read", "prepare", "commit", "recover"]),
    key: z.string().max(1000),
    stamp: z.string().regex(/^[a-f0-9]{64}$/),
    definitionStamp: z
      .string()
      .regex(/^[a-f0-9]{64}$/)
      .optional(),
    confirmed: z.enum(["on", "off"]).optional(),
    token: z.string().min(1).max(160).optional(),
  })
  .strict();

/** Main only, called inside the existing document mutation queue. No renderer state. */
export class ToggleStorage {
  private entries = new Map<string, StoredToggle>();
  private failure = false;
  constructor(private directory: string) {}
  async load() {
    try {
      const raw = await readFile(join(this.directory, "toggles.json"), "utf8");
      if (Buffer.byteLength(raw) > 4_000_000) throw new Error("oversized");
      const data = z
        .object({
          version: z.literal(1),
          entries: z.array(entrySchema).max(4096),
        })
        .strict()
        .parse(JSON.parse(raw));
      this.entries = new Map(data.entries.map((e) => [e.key, e]));
      if (this.entries.size !== data.entries.length)
        throw new Error("duplicate");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT")
        this.failure = true;
    }
  }
  async request(
    raw: ToggleStorageRequest,
    document: AppDocument,
  ): Promise<StoredToggle | null> {
    const request = toggleStorageRequestSchema.parse(raw);
    if (this.failure) throw new Error("Toggle storage unavailable");
    const bindings = toggleBindings(document);
    const live = new Map(
      bindings.map(({ deckId, binding }) => [
        toggleKey(deckId, binding),
        toggleStamp(binding),
      ]),
    );
    if (live.get(request.key) !== request.stamp)
      throw new Error("Stale toggle identity");
    if (request.definitionStamp) {
      const configured = bindings.find(
        ({ deckId, binding }) => toggleKey(deckId, binding) === request.key,
      );
      if (
        !configured ||
        toggleDefinitionStamp(configured.binding, document) !==
          request.definitionStamp
      )
        throw new Error("Stale toggle definition");
    }
    const old = this.entries.get(request.key);
    const previous = old?.stamp === request.stamp ? old : undefined;
    if (request.operation === "read")
      return previous ? structuredClone(previous) : null;
    if (
      request.operation === "prepare" &&
      (!request.token || previous?.pending)
    )
      throw new Error("Uncertain toggle state");
    if (
      request.operation === "commit" &&
      (!request.token || previous?.pending !== request.token)
    )
      throw new Error("Stale toggle transition");
    const entry: StoredToggle = {
      key: request.key,
      stamp: request.stamp,
      ...(request.confirmed ? { confirmed: request.confirmed } : {}),
      ...(request.operation === "prepare" ? { pending: request.token } : {}),
    };
    const next = new Map(
      [...this.entries].filter(([key, value]) => live.get(key) === value.stamp),
    );
    next.set(entry.key, entry);
    const path = join(this.directory, "toggles.json"),
      temporary = `${path}.${randomUUID()}.tmp`;
    try {
      const file = await open(temporary, "wx", 0o600);
      try {
        await file.writeFile(
          JSON.stringify({ version: 1, entries: [...next.values()] }),
        );
        await file.sync();
      } finally {
        await file.close();
      }
      await rename(temporary, path);
      const directory = await open(this.directory, "r");
      try {
        await directory.sync();
      } finally {
        await directory.close();
      }
      this.entries = next;
    } catch {
      this.failure = true;
      throw new Error("Toggle state could not be committed");
    } finally {
      await unlink(temporary).catch(() => {});
    }
    return structuredClone(entry);
  }
}
