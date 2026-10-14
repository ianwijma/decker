import { it, expect, vi } from "vitest";
import { mkdtemp, writeFile, readFile, readdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { defaults, binding } from "../src/shared/defaults";
import {
  cloneProfiles,
  migrateDocument,
  navigateDeck,
  keySlot,
  visibleSlot,
} from "../src/shared/decks";
import { Persistence, validateDocument } from "../src/main/persistence";
import { Triggers } from "../src/device/triggers";
function legacy() {
  const { workflowAliases: _aliases, ...current } = defaults();
  return {
    ...current,
    schemaVersion: 1,
    devices: [{ id: "xl:serial-123", brightness: 45 }],
    settings: { ...current.settings, simulator: true, brightness: 70 },
    activeProfileId: "default",
    activePageId: "home",
  };
}
it("migrates independent deck profiles, remaps folders and preserves original IDs", () => {
  const old = legacy();
  old.profiles[0].pages.push({
    id: "folder",
    name: "Folder",
    parentId: "home",
    keys: {},
  });
  const enter = binding("deck.page");
  if (enter.press?.kind !== "action") throw new Error();
  enter.press.action.config.pageId = "folder";
  old.profiles[0].pages[0].keys[8] = enter;
  const doc = migrateDocument(old);
  expect(doc.schemaVersion).toBe(3);
  expect(doc.decks).toHaveLength(2);
  expect(doc.decks[1].brightness).toBe(45);
  expect(doc.profiles[0].pages[0].keys[16].id).toBe(enter.id);
  const copied = doc.profiles[1];
  expect(copied.pages[1].parentId).toBe(copied.pages[0].id);
  expect(copied.pages[0].keys[16].press).toMatchObject({
    action: { config: { pageId: copied.pages[1].id } },
  });
  expect(validateDocument(doc)).toEqual(doc);
});
it("backs up and persists v1 migration once, with no loss of assignments", async () => {
  const directory = await mkdtemp(join(tmpdir(), "decker-migration-"));
  try {
    await writeFile(join(directory, "config.json"), JSON.stringify(legacy()));
    const store = new Persistence(directory);
    const result = await store.load();
    expect(result.warning).toBeUndefined();
    expect(result.document.schemaVersion).toBe(3);
    expect(
      (await readdir(directory)).filter((f) =>
        f.startsWith("migration-backup-"),
      ),
    ).toHaveLength(1);
    expect(
      JSON.parse(await readFile(join(directory, "config.json"), "utf8"))
        .schemaVersion,
    ).toBe(3);
    expect((await store.load()).document).toEqual(result.document);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
it("changing or selecting one deck leaves another active page untouched", () => {
  const doc = migrateDocument(legacy());
  const first = doc.decks[0],
    second = doc.decks[1],
    profile = doc.profiles.find((p) => p.id === first.activeProfileId)!;
  profile.pages.push({ id: "another", name: "Second page", keys: {} });
  navigateDeck(doc, first.id, profile.id, "another");
  expect(first.activePageId).toBe("another");
  expect(second.activePageId).not.toBe("another");
  expect(() => navigateDeck(doc, second.id, profile.id, "another")).toThrow(
    "does not belong",
  );
  doc.activeDeckId = second.id;
  expect(first.activePageId).toBe("another");
});
it("resize preserves key coordinates and cloned profiles have unique bindings", () => {
  const doc = defaults(),
    page = doc.profiles[0].pages[0];
  const slot = keySlot(9, 5);
  page.keys[slot] = binding("desktop.copy", "Saved");
  expect(slot).toBe(20);
  expect(visibleSlot(slot, 1, 3)).toBe(false);
  expect(visibleSlot(slot, 2, 5)).toBe(true);
  expect(page.keys[keySlot(9, 5)].appearance.label).toBe("Saved");
  const copy = cloneProfiles(doc.profiles);
  expect(copy.profiles[0].pages[0].keys[slot].id).not.toBe(page.keys[slot].id);
});
it("captures the originating deck and release binding across changes", () => {
  const events: unknown[] = [];
  const triggers = new Triggers((b, t, deckId) =>
      events.push({ label: b.appearance.label, target: t, deckId }),
    ),
    key = binding("desktop.copy", "Original");
  key.release = key.press;
  triggers.down("browser-session", 0, key, "tablet");
  key.appearance.label = "Edited";
  triggers.up("browser-session", 0);
  expect(events).toMatchObject([
    { deckId: "tablet", label: "Original" },
    { deckId: "tablet", label: "Original" },
  ]);
});

it("a stale editor save cannot rewind another deck’s navigation", async () => {
  const { preserveNavigation } = await import("../src/shared/decks");
  const current = migrateDocument(legacy()),
    next = structuredClone(current),
    deck = current.decks[1],
    profile = current.profiles.find((p) => p.id === deck.activeProfileId)!;
  profile.pages.push({ id: "remote-page", name: "Remote", keys: {} });
  next.profiles
    .find((p) => p.id === profile.id)!
    .pages.push({ id: "remote-page", name: "Remote", keys: {} });
  navigateDeck(current, deck.id, profile.id, "remote-page");
  preserveNavigation(current, next, []);
  expect(next.decks[1].activePageId).toBe("remote-page");
  next.decks[1].activePageId = next.profiles.find(
    (p) => p.id === profile.id,
  )!.pages[0].id;
  preserveNavigation(current, next, [deck.id]);
  expect(next.decks[1].activePageId).not.toBe("remote-page");
});
it("disconnecting one deck keeps other deck hold timers alive", () => {
  vi.useFakeTimers();
  try {
    const events: string[] = [];
    const t = new Triggers((_b, _target, deck) => events.push(deck)),
      b = binding("desktop.copy");
    b.longPress = b.press;
    t.down("first-source", 0, b, "first");
    t.down("second-source", 0, b, "second");
    t.disconnectDeck("first");
    vi.advanceTimersByTime(700);
    expect(events).toEqual(["second"]);
  } finally {
    vi.useRealTimers();
  }
});
