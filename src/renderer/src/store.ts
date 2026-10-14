import { create } from "zustand";
import type { AppDocument, Request, Snapshot } from "../../shared/schema";
import { brightnessEdits } from "../../shared/brightness";
type State = {
  snapshot?: Snapshot;
  error?: string;
  saving: boolean;
  tab: "home" | "deck" | "flows" | "settings";
  settingsSection: "general" | "web" | "diagnostics" | "runs";
  setSettingsSection: (section: State["settingsSection"]) => void;
  setTab: (tab: State["tab"]) => void;
  setError: (error?: string) => void;
  receive: (snapshot: Snapshot) => void;
  edit: (fn: (draft: AppDocument) => void) => void;
  request: (request: Request) => Promise<unknown>;
};
let pending = Promise.resolve(),
  version = 0,
  saves = 0,
  credentialPending = false;
export const useApp = create<State>((set, get) => ({
  saving: false,
  tab: "home",
  settingsSection: "general",
  setSettingsSection: (settingsSection) => set({ settingsSection }),
  setTab: (tab) => set({ tab }),
  setError: (error) => set({ error }),
  receive: (snapshot) =>
    set((state) => ({
      snapshot:
        saves && state.snapshot
          ? { ...snapshot, document: state.snapshot.document }
          : snapshot,
    })),
  edit: (fn) => {
    if (credentialPending) {
      set({
        error: "Wait for the secret to finish saving, then retry your edit.",
      });
      return;
    }
    const snapshot = get().snapshot;
    if (!snapshot) return;
    const document = structuredClone(snapshot.document);
    fn(document);
    const editedBrightness = brightnessEdits(snapshot.document, document);
    const navigationEdits = document.decks
      .filter((deck) => {
        const previous = snapshot.document.decks.find((d) => d.id === deck.id);
        return (
          !previous ||
          previous.activeProfileId !== deck.activeProfileId ||
          previous.activePageId !== deck.activePageId
        );
      })
      .map((d) => d.id);
    const editVersion = ++version;
    saves++;
    set({ snapshot: { ...snapshot, document }, saving: true });
    pending = pending
      .catch(() => {})
      .then(async () => {
        try {
          const saved = (await window.decker.request({
            type: "save",
            document,
            navigationEdits,
            brightnessEdits: editedBrightness,
          })) as Snapshot;
          if (version === editVersion) set({ snapshot: saved });
        } catch (error) {
          set({ error: String(error) });
          if (version === editVersion)
            set({ snapshot: await window.decker.snapshot() });
        } finally {
          saves--;
          set({ saving: saves > 0 });
        }
      });
  },
  request: async (request) => {
    const credential = request.type === "credential";
    if (credential && credentialPending) return undefined;
    if (credential) credentialPending = true;
    try {
      await pending;
      const result = await window.decker.request(request);
      if (credential && result) set({ snapshot: result as Snapshot });
      return result;
    } catch (error) {
      set({ error: String(error) });
      return undefined;
    } finally {
      if (credential) credentialPending = false;
    }
  },
}));
