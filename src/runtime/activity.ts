import { activityKey } from "../shared/feedback";
import type { AppDocument, Json, RunRecord } from "../shared/schema";

/** Transient activity is independent of bounded/persisted history and custom appearance. */
export class ButtonActivity {
  private running = new Map<string, string>();
  private terminal = new Map<string, { status: string; expiresAt: number }>();
  private overrides = new Map<string, { label: string; background: string }>();
  constructor(private now = Date.now) {}
  private validKeys(document: AppDocument) {
    return new Set(
      document.decks.flatMap((deck) =>
        document.profiles
          .filter((p) => deck.profileIds.includes(p.id))
          .flatMap((p) =>
            p.pages.flatMap((p) =>
              Object.values(p.keys).map((binding) =>
                activityKey(deck.id, binding),
              ),
            ),
          ),
      ),
    );
  }
  update(record: RunRecord, document: AppDocument) {
    if (!record.deckId || !record.bindingId || record.generation === undefined)
      return;
    const key = activityKey(record.deckId, {
      id: record.bindingId,
      generation: record.generation,
    });
    if (!this.validKeys(document).has(key)) return;
    if (record.status === "running") {
      this.running.set(record.id, key);
      this.terminal.delete(key);
    } else {
      this.running.delete(record.id);
      if ([...this.running.values()].includes(key)) return;
      if (record.status === "success" || record.status === "failure")
        this.terminal.set(key, {
          status: record.status,
          expiresAt: this.now() + 1500,
        });
      else this.terminal.delete(key);
    }
  }
  override(
    deckId: string,
    binding: { id: string; generation: number },
    label: string,
    background: string,
  ) {
    this.overrides.set(activityKey(deckId, binding), { label, background });
  }
  reconcile(document: AppDocument) {
    const valid = this.validKeys(document);
    for (const [id, key] of this.running)
      if (!valid.has(key)) this.running.delete(id);
    for (const map of [this.terminal, this.overrides])
      for (const key of map.keys()) if (!valid.has(key)) map.delete(key);
  }
  clear() {
    this.interrupt();
    this.overrides.clear();
  }
  interrupt() {
    this.running.clear();
    this.terminal.clear();
  }
  expire() {
    for (const [key, state] of this.terminal)
      if (state.expiresAt <= this.now()) this.terminal.delete(key);
  }
  snapshot(): Record<string, Json> {
    this.expire();
    const result: Record<string, Record<string, Json>> = {};
    for (const [key, { status }] of this.terminal) result[key] = { status };
    for (const key of this.running.values())
      result[key] = { status: "running" };
    for (const [key, override] of this.overrides)
      result[key] = { ...result[key], ...override };
    return result;
  }
}
