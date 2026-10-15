import { open, readFile, unlink, stat, lstat } from "node:fs/promises";
import { renameSync, openSync, fsyncSync, closeSync } from "node:fs";
import { join } from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { z } from "zod";
import sharp from "sharp";
import { activityKey } from "../shared/feedback";
import {
  displayPatchSchema,
  displayUpdateSchema,
  displayFields,
  type DisplayPatch,
} from "../shared/display-contract";
import {
  buttonOriginSchema,
  originBinding,
  originKey,
  type ButtonOrigin,
  type LaunchSource,
  type TrustedLaunch,
} from "../shared/trigger-context";
import { toggleDefinitionStamp } from "../runtime/targets";
import { bindingExecutionIdentity } from "../shared/toggle-identity";
import type { AppDocument, Json } from "../shared/schema";

const entrySchema = z
  .object({ origin: buttonOriginSchema, fields: displayPatchSchema })
  .strict();
type Entry = z.infer<typeof entrySchema>;
type Authority = {
  source: LaunchSource;
  stamp: string;
  order: number;
  runId?: string;
  actions: Set<string>;
};
export const DISPLAY_LIMITS = {
  entries: 4096,
  bytes: 1_000_000,
  authorities: 4096,
};

/** Main owns this service. Calls to commit are serialized with document mutations.
 * Public IDs never confer authority; tokens are issued only by trusted launch paths.
 */
