import {
  constants,
  linkSync,
  renameSync,
  openSync,
  closeSync,
  fsyncSync,
  lstatSync,
  unlinkSync,
} from "node:fs";
import { open, mkdir, readdir, unlink, lstat } from "node:fs/promises";
import { join } from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { z } from "zod";
import { assetHashSchema, IMAGE_LIMITS } from "../shared/remote-image";
import { ImageFailure } from "./remote-images";

export const GENERATED_LIMITS = {
  entries: 256,
  bytes: 64 * 1024 * 1024,
  runs: 64,
};
const entrySchema = z
  .object({
    hash: assetHashSchema,
    bytes: z.number().int().min(1).max(IMAGE_LIMITS.outputBytes),
    ino: z.number().int().positive().safe(),
  })
  .strict();
type Entry = z.infer<typeof entrySchema>;

/** No path existence/unreferenced heuristic confers ownership. Only this strict
 * write-ahead manifest permits deletion; unknown and promoted files are permanent. */
export class GeneratedAssets {
  private entries = new Map<string, Entry>();
  private leases = new Map<string, Set<string>>();
  private leaseExpirations = new Map<string, number>();
  private pending = Promise.resolve();
  private blocked = false;
  constructor(
    private directory: string,
    private assets: string,
    private authored: () => Set<string>,
    private dynamic: () => Set<string>,
    private limits = GENERATED_LIMITS,
    private now = Date.now,
  ) {}
  private serial<T>(operation: () => Promise<T>): Promise<T> {
    const next = this.pending.catch(() => {}).then(operation);
    this.pending = next.then(
      () => {},
      () => {},
    );
    return next;
  }
  private async read(path: string, max: number) {
    const file = await open(
      path,
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
    );
    try {
      const stat = await file.stat();
      if (!stat.isFile() || stat.size > max)
        throw new Error("Invalid asset file");
      const buffer = Buffer.alloc(stat.size + 1);
      const { bytesRead } = await file.read(buffer, 0, buffer.length, 0);
      if (bytesRead !== stat.size) throw new Error("Asset changed");
      return buffer.subarray(0, bytesRead);
    } finally {
      await file.close();
    }
  }
  private syncDirectory(path: string) {
    const fd = openSync(path, "r");
    try {
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
  }
  private async manifest() {
    const path = join(this.directory, "generated-assets.json"),
      temporary = `${path}.${randomUUID()}.tmp`;
    try {
      const file = await open(temporary, "wx", 0o600);
      try {
        await file.writeFile(
          JSON.stringify({ version: 1, entries: [...this.entries.values()] }),
        );
        await file.sync();
      } finally {
        await file.close();
      }
      renameSync(temporary, path);
      this.syncDirectory(this.directory);
    } catch (error) {
      this.blocked = true;
      throw error;
    } finally {
      await unlink(temporary).catch(() => {});
    }
  }
  async load() {
    await mkdir(this.assets, { recursive: true });
    try {
      const raw = await this.read(
        join(this.directory, "generated-assets.json"),
        64 * 1024,
      );
      const manifest = z
        .object({
          version: z.literal(1),
          entries: z.array(entrySchema).max(this.limits.entries),
        })
        .strict()
        .parse(JSON.parse(raw.toString("utf8")));
      if (
        new Set(manifest.entries.map((e) => e.hash)).size !==
          manifest.entries.length ||
        manifest.entries.reduce((n, e) => n + e.bytes, 0) > this.limits.bytes
      )
        throw new Error("Invalid manifest bounds");
      this.entries = new Map(manifest.entries.map((e) => [e.hash, e]));
      for (const [hash, entry] of this.entries) {
        try {
          const bytes = await this.read(
            join(this.assets, hash),
            IMAGE_LIMITS.outputBytes,
          );
          if (
            (await lstat(join(this.assets, hash))).ino !== entry.ino ||
            bytes.length !== entry.bytes ||
            createHash("sha256").update(bytes).digest("hex") !== hash
          ) {
            // Suspect files become unknown/permanent, never a deletion target.
            this.entries.delete(hash);
          }
        } catch {
          this.entries.delete(hash);
        }
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        this.blocked = true;
        this.entries.clear();
      }
    }
    // Only our exclusive staging namespace is disposable. Never sweep hashes.
    for (const name of await readdir(this.assets))
      if (
        /^\.generated-[a-f0-9-]{36}\.tmp$/.test(name) &&
        (await lstat(join(this.assets, name))).isFile()
      )
        await unlink(join(this.assets, name));
    for (const name of await readdir(this.directory))
      if (
        /^generated-assets\.json\.[a-f0-9-]{36}\.tmp$/.test(name) &&
        (await lstat(join(this.directory, name))).isFile()
      )
        await unlink(join(this.directory, name));
    // Caller loads DisplayState first, so restorable last-good art is already pinned.
    if (!this.blocked) await this.collect();
  }
  private pins() {
    this.expireLeases();
    return new Set([
      ...this.authored(),
      ...this.dynamic(),
      ...[...this.leases.values()].flatMap((s) => [...s]),
    ]);
  }
  private async promoteNow(hashes: Set<string>) {
    const changed = [...hashes].some((hash) => this.entries.has(hash));
    if (changed) {
      if (this.blocked)
        throw new ImageFailure(
          "Generated image storage needs repair and restart",
        );
      for (const hash of hashes) this.entries.delete(hash);
      await this.manifest();
    }
  }
  /** Called before committing authored documents, uploads or imports. */
  promote(hashes: Set<string>) {
    return this.serial(() => this.promoteNow(hashes));
  }
  author<T>(hashes: Set<string>, publish: () => Promise<T>) {
    return this.serial(async () => {
      await this.promoteNow(hashes);
      return publish();
    });
  }
  release(runId?: string) {
    if (runId) {
      this.leases.delete(runId);
      this.leaseExpirations.delete(runId);
    } else {
      this.leases.clear();
      this.leaseExpirations.clear();
    }
  }
  private expireLeases() {
    for (const [id, expires] of this.leaseExpirations)
      if (expires <= this.now()) this.release(id);
  }
  private async evict(bytes: number, extra: number, all = false) {
    await this.promoteNow(this.authored());
    const pins = this.pins();
    let total = [...this.entries.values()].reduce((n, e) => n + e.bytes, 0);
    for (const [hash, entry] of this.entries) {
      if (
        !all &&
        this.entries.size + extra <= this.limits.entries &&
        total + bytes <= this.limits.bytes
      )
        break;
      if (pins.has(hash)) continue;
      const path = join(this.assets, hash);
      // Recheck ownership content before deleting; replacement/corruption is not ours.
      try {
        const current = await this.read(path, IMAGE_LIMITS.outputBytes);
        if (
          current.length === entry.bytes &&
          createHash("sha256").update(current).digest("hex") === hash
        ) {
          const stat = lstatSync(path);
          if (stat.isFile() && stat.ino === entry.ino) {
            unlinkSync(path);
            // Persist deletion before durably dropping its ownership record.
            this.syncDirectory(this.assets);
          }
        }
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
          this.blocked = true;
          throw error;
        }
      }
      this.entries.delete(hash);
      total -= entry.bytes;
      await this.manifest();
    }
    if (
      this.entries.size + extra > this.limits.entries ||
      total + bytes > this.limits.bytes
    )
      throw new ImageFailure(
        "Generated image budget is pinned full; reset unused dynamic images",
      );
  }
  collect() {
    return this.serial(async () => {
      if (!this.blocked) await this.evict(0, 0, true);
    });
  }
  ingest(bytes: Buffer, runId: string, signal: AbortSignal): Promise<string> {
    return this.serial(async () => {
      signal.throwIfAborted();
      this.expireLeases();
      if (this.blocked)
        throw new ImageFailure(
          "Generated image storage needs repair and restart",
        );
      if (!bytes.length || bytes.length > IMAGE_LIMITS.outputBytes)
        throw new ImageFailure("Normalized image exceeds output byte limit");
      if (!this.leases.has(runId) && this.leases.size >= this.limits.runs)
        throw new ImageFailure("Too many image-producing runs");
      const hash = createHash("sha256").update(bytes).digest("hex"),
        path = join(this.assets, hash);
      try {
        const existing = await this.read(path, IMAGE_LIMITS.outputBytes);
        if (!existing.equals(bytes))
          throw new ImageFailure(
            "Local image checksum mismatch; repair storage",
          );
        signal.throwIfAborted();
        this.pin(runId, hash);
        return hash;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
      await this.evict(bytes.length, 1);
      signal.throwIfAborted();
      const temporary = join(this.assets, `.generated-${randomUUID()}.tmp`);
      try {
        const file = await open(temporary, "wx", 0o600);
        try {
          await file.writeFile(bytes);
          await file.sync();
        } finally {
          await file.close();
        }
        signal.throwIfAborted();
        // Record ownership before publishing; after a crash a missing planned file
        // is harmless, while a published file is never an untracked orphan.
        const ino = (await lstat(temporary)).ino;
        this.entries.set(hash, { hash, bytes: bytes.length, ino });
        await this.manifest();
        signal.throwIfAborted();
        linkSync(temporary, path); // atomic no-replace; never follow/overwrite a symlink
        this.syncDirectory(this.assets);
        this.pin(runId, hash);
        return hash;
      } catch (error) {
        // On ambiguous I/O, stop generating/collecting until restart reconciliation.
        if ((error as NodeJS.ErrnoException).code) this.blocked = true;
        throw error;
      } finally {
        await unlink(temporary).catch(() => {});
      }
    });
  }
  private pin(runId: string, hash: string) {
    const pins = this.leases.get(runId) ?? new Set<string>();
    if (pins.size >= this.limits.entries && !pins.has(hash))
      throw new ImageFailure("Run image lease limit reached");
    pins.add(hash);
    this.leases.set(runId, pins);
    // Root engine timeouts are at most one hour. Private probes do not publish
    // history settlement; this fallback also bounds their otherwise hidden pins.
    if (!this.leaseExpirations.has(runId))
      this.leaseExpirations.set(
        runId,
        this.now() + 3_600_000 + IMAGE_LIMITS.timeoutMs,
      );
  }
}
