import type { Binding } from '../shared/schema'
export class Triggers {
  private held = new Map<
    string,
    { binding: Binding; timer?: ReturnType<typeof setTimeout>; long: boolean; generation?: number }
  >()
  constructor(
    private fire: (
      binding: Binding,
      event: 'press' | 'release' | 'long',
      generation?: number
    ) => void
  ) {}
  down(device: string, index: number, binding: Binding, generation?: number): void {
    const key = `${device}:${index}`
    if (this.held.has(key) || !binding.enabled) return
    const captured = structuredClone(binding),
      entry = {
        binding: captured,
        generation,
        long: false,
        timer: undefined as ReturnType<typeof setTimeout> | undefined
      }
    this.held.set(key, entry)
    if (captured.longPress.length)
      entry.timer = setTimeout(() => {
        entry.long = true
        this.fire(captured, 'long', generation)
      }, captured.longPressMs)
    else this.fire(captured, 'press', generation)
  }
  up(device: string, index: number): void {
    const key = `${device}:${index}`,
      entry = this.held.get(key)
    if (!entry) return
    clearTimeout(entry.timer)
    this.held.delete(key)
    if (entry.binding.longPress.length && !entry.long)
      this.fire(entry.binding, 'press', entry.generation)
    if (entry.binding.release.length) this.fire(entry.binding, 'release', entry.generation)
  }
  disconnect(device?: string): void {
    for (const [key, entry] of this.held)
      if (!device || key.startsWith(device + ':')) {
        clearTimeout(entry.timer)
        this.held.delete(key)
      }
  }
}
