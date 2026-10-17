import { afterEach, expect, it, vi } from "vitest";
import {
  mkdtemp,
  readFile,
  writeFile,
  rm,
  readdir,
  symlink,
  unlink,
} from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import sharp from "sharp";
import {
  GeneratedAssets,
  GENERATED_LIMITS,
} from "../src/main/generated-assets";
import { Persistence } from "../src/main/persistence";
import { defaults, node, uid } from "../src/shared/defaults";
import { authoredAssetReferences } from "../src/shared/asset-references";
import { DisplayState } from "../src/main/display-state";
import { captureOrigin } from "../src/shared/trigger-context";
import { activityKey } from "../src/shared/feedback";
import { Engine } from "../src/runtime/engine";

const faults = vi.hoisted(() => ({
  fail: false,
  beforeSync: undefined as (() => void) | undefined,
}));
vi.mock("node:fs/promises", async (original) => {
  const fs = await original<typeof import("node:fs/promises")>();
  return {
    ...fs,
    open: async (...args: Parameters<typeof fs.open>) => {
      const file = await fs.open(...args);
      if (String(args[0]).includes("generated-assets.json.")) {
        const sync = file.sync.bind(file);
        file.sync = async () => {
          faults.beforeSync?.();
          if (faults.fail)
            throw Object.assign(new Error("disk"), { code: "EIO" });
          await sync();
        };
      }
      return file;
    },
  };
});
const directories: string[] = [];
afterEach(async () => {
  faults.fail = false;
  faults.beforeSync = undefined;
  await Promise.all(
    directories.splice(0).map((d) => rm(d, { recursive: true, force: true })),
  );
});
const bytes = (color = "red") =>
  sharp({ create: { width: 8, height: 8, channels: 4, background: color } })
    .resize(256, 256)
    .png()
    .toBuffer();
