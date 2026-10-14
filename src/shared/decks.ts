import { bindingTargets } from "./binding-targets";
import { uid } from "./defaults";
import {
  documentSchema,
  v2DocumentSchema,
  v3DocumentSchema,
  v4DocumentSchema,
  legacyDocumentSchema,
  type AppDocument,
  type DeckConfig,
} from "./schema";
import { migrateWorkflowIdentities } from "./workflow-identity";
export function deckPage(document: AppDocument, deckId: string) {
  const deck = document.decks.find((d) => d.id === deckId);
  return (
    deck &&
    document.profiles
      .find((p) => p.id === deck.activeProfileId)
      ?.pages.find((p) => p.id === deck.activePageId)
  );
}
export function navigateDeck(
  document: AppDocument,
  deckId: string,
  profileId: string,
  pageId: string,
) {
  const deck = document.decks.find((d) => d.id === deckId),
    profile = document.profiles.find((p) => p.id === profileId);
  if (
    !deck ||
    !deck.profileIds.includes(profileId) ||
    !profile?.pages.some((p) => p.id === pageId)
  )
    throw new Error("Profile or page does not belong to this deck");
  deck.activeProfileId = profileId;
  deck.activePageId = pageId;
}
export function cloneProfiles(profiles: AppDocument["profiles"]) {
  const ids = new Map<string, string>();
  for (const profile of profiles) {
    ids.set(profile.id, uid());
    for (const page of profile.pages) {
      ids.set(page.id, uid());
      for (const key of Object.values(page.keys)) ids.set(key.id, uid());
    }
  }
  const cloned = structuredClone(profiles);
  for (const profile of cloned) {
    profile.id = ids.get(profile.id)!;
    for (const page of profile.pages) {
      page.id = ids.get(page.id)!;
      if (page.parentId) page.parentId = ids.get(page.parentId)!;
      for (const key of Object.values(page.keys)) {
        key.id = ids.get(key.id)!;
        key.generation = 0;
        for (const target of bindingTargets(key).map((entry) => entry.target))
          if (target && target.kind !== "workflow")
            for (const action of target.kind === "action"
              ? [target.action]
              : target.actions) {
              for (const field of ["pageId", "profileId"])
                if (
                  typeof action.config[field] === "string" &&
                  ids.has(action.config[field])
                )
                  action.config[field] = ids.get(action.config[field])!;
            }
      }
    }
  }
  return { profiles: cloned, ids };
}
export function migrateDocument(value: unknown): AppDocument {
  const version = (value as { schemaVersion?: number })?.schemaVersion;
  if (version === 5) return documentSchema.parse(value);
  if (version === 4)
    return documentSchema.parse({
      ...v4DocumentSchema.parse(value),
      schemaVersion: 5,
    });
  if (version === 3)
    return migrateDocument({
      ...v3DocumentSchema.parse(value),
      schemaVersion: 4,
    });
  if (
    value &&
    typeof value === "object" &&
    Object.hasOwn(value, "workflowAliases")
  )
    throw new Error("Workflow aliases require schema version 3");
  if (version === 2)
    return migrateDocument(
      migrateWorkflowIdentities(v2DocumentSchema.parse(value)),
    );
  if (version !== 1) throw new Error(`Unsupported schema version ${version}`);
  const old = legacyDocumentSchema.parse(value),
    decks: DeckConfig[] = [],
    profiles: AppDocument["profiles"] = [];
  const devices = [
    ...(old.settings.simulator
      ? [
          {
            id: "simulator-xl",
            brightness: old.settings.brightness,
            kind: "simulator" as const,
          },
        ]
      : []),
    ...old.devices.map((d) => ({ ...d, kind: "hardware" as const })),
  ];
  if (!devices.length)
    devices.push({
      id: "simulator-xl",
      brightness: old.settings.brightness,
      kind: "simulator",
    });
  for (const profile of old.profiles)
    for (const page of profile.pages)
      page.keys = Object.fromEntries(
        Object.entries(page.keys).map(([index, key]) => [
          keySlot(Number(index), 8),
          key,
        ]),
      );
  for (const [i, device] of devices.entries()) {
    const copy =
      i === 0
        ? {
            profiles: old.profiles,
            ids: new Map(
              old.profiles.flatMap(
                (p) =>
                  [[p.id, p.id], ...p.pages.map((pg) => [pg.id, pg.id])] as [
                    string,
                    string,
                  ][],
              ),
            ),
          }
        : cloneProfiles(old.profiles);
    profiles.push(...copy.profiles);
    decks.push({
      id: device.id,
      name: device.kind === "simulator" ? "My XL" : `Stream Deck ${i + 1}`,
      kind: device.kind,
      hardwareId: device.kind === "hardware" ? device.id : undefined,
      icon: "▦",
      rows: 4,
      columns: 8,
      brightness: device.brightness,
      profileIds: copy.profiles.map((p) => p.id),
      activeProfileId: copy.ids.get(old.activeProfileId)!,
      activePageId: copy.ids.get(old.activePageId)!,
    });
  }
  const {
    brightness: _brightness,
    simulator: _simulator,
    ...settings
  } = old.settings;
  return migrateDocument(
    migrateWorkflowIdentities(
      v2DocumentSchema.parse({
        ...old,
        schemaVersion: 2,
        profiles,
        decks,
        activeDeckId: decks[0].id,
        settings: { ...settings, webEnabled: false, webPort: 9018 },
      }),
    ),
  );
}

// Storage uses fixed 16-column coordinates so resizing never moves/deletes existing keys.
export const keySlot = (index: number, columns: number) =>
  Math.floor(index / columns) * 16 + (index % columns);
export const visibleSlot = (slot: number, rows: number, columns: number) =>
  Math.floor(slot / 16) < rows && slot % 16 < columns;

// An editor save must not rewind navigation performed by another deck/browser.
export function preserveNavigation(
  current: AppDocument,
  next: AppDocument,
  editedDecks: string[] = [],
) {
  if (next.decks.some((d) => d.id === current.activeDeckId))
    next.activeDeckId = current.activeDeckId;
  for (const deck of next.decks) {
    const previous = current.decks.find((d) => d.id === deck.id);
    if (
      previous &&
      !editedDecks.includes(deck.id) &&
      deck.profileIds.includes(previous.activeProfileId) &&
      next.profiles
        .find((p) => p.id === previous.activeProfileId)
        ?.pages.some((p) => p.id === previous.activePageId)
    ) {
      deck.activeProfileId = previous.activeProfileId;
      deck.activePageId = previous.activePageId;
    }
  }
}
