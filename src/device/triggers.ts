import type { KeyBinding, Target } from "../shared/schema";
type Held = {
  binding: KeyBinding;
  deckId: string;
  long: boolean;
  timer?: ReturnType<typeof setTimeout>;
};
export class Triggers {
  private held = new Map<string, Held>();
  constructor(
    private fire: (
      binding: KeyBinding,
      target: Target,
      deckId: string,
      phase: "press" | "release" | "longPress",
    ) => void,
  ) {}
  down(device: string, key: number, binding?: KeyBinding, deckId = device) {
    const id = `${device}:${key}`;
    if (this.held.has(id) || !binding) return;
    const held: Held = {
      binding: structuredClone(binding),
      long: false,
      deckId,
    };
    this.held.set(id, held);
    if (binding.longPress)
      held.timer = setTimeout(() => {
        held.long = true;
        this.fire(
          held.binding,
          held.binding.longPress!,
          held.deckId,
          "longPress",
        );
      }, binding.longPressMs);
    else if (binding.press)
      this.fire(held.binding, binding.press, held.deckId, "press");
  }
  up(device: string, key: number) {
    const id = `${device}:${key}`,
      held = this.held.get(id);
    if (!held) return;
    clearTimeout(held.timer);
    this.held.delete(id);
    if (held.binding.longPress && !held.long && held.binding.press)
      this.fire(held.binding, held.binding.press, held.deckId, "press");
    if (held.binding.release)
      this.fire(held.binding, held.binding.release, held.deckId, "release");
  }
  disconnectDeck(deckId: string) {
    for (const [id, held] of this.held)
      if (held.deckId === deckId) {
        clearTimeout(held.timer);
        this.held.delete(id);
      }
  }
  disconnect(device?: string) {
    for (const [id, held] of this.held)
      if (!device || id.startsWith(`${device}:`)) {
        clearTimeout(held.timer);
        this.held.delete(id);
      }
  }
}