export class DisplayState {
  private entries = new Map<string, Entry>();
  private authorities = new Map<string, Authority>();
  private owners = new Map<string, number>();
  private sequence = 0;
  private epoch = 0;
  private blocked = false;
  constructor(
    private directory: string,
    private assetDirectory: string,
    private current: () => AppDocument,
    private limits = DISPLAY_LIMITS,
    private secrets: () => string[] = () => [],
  ) {}
  private stamp(origin: ButtonOrigin) {
    const binding = originBinding(this.current(), origin);
    return binding
      ? createHash("sha256")
          .update(
            JSON.stringify([
              bindingExecutionIdentity(binding),
              toggleDefinitionStamp(binding, this.current()),
            ]),
          )
          .digest("hex")
      : undefined;
  }
  accept(kind: LaunchSource["kind"], origin?: ButtonOrigin): TrustedLaunch {
    if (!["button", "test", "refresh"].includes(kind)) origin = undefined;
    const source: LaunchSource = {
      kind,
      invocationId: randomUUID(),
      ...(origin ? { origin: structuredClone(origin) } : {}),
    };
    if (!origin || kind === "probe") return { source };
    const stamp = this.stamp(origin);
    if (!stamp) throw new Error("Triggering button changed; save and retry");
    if (this.authorities.size >= this.limits.authorities) {
      const pending = [...this.authorities].find(([, a]) => !a.runId);
      if (pending) this.end(pending[0]);
      else throw new Error("Too many display invocations");
    }
    const authority = randomUUID();
    this.authorities.set(authority, {
      source: structuredClone(source),
      stamp,
      order: ++this.sequence,
      actions: new Set(),
    });
    return { source, authority };
  }
  /** Reliable lifecycle messages precede effects, independently of batched history. */
  begin(token: string, runId: string) {
    const a = this.authorities.get(token);
    if (
      !a ||
      a.runId ||
      !a.source.origin ||
      this.stamp(a.source.origin) !== a.stamp
    )
      return;
    a.runId = runId;
    const key = originKey(a.source.origin);
    this.owners.set(key, Math.max(this.owners.get(key) ?? 0, a.order));
  }
  end(token: string) {
    const origin = this.authorities.get(token)?.source.origin;
    this.authorities.delete(token);
    if (
      origin &&
      ![...this.authorities.values()].some(
        (a) =>
          a.source.origin && originKey(a.source.origin) === originKey(origin),
      )
    )
      this.owners.delete(originKey(origin));
  }
  cancelRun(runId: string) {
    for (const [token, a] of this.authorities)
      if (a.runId === runId) this.end(token);
  }
  action(token: string, runId: string, actionId: string, active: boolean) {
    const a = this.authorities.get(token);
    if (!a || a.runId !== runId) return;
    if (active && a.actions.size < 64) a.actions.add(actionId);
    else a.actions.delete(actionId);
  }
  invalidate() {
    this.epoch++;
    this.authorities.clear();
    this.owners.clear();
  }
  reconcile() {
    for (const [token, a] of this.authorities)
      if (!a.source.origin || this.stamp(a.source.origin) !== a.stamp)
        this.end(token);
    for (const [key, e] of this.entries)
      if (!originBinding(this.current(), e.origin)) this.entries.delete(key);
    const live = new Set(
      [...this.authorities.values()].flatMap((a) =>
        a.source.origin ? [originKey(a.source.origin)] : [],
      ),
    );
    for (const key of this.owners.keys())
      if (!live.has(key)) this.owners.delete(key);
  }
  private async validAsset(hash: string) {
    const path = join(this.assetDirectory, hash),
      file = await lstat(path);
    if (!file.isFile() || file.size > 5_000_000)
      throw new Error("Local image unavailable; upload it first");
    const bytes = await readFile(path);
    if (createHash("sha256").update(bytes).digest("hex") !== hash)
      throw new Error("Invalid local image; upload it first");
    const metadata = await sharp(bytes, {
      limitInputPixels: 16_000_000,
    }).metadata();
    if (
      !["png", "jpeg", "webp"].includes(metadata.format ?? "") ||
      !metadata.width ||
      !metadata.height ||
      metadata.width * metadata.height > 16_000_000
    )
      throw new Error("Invalid local image; upload it first");
  }
  async load() {
    try {
      const path = join(this.directory, "display-cache.json");
      if ((await stat(path)).size > this.limits.bytes)
        throw new Error("oversized");
      const cache = z
        .object({
          version: z.literal(1),
          entries: z.array(entrySchema).max(this.limits.entries),
        })
        .strict()
        .parse(JSON.parse(await readFile(path, "utf8")));
      const next = new Map<string, Entry>();
      for (const entry of cache.entries) {
        const key = originKey(entry.origin);
        if (next.has(key)) throw new Error("duplicate");
        if (!originBinding(this.current(), entry.origin)) continue;
        if (entry.fields.asset) {
          try {
            await this.validAsset(entry.fields.asset);
          } catch {
            delete entry.fields.asset;
          }
        }
        next.set(key, entry);
      }
      this.entries = next;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        // Cache is disposable. Preserve damaged bytes for diagnosis; never touch workspace.
        try {
          renameSync(
            join(this.directory, "display-cache.json"),
            join(this.directory, "display-cache.corrupt.json"),
          );
        } catch {
          this.blocked = true;
        }
      }
      this.entries.clear();
    }
  }
  private validate(token?: string, runId?: string, actionId?: string) {
    const a = token ? this.authorities.get(token) : undefined;
    if (
      !a?.source.origin ||
      a.runId !== runId ||
      !actionId ||
      !a.actions.has(actionId)
    )
      throw new Error(
        "No valid triggering button. Run this workflow from a saved key.",
      );
    if (
      this.stamp(a.source.origin) !== a.stamp ||
      this.owners.get(originKey(a.source.origin)) !== a.order
    )
      throw new Error("Triggering button invocation is stale or superseded");
    return a;
  }
  async commit(
    raw: unknown,
    context: { authority?: string; runId?: string; actionId?: string },
  ) {
    const patch = displayUpdateSchema.parse(raw),
      a = this.validate(context.authority, context.runId, context.actionId),
      origin = a.source.origin!,
      key = originKey(origin),
      epoch = this.epoch;
    if (this.blocked)
      throw new Error(
        "Display cache storage unavailable; repair storage and restart",
      );
    for (const field of ["label", "icon"] as const) {
      const value = patch[field];
      if (value !== undefined) {
        let safe = value;
        for (const secret of this.secrets().filter(Boolean))
          safe = safe.split(secret).join("[redacted]");
        patch[field] = safe;
      }
    }
    displayUpdateSchema.parse(patch);
    if (patch.asset) await this.validAsset(patch.asset);
    this.validate(context.authority, context.runId, context.actionId);
    const fields: DisplayPatch = { ...this.entries.get(key)?.fields };
    for (const field of patch.reset ?? []) delete fields[field];
    for (const field of displayFields)
      if (patch[field] !== undefined)
        Object.assign(fields, { [field]: patch[field] });
    // Explicit icon clears both an earlier dynamic image and inherited image.
    if (patch.icon !== undefined && patch.asset === undefined)
      fields.asset = null;
    const next = new Map(
      [...this.entries].filter(([, e]) =>
        originBinding(this.current(), e.origin),
      ),
    );
    next.delete(key);
    if (Object.keys(fields).length) next.set(key, { origin, fields });
    const serialize = () =>
      JSON.stringify({ version: 1, entries: [...next.values()] });
    while (
      next.size > this.limits.entries ||
      Buffer.byteLength(serialize()) > this.limits.bytes
    )
      next.delete(next.keys().next().value!);
    const path = join(this.directory, "display-cache.json"),
      temporary = `${path}.${randomUUID()}.tmp`;
    try {
      const file = await open(temporary, "wx", 0o600);
      try {
        await file.writeFile(serialize());
        await file.sync();
      } finally {
        await file.close();
      }
      this.validate(context.authority, context.runId, context.actionId);
      if (epoch !== this.epoch)
        throw new Error("Display authority invalidated");
      // Linearization has no asynchronous boundary after the final authority check.
      renameSync(temporary, path);
      const directory = openSync(this.directory, "r");
      try {
        fsyncSync(directory);
      } finally {
        closeSync(directory);
      }
      this.entries = next;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code) this.blocked = true;
      throw error;
    } finally {
      await unlink(temporary).catch(() => {});
    }
  }
  /** References pin existing uploads, never own or delete uploaded bytes. PR22 may add GC. */
  assetReferences() {
    this.reconcile();
    return new Set(
      [...this.entries.values()].flatMap((e) =>
        e.fields.asset ? [e.fields.asset] : [],
      ),
    );
  }
  snapshot(): Record<string, Json> {
    this.reconcile();
    return Object.fromEntries(
      [...this.entries.values()].map((e) => [
        activityKey(e.origin.deckId, {
          id: e.origin.bindingId,
          generation: e.origin.generation,
        }),
        { ...e.fields },
      ]),
    );
  }
}
