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
import { defaults } from "../shared/defaults";
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
      for (const binding of Object.values(page.keys)) unique(binding.id);
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
  for (const c of doc.connections) {
    unique(c.id);
    const url = new URL(c.url);
    if (!["ws:", "wss:"].includes(url.protocol) || url.username || url.password)
      throw new Error(
        "OBS connections require ws:// or wss:// without embedded credentials",
      );
  }
  const profile = doc.profiles.find((p) => p.id === doc.activeProfileId);
  if (!profile?.pages.some((p) => p.id === doc.activePageId))
    throw new Error("Active profile/page is missing");
  return doc;
}
export function validateImport(value: unknown): AppDocument {
  const doc = validateDocument(value);
  for (const f of doc.workflows) {
    const errors = validateWorkflow(f, doc.workflows);
    if (errors.length) throw new Error(errors.join("\n"));
  }
  return doc;
}
export class Persistence {
  private pending = Promise.resolve();
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
    let document = defaults(),
      warning: string | undefined;
    try {
      const raw = await readFile(join(this.directory, "config.json"), "utf8");
      const value = JSON.parse(raw);
      if (value.schemaVersion !== 1) {
        await copyFile(
          join(this.directory, "config.json"),
          join(this.directory, `migration-backup-${Date.now()}.json`),
        );
        throw new Error(
          `Unsupported schema version ${value.schemaVersion}; backup saved`,
        );
      }
      document = validateDocument(value);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        warning = `Configuration could not be loaded: ${String(error)}`;
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
    const config = JSON.stringify(validateDocument(document), null, 2);
    const retained = runs.slice(-document.settings.historyLimit);
    while (JSON.stringify(retained).length > 4_000_000 && retained.length > 1)
      retained.shift();
    const history = JSON.stringify(retained);
    const operation = this.pending
      .catch(() => {})
      .then(async () => {
        await this.atomic("config.json", config);
        await this.atomic("history.json", history);
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
    await writeFile(join(this.assetDirectory, hash), bytes, { mode: 0o600 });
    return hash;
  }
  async export(document: AppDocument) {
    const hashes = new Set(
      document.profiles.flatMap((p) =>
        p.pages.flatMap((page) =>
          Object.values(page.keys).flatMap((k) =>
            k.appearance.asset ? [k.appearance.asset] : [],
          ),
        ),
      ),
    );
    const assets: Record<string, string> = {};
    for (const hash of hashes)
      assets[hash] = (await readFile(join(this.assetDirectory, hash))).toString(
        "base64",
      );
    return {
      format: "decker",
      document: {
        ...document,
        connections: document.connections.map(
          ({ credentialRef: _ref, ...c }) => c,
        ),
      },
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
