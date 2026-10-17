import { CURRENT_SCHEMA_VERSION } from "../shared/schedules";
import { targetWorkflow } from "../runtime/targets";
import { authoredAssetReferences } from "../shared/asset-references";
import { constants, linkSync } from "node:fs";
import { open, unlink } from "node:fs/promises";
import { bindingTargets } from "../shared/binding-targets";
import { rekeyCredentials } from "../shared/credential-owners";
import { randomUUID } from "node:crypto";
import { findWorkflow } from "../shared/workflow-identity";
import {
  mkdir,
  readFile,
  writeFile,
  rename,
  copyFile,
  readdir,
} from "node:fs/promises";
import { join } from "node:path";
import sharp from "sharp";
import { createHash } from "node:crypto";
import {
  documentSchema,
  runRecordSchema,
  type AppDocument,
  type RunRecord,
} from "../shared/schema";
import { migrateDocument } from "../shared/decks";
import { defaults } from "../shared/defaults";
import { actionById } from "../shared/catalog";
import { validateWorkflow } from "../runtime/validate";
export function validateDocument(value: unknown): AppDocument {
  const doc = documentSchema.parse(value),
    ids = new Set<string>();
  const unique = (id: string) => {
    if (ids.has(id)) throw new Error(`Duplicate document ID: ${id}`);
    ids.add(id);
  };
  for (const p of doc.profiles) {
    unique(p.id);
    for (const page of p.pages) {
      unique(page.id);
      for (const binding of Object.values(page.keys)) {
        unique(binding.id);
        const source = binding.toggle?.source;
        if (source?.kind === "observed" && source.observation.kind === "obs") {
          const observedConnectionId = source.observation.connectionId;
          if (!doc.connections.some((c) => c.id === observedConnectionId))
            throw new Error("Missing observed OBS connection");
        }
      }
      if (page.parentId && !p.pages.some((x) => x.id === page.parentId))
        throw new Error("Folder parent is missing");
      const path = new Set<string>();
      let current: typeof page | undefined = page;
      while (current) {
        if (path.has(current.id)) throw new Error("Folder cycle");
        path.add(current.id);
        current = p.pages.find((x) => x.id === current?.parentId);
      }
    }
  }
  for (const f of doc.workflows) unique(f.id);
  for (const schedule of doc.schedules) unique(schedule.id);
  for (const c of doc.connections) {
    unique(c.id);
    const url = new URL(c.url);
    if (!["ws:", "wss:"].includes(url.protocol) || url.username || url.password)
      throw new Error(
        "OBS connections require ws:// or wss:// without embedded credentials",
      );
  }
  const owned = new Set<string>(),
    hardware = new Set<string>();
  for (const deck of doc.decks) {
    unique(deck.id);
    for (const profileId of deck.profileIds) {
      if (owned.has(profileId) || !doc.profiles.some((p) => p.id === profileId))
        throw new Error("Deck profile ownership is invalid");
      owned.add(profileId);
    }
    if (
      !deck.profileIds.includes(deck.activeProfileId) ||
      !doc.profiles
        .find((p) => p.id === deck.activeProfileId)
        ?.pages.some((p) => p.id === deck.activePageId)
    )
      throw new Error("Active profile/page is missing");
    if (deck.kind === "hardware") {
      if (
        !deck.hardwareId ||
        hardware.has(deck.hardwareId) ||
        deck.hardwareId.startsWith("session:")
      )
        throw new Error("Hardware identity must be stable and unique");
      hardware.add(deck.hardwareId);
    }
  }
  if (owned.size !== doc.profiles.length)
    throw new Error("Every profile must belong to one deck");
  if (
    doc.decks.length
      ? !doc.decks.some((d) => d.id === doc.activeDeckId)
      : doc.activeDeckId !== ""
  )
    throw new Error("Active deck is missing");
  if (
    doc.profiles
      .flatMap((p) => p.pages.flatMap((page) => Object.values(page.keys)))
      .filter((b) => b.toggle).length > 4096
  )
    throw new Error("Maximum toggle bindings reached (4096)");
  return doc;
}
export function validateImport(value: unknown): AppDocument {
  const doc = validateDocument(migrateDocument(value));
  for (const profile of doc.profiles)
    for (const page of profile.pages)
      for (const binding of Object.values(page.keys))
        for (const { phase, target } of bindingTargets(binding)) {
          if (!target) continue;
          if (target.kind === "workflow") {
            if (
              !findWorkflow(
                doc.workflows,
                target.workflowId,
                doc.workflowAliases,
              )
            )
              throw new Error(
                `Missing assigned workflow: ${target.workflowId}`,
              );
            continue;
          }
          if (phase.startsWith("toggle.")) {
            const errors = validateWorkflow(
              targetWorkflow(target, doc),
              doc.workflows,
              doc.workflowAliases,
            );
            if (errors.length) throw new Error(errors.join("\n"));
            continue;
          }
          for (const action of target.kind === "action"
            ? [target.action]
            : target.actions) {
            const definition = actionById(action.type);
            if (!definition || definition.version !== action.version)
              throw new Error(`Unknown imported action: ${action.type}`);
            const fields = definition.fields;
            const config = { ...action.config };
            for (const field of fields) {
              const value = config[field.key];
              if (value && typeof value === "object") {
                if (
                  Array.isArray(value) ||
                  typeof value.$ref !== "string" ||
                  value.$ref
                    .split(".")
                    .some((part) =>
                      ["__proto__", "prototype", "constructor"].includes(part),
                    )
                )
                  throw new Error("Invalid action data reference");
                config[field.key] = field.default ?? "";
              }
              if (
                field.type === "workflow" &&
                typeof value === "string" &&
                !findWorkflow(doc.workflows, value, doc.workflowAliases)
              )
                throw new Error("Missing action workflow");
            }
            definition.schema.parse(config);
          }
        }
  for (const f of doc.workflows) {
    const errors = validateWorkflow(f, doc.workflows, doc.workflowAliases);
    if (errors.length) throw new Error(errors.join("\n"));
  }
  // Runtime state is local and cannot be rebound by re-importing a bundle.
  for (const profile of doc.profiles)
    for (const page of profile.pages)
      for (const binding of Object.values(page.keys))
        if (binding.toggle) {
          binding.id = randomUUID();
          binding.generation = 0;
        }
  for (const schedule of doc.schedules) {
    schedule.enabled = false;
    schedule.id = randomUUID();
  }
  return doc;
}
export class Persistence {
  /** Ownership promotion precedes any durable authored adoption. */
  promoteAssets?: (hashes: Set<string>) => Promise<void>;
  authorAsset?: (
    hashes: Set<string>,
    publish: () => Promise<string>,
  ) => Promise<string>;
  private pending = Promise.resolve();
  private loadFailure?: string;
  readonly assetDirectory: string;
  constructor(readonly directory: string) {
    this.assetDirectory = join(directory, "assets");
  }
  async load(): Promise<{
    document: AppDocument;
    runs: RunRecord[];
    warning?: string;
  }> {
    await mkdir(this.assetDirectory, { recursive: true });
    this.loadFailure = undefined;
    let document = defaults(),
      warning: string | undefined,
      configRead = false;
    try {
      const raw = await readFile(join(this.directory, "config.json"), "utf8");
      configRead = true;
      const value = JSON.parse(raw);
      if (value.schemaVersion !== CURRENT_SCHEMA_VERSION) {
        await copyFile(
          join(this.directory, "config.json"),
          join(this.directory, `migration-backup-${Date.now()}.json`),
        );
        if (![1, 2, 3, 4, 5].includes(value.schemaVersion))
          throw new Error(
            `Unsupported schema version ${value.schemaVersion}; backup saved`,
          );
      }
      document = validateDocument(migrateDocument(value));
      if (value.schemaVersion !== CURRENT_SCHEMA_VERSION)
        await this.atomic("config.json", JSON.stringify(document, null, 2));
    } catch (error) {
      if (configRead || (error as NodeJS.ErrnoException).code !== "ENOENT") {
        warning = `Configuration could not be loaded: ${String(error)}. Workspace writes are blocked; restore or repair config.json and restart.`;
        this.loadFailure = warning;
        await copyFile(
          join(this.directory, "config.json"),
          join(this.directory, `recovery-${Date.now()}.json`),
        ).catch(() => {});
      }
    }
    let runs: RunRecord[] = [];
    try {
      const raw = await readFile(join(this.directory, "history.json"), "utf8");
      if (raw.length < 8_000_000) {
        const parsed: unknown = JSON.parse(raw);
        if (Array.isArray(parsed))
          runs = parsed
            .flatMap((value) => {
              const parsed = runRecordSchema.safeParse(value);
              return parsed.success ? [parsed.data] : [];
            })
            .slice(-document.settings.historyLimit)
            .map((r) =>
              r.status === "running"
                ? {
                    ...r,
                    status: "interrupted",
                    endedAt: Date.now(),
                    error: "The application or runner stopped unexpectedly",
                  }
                : r,
            );
      }
    } catch {
      /* no history */
    }
    return { document, runs, warning };
  }
  save(document: AppDocument, runs: RunRecord[]) {
    if (this.loadFailure) return Promise.reject(new Error(this.loadFailure));
    const config = JSON.stringify(validateDocument(document), null, 2),
      assetReferences = authoredAssetReferences(document);
    const retained = runs.slice(-document.settings.historyLimit);
    while (JSON.stringify(retained).length > 4_000_000 && retained.length > 1)
      retained.shift();
    const history = JSON.stringify(retained);
    const operation = this.pending
      .catch(() => {})
      .then(async () => {
        await this.promoteAssets?.(assetReferences);
        // Commit the owner document last: a history failure must not commit a
        // credential reference while reporting that its transaction failed.
        await this.atomic("history.json", history);
        await this.atomic("config.json", config);
      });
    this.pending = operation;
    return operation;
  }
  private async atomic(name: string, contents: string) {
    const path = join(this.directory, name);
    await writeFile(`${path}.tmp`, contents, { mode: 0o600 });
    await rename(`${path}.tmp`, path);
  }
  async storeAsset(bytes: Buffer) {
    if (bytes.length > 5_000_000) throw new Error("Image exceeds 5 MB");
    const hash = createHash("sha256").update(bytes).digest("hex");
    const publish = () => this.publishAsset(hash, bytes);
    if (this.authorAsset) return this.authorAsset(new Set([hash]), publish);
    await this.promoteAssets?.(new Set([hash]));
    return publish();
  }
  private async publishAsset(hash: string, bytes: Buffer): Promise<string> {
    const path = join(this.assetDirectory, hash),
      temporary = join(this.assetDirectory, `.upload-${randomUUID()}.tmp`);
    try {
      const existing = await open(
        path,
        constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
      );
      try {
        const stat = await existing.stat();
        const buffer = Buffer.alloc(bytes.length + 1);
        const read =
          stat.isFile() && stat.size === bytes.length
            ? await existing.read(buffer, 0, buffer.length, 0)
            : undefined;
        if (
          !stat.isFile() ||
          stat.size !== bytes.length ||
          read?.bytesRead !== bytes.length ||
          !buffer.subarray(0, bytes.length).equals(bytes)
        )
          throw new Error("Asset checksum mismatch");
        return hash;
      } finally {
        await existing.close();
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    try {
      const file = await open(temporary, "wx", 0o600);
      try {
        await file.writeFile(bytes);
        await file.sync();
      } finally {
        await file.close();
      }
      try {
        linkSync(temporary, path);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
        return this.publishAsset(hash, bytes);
      }
    } finally {
      await unlink(temporary).catch(() => {});
    }
    return hash;
  }
  async export(document: AppDocument) {
    const hashes = authoredAssetReferences(document);
    const assets: Record<string, string> = {};
    for (const hash of hashes)
      assets[hash] = (await readFile(join(this.assetDirectory, hash))).toString(
        "base64",
      );
    return {
      format: "decker",
      document: rekeyCredentials(document, () => `import:${randomUUID()}`),
      assets,
    };
  }
  async importAssets(assets: Record<string, string>) {
    if (Object.keys(assets).length > 256)
      throw new Error("Too many imported assets");
    for (const [hash, data] of Object.entries(assets)) {
      if (!/^[a-f0-9]{64}$/.test(hash) || typeof data !== "string")
        throw new Error("Invalid asset");
      const bytes = Buffer.from(data, "base64");
      if (createHash("sha256").update(bytes).digest("hex") !== hash)
        throw new Error("Asset checksum mismatch");
      const metadata = await sharp(bytes, {
        limitInputPixels: 16000000,
      }).metadata();
      if (!["png", "jpeg", "webp"].includes(metadata.format ?? ""))
        throw new Error("Imported assets must be PNG, JPEG or WebP images");
      await this.storeAsset(bytes);
    }
  }
  async listAssets() {
    return readdir(this.assetDirectory);
  }
}
