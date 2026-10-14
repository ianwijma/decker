import type { KeyBinding, Target } from "../shared/schema";
type Held = {
  binding: KeyBinding;
  long: boolean;
  timer?: ReturnType<typeof setTimeout>;
};
export class Triggers {
  private held = new Map<string, Held>();
  constructor(private fire: (binding: KeyBinding, target: Target) => void) {}
  down(device: string, key: number, binding?: KeyBinding) {
    const id = `${device}:${key}`;
    if (this.held.has(id) || !binding) return;
    const held: Held = { binding: structuredClone(binding), long: false };
    this.held.set(id, held);
    if (binding.longPress)
      held.timer = setTimeout(() => {
        held.long = true;
        this.fire(held.binding, held.binding.longPress!);
      }, binding.longPressMs);
    else if (binding.press) this.fire(held.binding, binding.press);
  }
  up(device: string, key: number) {
    const id = `${device}:${key}`,
      held = this.held.get(id);
    if (!held) return;
    clearTimeout(held.timer);
    this.held.delete(id);
    if (held.binding.longPress && !held.long && held.binding.press)
      this.fire(held.binding, held.binding.press);
    if (held.binding.release) this.fire(held.binding, held.binding.release);
  }
  disconnect(device?: string) {
    for (const [id, held] of this.held)
      if (!device || id.startsWith(`${device}:`)) {
        clearTimeout(held.timer);
        this.held.delete(id);
      }
  }
}
