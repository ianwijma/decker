import { Persistence } from "../src/main/persistence";
import { cloneProfiles } from "../src/shared/decks";
import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, mkdir, readFile, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createHash } from "node:crypto";
import sharp from "sharp";
import { DisplayState, DISPLAY_LIMITS } from "../src/main/display-state";
import { defaults, binding, uid } from "../src/shared/defaults";
import { activityKey, buttonAppearance } from "../src/shared/feedback";
import { captureOrigin, originKey } from "../src/shared/trigger-context";
import { Images } from "../src/device/images";
import { Engine } from "../src/runtime/engine";
import { node } from "../src/shared/defaults";
import { makeAction } from "../src/shared/catalog";
const hooks = vi.hoisted(() => ({
  beforeSync: undefined as (() => Promise<void>) | undefined,
  fail: false,
}));
vi.mock("node:fs/promises", async (importOriginal) => {
  const fs = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...fs,
    open: async (...args: Parameters<typeof fs.open>) => {
      const file = await fs.open(...args);
      if (
        String(args[0]).includes("display-cache.json.") &&
        String(args[0]).endsWith(".tmp")
      ) {
        const sync = file.sync.bind(file);
        file.sync = async () => {
          await hooks.beforeSync?.();
          if (hooks.fail)
            throw Object.assign(new Error("storage"), { code: "EIO" });
          await sync();
        };
      }
      return file;
    },
  };
});
const directories: string[] = [];
afterEach(async () => {
  hooks.beforeSync = undefined;
  hooks.fail = false;
  await Promise.all(
    directories.splice(0).map((d) => rm(d, { recursive: true, force: true })),
  );
});
async function fixture(limits = DISPLAY_LIMITS) {
  const directory = await mkdtemp(join(tmpdir(), "decker-display-"));
  directories.push(directory);
  const assets = join(directory, "assets");
  await mkdir(assets);
  const document = defaults(),
    deck = document.decks[0],
    key = document.profiles[0].pages[0].keys[0];
  const state = new DisplayState(directory, assets, () => document, limits),
    origin = captureOrigin(document, deck.id, key)!;
  const start = () => {
    const launch = state.accept("button", origin),
      runId = uid(),
      actionId = uid();
    state.begin(launch.authority!, runId);
    state.action(launch.authority!, runId, actionId, true);
    return {
      launch,
      context: { authority: launch.authority!, runId, actionId },
    };
  };
  const image = async () => {
    const bytes = await sharp({
        create: { width: 4, height: 4, channels: 3, background: "#aabbcc" },
      })
        .png()
        .toBuffer(),
      hash = createHash("sha256").update(bytes).digest("hex");
    await writeFile(join(assets, hash), bytes);
    return { bytes, hash };
  };
  return {
    directory,
    assets,
    document,
    deck,
    key,
    state,
    origin,
    start,
    image,
    display: () => state.snapshot()[activityKey(deck.id, key)],
  };
}
describe("last-good display and authority", () => {
  it("commits before history arrives, retains partial fields across navigation/reload, never edits authored documents", async () => {
    const f = await fixture(),
      authored = JSON.stringify(f.document),
      run = f.start();
    await f.state.commit(
      { label: "你好 · 0", background: "#123456" },
      run.context,
    );
    f.document.profiles[0].pages.push({ id: "away", name: "Away", keys: {} });
    f.deck.activePageId = "away";
    await f.state.commit({ icon: "pack:lucide:v1:user" }, run.context);
    expect(f.display()).toEqual({
      label: "你好 · 0",
      background: "#123456",
      icon: "pack:lucide:v1:user",
      asset: null,
    });
    expect(JSON.stringify(f.document.profiles[0].pages[0])).toBe(
      JSON.stringify(JSON.parse(authored).profiles[0].pages[0]),
    );
    const reload = new DisplayState(f.directory, f.assets, () => f.document);
    await reload.load();
    expect(reload.snapshot()).toEqual(f.state.snapshot());
    expect(
      await readFile(join(f.directory, "display-cache.json"), "utf8"),
    ).not.toMatch(/authority|runId|outputs|invocation|secret/);
  });
  it("rejects readable IDs, ended/action-cancelled tokens and superseded runs but retains committed last-good", async () => {
    const f = await fixture(),
      older = f.start();
    await f.state.commit({ label: "first" }, older.context);
    await expect(
      f.state.commit(
        { label: "spoof" },
        {
          authority: older.launch.source.invocationId,
          runId: older.context.runId,
          actionId: older.context.actionId,
        },
      ),
    ).rejects.toThrow("No valid triggering button");
    const newer = f.start();
    await f.state.commit({ label: "new" }, newer.context);
    await expect(
      f.state.commit({ label: "old" }, older.context),
    ).rejects.toThrow("superseded");
    f.state.end(newer.launch.authority!);
    await expect(
      f.state.commit({ label: "old" }, older.context),
    ).rejects.toThrow("superseded");
    f.state.action(
      older.context.authority,
      older.context.runId,
      older.context.actionId,
      false,
    );
    await expect(
      f.state.commit({ label: "late" }, older.context),
    ).rejects.toThrow("No valid");
    expect(f.display()).toMatchObject({ label: "new" });
  });
  it.each([
    "cancel",
    "restart",
    "shutdown",
    "replace",
    "delete",
    "move",
    "generation",
    "workflow",
  ])(
    "rejects %s after async storage wait without poisoning future storage",
    async (kind) => {
      const f = await fixture(),
        run = f.start();
      await f.state.commit({ label: "last-good" }, run.context);
      let reached!: () => void, resume!: () => void;
      const ready = new Promise<void>((r) => (reached = r)),
        gate = new Promise<void>((r) => (resume = r));
      hooks.beforeSync = async () => {
        reached();
        await gate;
      };
      const pending = f.state.commit({ label: "late" }, run.context);
      const rejected = expect(pending).rejects.toThrow();
      await ready;
      if (kind === "cancel") f.state.cancelRun(run.context.runId);
      else if (["restart", "shutdown"].includes(kind)) f.state.invalidate();
      else if (kind === "replace")
        f.document.profiles[0].pages[0].keys[0] = binding("desktop.copy");
      else if (kind === "delete")
        delete f.document.profiles[0].pages[0].keys[0];
      else if (kind === "move") {
        delete f.document.profiles[0].pages[0].keys[0];
        f.document.profiles[0].pages.push({
          id: "moved",
          name: "Moved",
          keys: { 0: f.key },
        });
      } else if (kind === "generation") f.key.generation++;
      else {
        f.key.press = {
          kind: "workflow",
          workflowId: f.document.workflows[0].id,
        };
        f.document.workflows[0].revision++;
      }
      resume();
      await rejected;
      hooks.beforeSync = undefined;
      expect(
        JSON.parse(
          await readFile(join(f.directory, "display-cache.json"), "utf8"),
        ).entries[0].fields.label,
      ).toBe("last-good");
      if (["cancel", "restart", "shutdown"].includes(kind)) {
        const next = f.start();
        await f.state.commit({ label: "new" }, next.context);
        expect(f.display()).toMatchObject({ label: "new" });
      } else if (kind === "workflow")
        expect(f.display()).toMatchObject({ label: "last-good" });
      else expect(f.state.snapshot()).toEqual({});
    },
  );
  it("latest launch owns writes; pending acceptance alone does not supersede the active run", async () => {
    const f = await fixture(),
      first = f.start(),
      pending = f.state.accept("button", f.origin);
    await f.state.commit({ label: "active" }, first.context);
    const runId = uid(),
      actionId = uid();
    f.state.begin(pending.authority!, runId);
    f.state.action(pending.authority!, runId, actionId, true);
    await expect(
      f.state.commit({ label: "old" }, first.context),
    ).rejects.toThrow("superseded");
    await f.state.commit(
      { label: "queued" },
      { authority: pending.authority, runId, actionId },
    );
  });
  it("isolates shared profiles across decks, releases orphan references and cosmetic toggle edits keep authority", async () => {
    const f = await fixture(),
      second = { ...f.deck, id: "second" };
    f.document.decks.push(second);
    delete f.key.press;
    f.key.toggle = {
      on: { kind: "action", action: makeAction("desktop.copy") },
      off: { kind: "action", action: makeAction("desktop.copy") },
      source: { kind: "app", initial: "off" },
    };
    const a = f.start(),
      b = f.state.accept("button", { ...f.origin, deckId: second.id }),
      runId = uid(),
      actionId = uid();
    f.state.begin(b.authority!, runId);
    f.state.action(b.authority!, runId, actionId, true);
    await f.state.commit({ label: "deck one" }, a.context);
    await f.state.commit(
      { label: "deck two" },
      { authority: b.authority, runId, actionId },
    );
    f.key.toggle.appearance = { on: { label: "cosmetic", icon: "" } };
    await f.state.commit({ background: "#abcdef" }, a.context);
    expect(f.state.snapshot()[activityKey(second.id, f.key)]).toMatchObject({
      label: "deck two",
    });
    expect(f.display()).toMatchObject({ label: "deck one" });
    f.deck.profileIds = [];
    expect(f.state.snapshot()[activityKey(f.deck.id, f.key)]).toBeUndefined();
  });
  it("pins only validated local images, honors icon/asset precedence, and reset releases dynamic references", async () => {
    const f = await fixture(),
      image = await f.image();
    f.key.appearance.asset = image.hash;
    const run = f.start();
    await f.state.commit({ asset: image.hash }, run.context);
    expect(f.state.assetReferences()).toEqual(new Set([image.hash]));
    await expect(
      f.state.commit({ asset: "https://example.com/a.png" }, run.context),
    ).rejects.toThrow();
    await expect(
      f.state.commit({ asset: "f".repeat(64) }, run.context),
    ).rejects.toThrow();
    await writeFile(join(f.assets, "a".repeat(64)), "bad bytes");
    await expect(
      f.state.commit({ asset: "a".repeat(64) }, run.context),
    ).rejects.toThrow("Invalid local image");
    await f.state.commit({ icon: "", label: "" }, run.context);
    expect(f.state.assetReferences().size).toBe(0);
    expect(f.display()).toMatchObject({ asset: null, label: "", icon: "" });
    await f.state.commit(
      { icon: "pack:lucide:v1:user", asset: image.hash },
      run.context,
    );
    expect(f.state.assetReferences().size).toBe(1);
    await f.state.commit(
      { reset: ["label", "icon", "asset", "background"] },
      run.context,
    );
    expect(f.state.snapshot()).toEqual({});
    expect(await readFile(join(f.assets, image.hash))).toEqual(image.bytes);
  });
  it("retains prior last-good on storage failure and reports failure rather than durable success", async () => {
    const f = await fixture(),
      run = f.start();
    await f.state.commit({ label: "good" }, run.context);
    hooks.fail = true;
    await expect(f.state.commit({ label: "bad" }, run.context)).rejects.toThrow(
      "storage",
    );
    expect(f.display()).toMatchObject({ label: "good" });
    hooks.fail = false;
    await expect(
      f.state.commit({ label: "retry" }, run.context),
    ).rejects.toThrow("storage unavailable");
  });
  it.each([
    "{broken",
    JSON.stringify({ version: 9, entries: [] }),
    JSON.stringify({
      version: 1,
      entries: [{ origin: {}, fields: { label: "x" } }],
    }),
  ])(
    "recovers disposable malformed cache without touching workspace (%s)",
    async (raw) => {
      const f = await fixture();
      await writeFile(join(f.directory, "display-cache.json"), raw);
      await writeFile(join(f.directory, "document.json"), "workspace");
      await f.state.load();
      expect(f.state.snapshot()).toEqual({});
      expect(await readFile(join(f.directory, "document.json"), "utf8")).toBe(
        "workspace",
      );
      expect(
        await readFile(join(f.directory, "display-cache.corrupt.json"), "utf8"),
      ).toBe(raw);
      await f.state.commit({ label: "recovered" }, f.start().context);
    },
  );
  it("bounds entries/bytes with last-commit eviction and never writes on snapshot", async () => {
    const f = await fixture({ entries: 2, bytes: 1000, authorities: 3 });
    for (let i = 0; i < 4; i++) {
      const key = binding("desktop.copy");
      f.document.profiles[0].pages[0].keys[i] = key;
      const origin = captureOrigin(f.document, f.deck.id, key)!,
        launch = f.state.accept("button", origin),
        runId = uid(),
        actionId = uid();
      f.state.begin(launch.authority!, runId);
      f.state.action(launch.authority!, runId, actionId, true);
      await f.state.commit(
        { label: String(i) },
        { authority: launch.authority, runId, actionId },
      );
      f.state.end(launch.authority!);
    }
    const raw = await readFile(join(f.directory, "display-cache.json"), "utf8");
    expect(Buffer.byteLength(raw)).toBeLessThanOrEqual(1000);
    expect(
      Object.values(f.state.snapshot()).map(
        (e) => (e as { label: string }).label,
      ),
    ).toEqual(["2", "3"]);
    f.state.snapshot();
    expect(
      await readFile(join(f.directory, "display-cache.json"), "utf8"),
    ).toBe(raw);
  });
  it("restores current underlying toggle/dynamic appearance after temporary activity and produces stable frames", async () => {
    const f = await fixture(),
      run = f.start();
    delete f.key.press;
    f.key.toggle = {
      on: { kind: "action", action: makeAction("desktop.copy") },
      off: { kind: "action", action: makeAction("desktop.copy") },
      source: { kind: "app", initial: "off" },
      appearance: {
        on: { label: "ON", background: "#111111" },
        off: { label: "OFF", background: "#222222" },
      },
    };
    // Accepted identity must reflect final executable configuration.
    const fresh = f.start();
    await f.state.commit(
      { label: "Count: 0", icon: "pack:lucide:v1:user", background: "#123456" },
      fresh.context,
    );
    const state = {
      deckId: f.deck.id,
      bindingId: f.key.id,
      generation: f.key.generation,
      confirmed: "on" as const,
      transitioning: false,
      reconciling: false,
      fresh: true,
      blocked: false,
    };
    const composed = buttonAppearance(
      f.key,
      { buttonDisplay: f.state.snapshot() },
      "#abcdef",
      f.deck.id,
      [state],
    );
    expect(composed).toMatchObject({
      label: "Count: 0",
      background: "#123456",
      stateLabel: "on",
    });
    expect(
      buttonAppearance(
        f.key,
        {
          buttonDisplay: f.state.snapshot(),
          buttonFeedback: {
            [activityKey(f.deck.id, f.key)]: { status: "running" },
          },
        },
        "#abcdef",
        f.deck.id,
        [state],
      ).background,
    ).toBe("#abcdef");
    const images = new Images(),
      frame = await images.render(composed, 72);
    expect(await images.render(composed, 72)).toBe(frame);
    await f.state.commit(
      { reset: ["label", "background", "icon", "asset"] },
      fresh.context,
    );
    expect(
      buttonAppearance(
        f.key,
        { buttonDisplay: f.state.snapshot() },
        "#abcdef",
        f.deck.id,
        [state],
      ),
    ).toMatchObject({ label: "ON", background: "#111111" });
    expect(
      await images.render(
        buttonAppearance(
          f.key,
          { buttonDisplay: f.state.snapshot() },
          "#abcdef",
          f.deck.id,
          [state],
        ),
        72,
      ),
    ).not.toEqual(frame);
    f.state.end(run.launch.authority!);
  });
  it("copies/exports contain authored configuration only and cannot transfer live cache authority", async () => {
    const f = await fixture(),
      run = f.start(),
      image = await f.image();
    await f.state.commit(
      { label: "Dynamic only", asset: image.hash },
      run.context,
    );
    const bundle = await new Persistence(f.directory).export(f.document);
    expect(bundle.assets).toEqual({});
    expect(JSON.stringify(bundle)).not.toMatch(
      /Dynamic only|display-cache|authority/,
    );
    const { profiles: copies } = cloneProfiles(f.document.profiles);
    f.document.profiles.push(...copies);
    f.deck.profileIds.push(copies[0].id);
    const copied = copies[0].pages[0].keys[0];
    expect(copied.id).not.toBe(f.key.id);
    expect(f.state.snapshot()[activityKey(f.deck.id, copied)]).toBeUndefined();
    f.state.invalidate();
    f.document.profiles = copies;
    f.deck.profileIds = [copies[0].id];
    await expect(
      f.state.commit({ label: "old import" }, run.context),
    ).rejects.toThrow("No valid");
    expect(f.state.snapshot()).toEqual({});
  });
  it("masks known managed-secret values before committing display strings", async () => {
    const f = await fixture(),
      secret = "synthetic-secret";
    const state = new DisplayState(
      f.directory,
      f.assets,
      () => f.document,
      undefined,
      () => [secret],
    );
    const launch = state.accept("button", f.origin),
      runId = uid(),
      actionId = uid();
    state.begin(launch.authority!, runId);
    state.action(launch.authority!, runId, actionId, true);
    await state.commit(
      { label: `Count ${secret}` },
      { authority: launch.authority, runId, actionId },
    );
    const raw = await readFile(join(f.directory, "display-cache.json"), "utf8");
    expect(raw).not.toContain(secret);
    expect(raw).toContain("Count [redacted]");
  });
  it("scheduled/manual/probe sources cannot acquire authority from readable origin IDs", async () => {
    const f = await fixture();
    for (const kind of ["scheduled", "manual", "probe"] as const) {
      const launch = f.state.accept(kind, f.origin);
      expect(launch.authority).toBeUndefined();
      expect(launch.source.origin).toBeUndefined();
    }
    const launch = f.state.accept("refresh", f.origin),
      runId = uid(),
      actionId = uid();
    f.state.begin(launch.authority!, runId);
    f.state.action(launch.authority!, runId, actionId, true);
    launch.source.origin!.bindingId = "caller mutation";
    await f.state.commit(
      { label: "lease update" },
      { authority: launch.authority, runId, actionId },
    );
    f.state.end(launch.authority!);
    await expect(
      f.state.commit(
        { label: "expired lease" },
        { authority: launch.authority, runId, actionId },
      ),
    ).rejects.toThrow("No valid");
  });
  it("an Engine hanging handler cannot commit after cancellation even before its final history record", async () => {
    const f = await fixture(),
      a = {
        ...node("action", "Update"),
        action: makeAction("deck.appearance"),
      },
      flow = {
        ...f.document.workflows[0],
        graph: { entry: a.id, nodes: [a], edges: [] },
      };
    let release!: () => void, late!: Promise<void>;
    const engine = new Engine(
      async (_, c) => {
        f.state.action(c.authority!, c.runId, c.actionId!, true);
        await new Promise<void>((r) => (release = r));
        late = f.state.commit({ label: "late" }, c);
        await late;
        return null;
      },
      () => {},
      () => [],
      () => ({}),
      (e) =>
        e.type === "begin"
          ? f.state.begin(e.authority, e.runId)
          : f.state.end(e.authority),
    );
    const h = engine.start(
      flow,
      [flow],
      {},
      { launch: f.state.accept("button", f.origin) },
    );
    h.cancel();
    release();
    await h.done;
    await expect(late).rejects.toThrow("No valid");
    expect(f.state.snapshot()).toEqual({});
  });
});
