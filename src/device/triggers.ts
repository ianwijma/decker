import type { ButtonOrigin } from "../shared/trigger-context";
import type { KeyBinding, Target } from "../shared/schema";
type Held = {
  origin?: ButtonOrigin;
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
      target: Target | undefined,
      deckId: string,
      phase: "press" | "release" | "longPress",
      origin?: ButtonOrigin,
    ) => void,
    private capture?: (
      binding: KeyBinding,
      deckId: string,
    ) => ButtonOrigin | undefined,
  ) {}
  private emit(
    held: Held,
    target: Target | undefined,
    phase: "press" | "release" | "longPress",
  ) {
    if (this.capture)
      this.fire(held.binding, target, held.deckId, phase, held.origin);
    else this.fire(held.binding, target, held.deckId, phase);
  }
  down(device: string, key: number, binding?: KeyBinding, deckId = device) {
    const id = `${device}:${key}`;
    if (this.held.has(id) || !binding) return;
    const held: Held = {
      binding: structuredClone(binding),
      origin: this.capture?.(binding, deckId),
      long: false,
      deckId,
    };
    this.held.set(id, held);
    if (binding.toggle) this.emit(held, undefined, "press");
    else if (binding.longPress)
      held.timer = setTimeout(() => {
        held.long = true;
        this.emit(held, held.binding.longPress!, "longPress");
      }, binding.longPressMs);
    else if (binding.press) this.emit(held, binding.press, "press");
  }
  up(device: string, key: number) {
    const id = `${device}:${key}`,
      held = this.held.get(id);
    if (!held) return;
    clearTimeout(held.timer);
    this.held.delete(id);
    if (held.binding.toggle) return;
    if (held.binding.longPress && !held.long && held.binding.press)
      this.emit(held, held.binding.press, "press");
    if (held.binding.release) this.emit(held, held.binding.release, "release");
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
