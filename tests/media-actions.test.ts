import { afterEach, expect, it, vi } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { binding, defaults, node } from "../src/shared/defaults";
import { actionById, makeAction, paletteCatalog } from "../src/shared/catalog";
import {
  mediaActions,
  mediaPlayback,
  mediaPlaybackIcons,
} from "../src/shared/media";
import { buttonAppearance, observedAppearance } from "../src/shared/feedback";
import { Persistence, validateImport } from "../src/main/persistence";
import { handlers } from "../src/actions/handlers";
import { Engine } from "../src/runtime/engine";
import { ObsConnections } from "../src/integrations/obs";
import { ButtonActivity } from "../src/runtime/activity";
import { Images } from "../src/device/images";
import * as system from "../src/adapters/linux/system";
import type { Json } from "../src/shared/schema";
import sharp from "sharp";
import { packKeySvg } from "../src/shared/icons";

afterEach(() => vi.restoreAllMocks());
it("exposes exactly six Media actions with matching schemas and shared player defaults", () => {
  expect(
    paletteCatalog.filter((d) => d.group === "Media").map((d) => d.id),
  ).toEqual(mediaActions.map((d) => d.id));
  expect(paletteCatalog.map((d) => d.id)).not.toContain("media.control");
  for (const { id } of mediaActions) {
    const def = actionById(id)!;
    expect(def.fields.map((f) => f.key)).toEqual(["player"]);
    expect(makeAction(id).config).toEqual({ player: "" });
    expect(def.schema.safeParse({ player: "" }).success).toBe(true);
    expect(
      def.schema.safeParse({ player: "org.mpris.MediaPlayer2.fixture" })
        .success,
    ).toBe(true);
    expect(def.schema.safeParse({ player: 1 }).success).toBe(false);
    expect(def.schema.safeParse({}).success).toBe(false);
    expect(def.resource).toBe("media");
  }
  const legacy = actionById("media.control")!;
  expect(legacy.fields.map((f) => f.key)).toEqual(["operation", "player"]);
  expect(legacy.schema.safeParse(makeAction(legacy.id).config).success).toBe(
    true,
  );
});
it("executes all six actions and legacy configs through the shared workflow handler", async () => {
  const calls = vi
    .spyOn(system, "media")
    .mockResolvedValue({ player: "fixture", status: "Paused" });
  const doc = defaults();
  const h = handlers(
    () => doc,
    () => ({}),
    async () => {
      throw new Error("unexpected main dispatch");
    },
    new ObsConnections(() => {}),
  );
  const nodes = [...mediaActions.map((a) => a.id), "media.control"].map(
    (id, index) => {
      const n = node("action", id);
      n.id = `step${index}`;
      n.action = makeAction(id);
      n.action!.config.player = "fixture";
      return n;
    },
  );
  const workflow = {
    ...doc.workflows[0],
    graph: {
      entry: nodes[0].id,
      nodes,
      edges: nodes.slice(1).map((n, i) => ({
        id: `edge${i}`,
        source: nodes[i].id,
        target: n.id,
        port: "next",
      })),
    },
  };
  const engine = new Engine(h, () => {});
  expect((await engine.start(workflow, [workflow]).done).status).toBe(
    "success",
  );
  expect(
    calls.mock.calls.map(([operation, player]) => [operation, player]),
  ).toEqual([
    ...mediaActions.map((a) => [a.operation, "fixture"]),
    ["PlayPause", "fixture"],
  ]);
  const signal = new AbortController().signal;
  await h(makeAction("media.play"), {
    runId: "direct",
    workflowId: "direct",
    signal,
  });
  expect(calls).toHaveBeenLastCalledWith("Play", "", signal);
});
it("round trips new and legacy media values, appearance and aliases without migration", async () => {
  const dir = await mkdtemp(join(tmpdir(), "decker-media-"));
  try {
    const store = new Persistence(dir);
    await store.load();
    const doc = defaults();
    for (const [i, id] of [
      "media.control",
      ...mediaActions.map((a) => a.id),
    ].entries()) {
      const key = binding(id, id);
      if (key.press?.kind === "action")
        key.press.action.config.player = "org.mpris.MediaPlayer2.fixture";
      key.appearance.icon = "🎶";
      doc.profiles[0].pages[0].keys[i] = key;
    }
    const legacy = doc.profiles[0].pages[0].keys[0].press;
    if (legacy?.kind === "action") legacy.action.config.operation = "Previous";
    await store.save(doc, []);
    const reloaded = (await store.load()).document;
    const imported = validateImport((await store.export(reloaded)).document);
    expect(imported).toEqual(doc);
    expect(imported.schemaVersion).toBe(4);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
it("uses observations only, distinguishes every playback state and recovers from disappearance", () => {
  const key = binding("media.playPause");
  key.appearance.icon = actionById("media.playPause")!.icon;
  const config = key.press!.kind === "action" ? key.press!.action.config : {};
  for (const [value, state] of [
    ["Playing", "Playing"],
    ["Paused", "Paused"],
    ["Stopped", "Stopped"],
    ["buffering", "unknown"],
    [null, "unknown"],
  ] as const) {
    const observed = { media: { defaultPlayer: "a", a: value } };
    expect(mediaPlayback(config, observed.media)).toBe(state);
    expect(observedAppearance(key, observed, "#abcdef")).toMatchObject({
      icon: mediaPlaybackIcons[state],
      background: state === "Playing" ? "#abcdef" : key.appearance.background,
      label: key.appearance.label,
    });
  }
  const unavailable: (Record<string, Json> | undefined)[] = [
    undefined,
    { unavailable: true, defaultPlayer: "a", a: "Playing" },
    { defaultPlayer: "" },
    { defaultPlayer: "b", b: "Playing" },
  ];
  for (const media of unavailable) {
    config.player = "a";
    expect(
      observedAppearance(key, media ? { media } : {}, "#abcdef"),
    ).toMatchObject({
      icon: mediaPlaybackIcons.unavailable,
      background: key.appearance.background,
    });
  }
  expect(
    observedAppearance(key, { media: { a: "Paused" } }, "#abcdef").icon,
  ).toBe(mediaPlaybackIcons.Paused);
  // Rendering never writes the authored default, even after many observations.
  expect(key.appearance.icon).toBe("pack:lucide:v1:music");
});
it("preserves custom, uploaded and legacy icons and excludes sequences/workflows", () => {
  const key = binding("media.playPause");
  for (const icon of ["CUSTOM 🎶", "pack:lucide:v1:camera", ""]) {
    key.appearance.icon = icon;
    expect(
      observedAppearance(
        key,
        { media: { defaultPlayer: "a", a: "Playing" } },
        "#abcdef",
      ),
    ).toMatchObject({ icon, background: "#abcdef" });
  }
  key.appearance.icon = "pack:lucide:v1:music";
  key.appearance.asset = "fixture.png";
  expect(
    observedAppearance(
      key,
      { media: { defaultPlayer: "a", a: "Playing" } },
      "#abcdef",
    ),
  ).toMatchObject({ icon: key.appearance.icon, asset: "fixture.png" });
  const legacy = binding("media.control");
  expect(
    observedAppearance(
      legacy,
      { media: { defaultPlayer: "a", a: "Playing" } },
      "#abcdef",
    ),
  ).toMatchObject({ icon: legacy.appearance.icon, background: "#abcdef" });
  for (const press of [
    { kind: "sequence" as const, actions: [makeAction("media.playPause")] },
    { kind: "workflow" as const, workflowId: "test" },
  ]) {
    key.press = press;
    expect(
      observedAppearance(
        key,
        { media: { defaultPlayer: "a", a: "Playing" } },
        "#abcdef",
      ),
    ).toEqual(key.appearance);
  }
});
it("composes concurrent activity over current playback, restoring latest state after cancellation or expiry", async () => {
  const doc = defaults(),
    key = binding("media.playPause"),
    deck = doc.decks[0];
  key.appearance.icon = actionById("media.playPause")!.icon;
  doc.profiles[0].pages[0].keys[0] = key;
  let now = 0;
  const activity = new ButtonActivity(() => now);
  const record = (id: string) => ({
    id,
    workflowId: doc.workflows[0].id,
    workflowName: "Media",
    revision: 1,
    bindingId: key.id,
    generation: key.generation,
    deckId: deck.id,
    startedAt: 0,
    status: "running" as "running" | "cancelled" | "success" | "failure",
    nodes: [],
  });
  const a = record("a"),
    b = record("b");
  let status = "Paused";
  const appearance = () =>
    buttonAppearance(
      key,
      {
        media: { defaultPlayer: "player", player: status },
        buttonFeedback: activity.snapshot(),
      },
      doc.settings.accent,
      deck.id,
    );
  activity.update(a, doc);
  activity.update(b, doc);
  expect(appearance()).toMatchObject({
    icon: mediaPlaybackIcons.Paused,
    background: doc.settings.accent,
  });
  a.status = "cancelled";
  activity.update(a, doc);
  expect(appearance().background).toBe(doc.settings.accent);
  status = "Playing";
  expect(appearance().icon).toBe(mediaPlaybackIcons.Playing);
  status = "Unknown";
  expect(appearance().icon).toBe(mediaPlaybackIcons.unknown);
  b.status = "cancelled";
  activity.update(b, doc);
  expect(appearance().background).toBe(key.appearance.background);
  for (const terminal of ["success", "failure"] as const) {
    a.status = terminal;
    activity.update(a, doc);
    expect(appearance().background).toBe(
      terminal === "success" ? key.appearance.success : key.appearance.error,
    );
    now += 2000;
    activity.expire();
    expect(appearance().background).toBe(key.appearance.background);
  }
  // Representative desktop intent, web payload SVG and generated frame use
  // the same resolved icon/background; uploaded assets are covered separately.
  const images = new Images();
  status = "Paused";
  const paused = await images.render(appearance(), 72);
  status = "Playing";
  const resolved = appearance();
  const playing = await images.render(resolved, 72);
  // WebKey/KeyIcon use this same normalized SVG; frame bytes must match it.
  const webKey = {
    label: resolved.label,
    icon: resolved.icon,
    background: resolved.background,
    asset: resolved.asset,
  };
  const webGeometry = packKeySvg(webKey.icon, webKey.label)!;
  const reference = await sharp(
    Buffer.from(
      `<svg xmlns="http://www.w3.org/2000/svg" width="72" height="72"><rect width="100%" height="100%" fill="${webKey.background}"/>${webGeometry}</svg>`,
    ),
  )
    .removeAlpha()
    .raw()
    .toBuffer();
  expect(playing).toEqual(reference);
  expect(playing.equals(paused)).toBe(false);
  expect(playing.subarray(0, 3).toString("hex")).toBe(
    doc.settings.accent.slice(1),
  );
  status = "Unknown";
  expect(
    (await images.render(appearance(), 72)).subarray(0, 3).toString("hex"),
  ).toBe(key.appearance.background.slice(1));
});
