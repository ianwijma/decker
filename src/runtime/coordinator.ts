import type { KeyBinding, WorkflowDefinition } from "../shared/schema";
import { Engine, type RunHandle } from "./engine";
export class Coordinator {
  private active = new Map<string, Set<RunHandle>>();
  private queued = new Map<string, Array<() => void>>();
  constructor(private engine: Engine) {}
  trigger(
    binding: KeyBinding,
    workflow: WorkflowDefinition,
    all: WorkflowDefinition[],
    deckId?: string,
    phase = "press",
  ): void {
    const key = `${binding.id}:${phase}`,
      active = this.active.get(key) ?? new Set<RunHandle>();
    this.active.set(key, active);
    const launch = () => {
      const handle = this.engine.start(
        workflow,
        all,
        {},
        { bindingId: binding.id, generation: binding.generation, deckId },
      );
      active.add(handle);
      void handle.done.finally(() => {
        active.delete(handle);
        if (!active.size) {
          const next = this.queued.get(key)?.shift();
          if (next) next();
          else {
            this.active.delete(key);
            this.queued.delete(key);
          }
        }
      });
    };
    if (!active.size) {
      launch();
      return;
    }
    if (binding.policy === "ignore") return;
    if (binding.policy === "concurrent") {
      if (active.size < binding.limit) launch();
      return;
    }
    const queue = this.queued.get(key) ?? [];
    this.queued.set(key, queue);
    if (binding.policy === "restart") {
      queue.splice(0, queue.length, launch);
      for (const h of active) h.cancel();
      return;
    }
    if (queue.length < binding.limit) queue.push(launch);
  }
  cancel(id: string) {
    for (const [key, handles] of this.active)
      for (const h of handles)
        if (h.record.id === id || h.record.workflowId === id) {
          this.queued.delete(key);
          h.cancel();
        }
  }
  stop() {
    this.queued.clear();
    for (const handles of this.active.values())
      for (const h of handles) h.cancel();
  }
}
export class ResourceLocks {
  private tails = new Map<string, Promise<void>>();
  async run<T>(
    resource: string,
    signal: AbortSignal,
    fn: () => Promise<T>,
  ): Promise<T> {
    const previous = this.tails.get(resource) ?? Promise.resolve();
    let release!: () => void;
    const current = new Promise<void>((r) => {
      release = r;
    });
    this.tails.set(resource, current);
    try {
      await previous;
      signal.throwIfAborted();
      return await fn();
    } finally {
      release();
      if (this.tails.get(resource) === current) this.tails.delete(resource);
    }
  }
}