async function fixture(limits = GENERATED_LIMITS) {
  const directory = await mkdtemp(join(tmpdir(), "decker-generated-"));
  directories.push(directory);
  const store = new Persistence(directory),
    { document } = await store.load(),
    display = new DisplayState(directory, store.assetDirectory, () => document);
  const generated = new GeneratedAssets(
    directory,
    store.assetDirectory,
    () => authoredAssetReferences(document),
    () => display.assetReferences(),
    limits,
  );
  await display.load();
  await generated.load();
  store.promoteAssets = (hashes) => generated.promote(hashes);
  store.authorAsset = (hashes, publish) => generated.author(hashes, publish);
  const begin = () => {
    const key = document.profiles[0].pages[0].keys[0],
      launch = display.accept(
        "button",
        captureOrigin(document, document.decks[0].id, key),
      ),
      runId = uid(),
      actionId = uid();
    display.begin(launch.authority!, runId);
    display.action(launch.authority!, runId, actionId, true);
    return { runId, actionId, authority: launch.authority };
  };
  return {
    directory,
    store,
    document,
    display,
    generated,
    begin,
    ingest: (image: Buffer, runId = "run") =>
      generated.ingest(image, runId, new AbortController().signal),
  };
}
it("converges equal concurrent content, verifies cache hits, cleans exclusive temps and releases only settled leases", async () => {
  const f = await fixture(),
    image = await bytes();
  const hashes = await Promise.all([
    f.ingest(image, "one"),
    f.ingest(image, "two"),
  ]);
  expect(hashes[0]).toBe(hashes[1]);
  expect(await readdir(f.store.assetDirectory)).toEqual([hashes[0]]);
  f.generated.release("one");
  await f.generated.collect();
  expect(await readFile(join(f.store.assetDirectory, hashes[0]))).toEqual(
    image,
  );
  f.generated.release("two");
  await f.generated.collect();
  expect(await readdir(f.store.assetDirectory)).toEqual([]);
});
it("bounds private-probe leases past the engine's maximum root deadline and cleans only managed staging files", async () => {
  const f = await fixture();
  let now = 0;
  const g = new GeneratedAssets(
    f.directory,
    f.store.assetDirectory,
    () => new Set(),
    () => new Set(),
    { ...GENERATED_LIMITS, runs: 1 },
    () => now,
  );
  const image = await bytes(),
    hash = await g.ingest(image, "private-probe", new AbortController().signal);
  await expect(
    g.ingest(image, "another-root", new AbortController().signal),
  ).rejects.toThrow(/Too many/);
  now = 3_600_000;
  await g.collect();
  expect(await readFile(join(f.store.assetDirectory, hash))).toEqual(image);
  now += 15_001;
  await g.collect();
  expect(await readdir(f.store.assetDirectory)).toEqual([]);
  await writeFile(
    join(
      f.store.assetDirectory,
      ".generated-00000000-0000-0000-0000-000000000000.tmp",
    ),
    "partial",
  );
  await writeFile(
    join(
      f.directory,
      "generated-assets.json.00000000-0000-0000-0000-000000000000.tmp",
    ),
    "partial manifest",
  );
  await writeFile(join(f.store.assetDirectory, "unknown.tmp"), "authored");
  const restart = new GeneratedAssets(
    f.directory,
    f.store.assetDirectory,
    () => new Set(),
    () => new Set(),
  );
  await restart.load();
  expect(await readdir(f.store.assetDirectory)).toEqual(["unknown.tmp"]);
  expect(
    (await readdir(f.directory)).filter((n) => n.endsWith(".tmp")),
  ).toEqual([]);
});
it("holds produced art across a delay/subflow until display commit, restart, reset and orphan reconciliation", async () => {
  const f = await fixture(),
    context = f.begin(),
    child = {
      ...defaults().workflows[0],
      id: "child",
      inputs: ["asset"],
      outputs: [],
      graph: {
        entry: "update",
        nodes: [
          {
            ...node("action", "update"),
            id: "update",
            action: {
              type: "deck.appearance",
              version: 1 as const,
              config: { asset: { $ref: "inputs.asset" } },
            },
          },
        ],
        edges: [],
      },
    };
  const fetch = {
      ...node("action", "fetch"),
      id: "fetch",
      action: {
        type: "image.fetch",
        version: 1 as const,
        config: { url: "http://localhost/avatar" },
      },
    },
    delay = { ...node("delay", "wait"), id: "wait", config: { ms: 5 } },
    sub = {
      ...node("subflow", "call"),
      id: "call",
      config: {
        workflowId: child.id,
        revision: child.revision,
        inputs: { asset: { $ref: "outputs.fetch.asset" } },
      },
    };
  const workflow = {
    ...defaults().workflows[0],
    graph: {
      entry: fetch.id,
      nodes: [fetch, delay, sub],
      edges: [
        { id: "1", source: "fetch", target: "wait", port: "next" },
        { id: "2", source: "wait", target: "call", port: "next" },
      ],
    },
  };
  let hash = "";
  const engine = new Engine(
    async (action) => {
      if (action.type === "image.fetch") {
        hash = await f.ingest(await bytes(), context.runId);
        await f.generated.collect();
        return { asset: hash };
      }
      await f.generated.collect();
      await f.display.commit(action.config, context);
      return null;
    },
    () => {},
  );
  expect((await engine.start(workflow, [workflow, child]).done).status).toBe(
    "success",
  );
  f.generated.release(context.runId);
  f.display.end(context.authority!);
  await f.generated.collect();
  const display = new DisplayState(
    f.directory,
    f.store.assetDirectory,
    () => f.document,
  );
  await display.load();
  const restored = new GeneratedAssets(
    f.directory,
    f.store.assetDirectory,
    () => authoredAssetReferences(f.document),
    () => display.assetReferences(),
  );
  await restored.load();
  expect(display.assetReferences()).toEqual(new Set([hash]));
  expect(await readFile(join(f.store.assetDirectory, hash))).toEqual(
    await bytes(),
  );
  delete f.document.profiles[0].pages[0].keys[0];
  await restored.collect();
  expect(display.assetReferences().size).toBe(0);
  expect(await readdir(f.store.assetDirectory)).toEqual([]);
});
it("rejects a pinned-full entry or byte budget and leaves the previous last-good art intact", async () => {
  const first = await bytes(),
    second = await bytes("blue");
  for (const limits of [
    { entries: 1, bytes: 64 * 1024 * 1024, runs: 64 },
    { entries: 256, bytes: first.length, runs: 64 },
  ]) {
    const f = await fixture(limits),
      context = f.begin(),
      hash = await f.ingest(first);
    await f.display.commit({ asset: hash }, context);
    f.generated.release("run");
    await expect(f.ingest(second)).rejects.toThrow(/pinned full/);
    expect(await readFile(join(f.store.assetDirectory, hash))).toEqual(first);
    await f.display.commit({ reset: ["asset"] }, context);
    await f.generated.collect();
    expect(await f.ingest(second)).not.toBe(hash);
  }
});
it("never owns or deletes authored/uploaded/imported collisions and permanently promotes adoption", async () => {
  const f = await fixture(),
    image = await bytes(),
    upload = await f.store.storeAsset(image);
  expect(await f.ingest(image)).toBe(upload);
  f.generated.release();
  await f.generated.collect();
  expect(await readFile(join(f.store.assetDirectory, upload))).toEqual(image);
  const produced = await f.ingest(await bytes("blue"));
  f.document.workflows[0].graph.nodes.push({
    ...node("action", "adopt"),
    action: {
      type: "deck.appearance",
      version: 1,
      config: { asset: { $literal: produced } },
    },
  });
  const saved = f.store.save(f.document, []);
  f.document.workflows[0].graph.nodes.pop();
  await saved;
  f.generated.release();
  await f.generated.collect();
  expect(await readFile(join(f.store.assetDirectory, produced))).toEqual(
    await bytes("blue"),
  );
  const imported = await f.ingest(await bytes("green"));
  await f.store.importAssets({
    [imported]: (await bytes("green")).toString("base64"),
  });
  f.generated.release();
  await f.generated.collect();
  expect(await readFile(join(f.store.assetDirectory, imported))).toEqual(
    await bytes("green"),
  );
});
it("preserves unknown files and existing art on corrupt manifest, disk errors and cancelled publication", async () => {
  const f = await fixture(),
    image = await bytes(),
    hash = await f.ingest(image);
  await writeFile(join(f.directory, "generated-assets.json"), "corrupt");
  const recovered = new GeneratedAssets(
    f.directory,
    f.store.assetDirectory,
    () => new Set(),
    () => new Set(),
  );
  await recovered.load();
  await recovered.collect();
  await expect(
    recovered.ingest(await bytes("blue"), "new", new AbortController().signal),
  ).rejects.toThrow(/repair/);
  expect(await readFile(join(f.store.assetDirectory, hash))).toEqual(image);
  const g = await fixture();
  faults.fail = true;
  await expect(g.ingest(image)).rejects.toThrow(/disk/);
  expect(await readdir(g.store.assetDirectory)).toEqual([]);
  faults.fail = false;
  const h = await fixture(),
    controller = new AbortController();
  faults.beforeSync = () => controller.abort();
  await expect(
    h.generated.ingest(image, "run", controller.signal),
  ).rejects.toThrow();
  expect(await readdir(h.store.assetDirectory)).toEqual([]);
});
it("refuses symlink/corrupt hits and never deletes a substituted file", async () => {
  const f = await fixture(),
    image = await bytes(),
    hash = await f.ingest(image);
  await writeFile(join(f.store.assetDirectory, hash), "corrupted");
  await expect(f.ingest(image)).rejects.toThrow(/checksum/);
  f.generated.release();
  await f.generated.collect();
  expect(await readFile(join(f.store.assetDirectory, hash), "utf8")).toBe(
    "corrupted",
  );
  await unlink(join(f.store.assetDirectory, hash));
  const outside = join(f.directory, "authored.png");
  await writeFile(outside, image);
  await symlink(outside, join(f.store.assetDirectory, hash));
  await expect(f.ingest(image)).rejects.toThrow();
  expect(await readFile(outside)).toEqual(image);
});
it("exports workflow literal assets in nested bodies/branches/targets, excluding dynamic-only art", async () => {
  const f = await fixture(),
    authored = await f.store.storeAsset(await bytes()),
    dynamic = await f.ingest(await bytes("blue")),
    context = f.begin();
  await f.display.commit({ asset: dynamic }, context);
  const nested = node("action", "image");
  nested.action = {
    type: "deck.appearance",
    version: 1,
    config: { asset: authored },
  };
  const parallel = node("parallel", "branches");
  parallel.branches = [{ entry: nested.id, nodes: [nested], edges: [] }];
  f.document.workflows[0].graph = {
    entry: parallel.id,
    nodes: [parallel],
    edges: [],
  };
  expect(authoredAssetReferences(f.document)).toEqual(new Set([authored]));
  const bundle = await f.store.export(f.document);
  expect(Object.keys(bundle.assets)).toEqual([authored]);
  const target = await fixture();
  await target.store.importAssets(bundle.assets);
  expect(await readFile(join(target.store.assetDirectory, authored))).toEqual(
    await bytes(),
  );
  expect(JSON.stringify(bundle)).not.toContain(dynamic);
});
it("keeps image errors separate from last-good fields and ignores superseded/ended/older failures", async () => {
  const f = await fixture(),
    first = f.begin(),
    hash = await f.ingest(await bytes());
  await f.display.commit({ asset: hash, label: "Good" }, first);
  const oldTicket = f.display.beginImage(first),
    newTicket = f.display.beginImage(first);
  f.display.imageResult(first, newTicket, false);
  f.display.imageResult(first, oldTicket, true);
  const key = f.document.profiles[0].pages[0].keys[0],
    identity = activityKey(f.document.decks[0].id, key);
  expect(f.display.snapshot()[identity]).not.toHaveProperty("imageStatus");
  const next = f.begin(),
    failed = f.display.beginImage(next);
  f.display.imageResult(next, failed, true);
  expect(f.display.snapshot()[identity]).toMatchObject({
    asset: hash,
    label: "Good",
    imageStatus: "stale",
  });
  const cancelled = f.display.beginImage(next);
  f.display.end(next.authority!);
  f.display.imageResult(next, cancelled, false);
  expect(f.display.snapshot()[identity]).toHaveProperty("imageStatus", "stale");
  const success = f.begin();
  await f.display.commit({ asset: hash }, success);
  f.display.imageResult(first, oldTicket, true);
  expect(f.display.snapshot()[identity]).not.toHaveProperty("imageStatus");
});
