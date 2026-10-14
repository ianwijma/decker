import type { KeyBinding, WorkflowDefinition } from "../shared/schema";
import { withCancellation } from "./cancellation";
import { Engine, type RunHandle } from "./engine";
export class Coordinator {
  private active = new Map<string, Set<RunHandle>>();
  private queued = new Map<
    string,
    Array<{ matchesWorkflow: (id: string) => boolean; launch: () => void }>
  >();
  constructor(private engine: Engine) {}
  trigger(
    binding: KeyBinding,
    workflow: WorkflowDefinition,
    all: WorkflowDefinition[],
    deckId?: string,
    phase = "press",
  ): void {
    const key = JSON.stringify([deckId, binding.id, binding.generation, phase]),
      active = this.active.get(key) ?? new Set<RunHandle>();
    this.active.set(key, active);
    const prepared = this.engine.prepare(workflow, all, {
      bindingId: binding.id,
      generation: binding.generation,
      deckId,
    });
    const launch = () => {
      const handle = prepared.launch();
      active.add(handle);
      void handle.done.finally(() => {
        active.delete(handle);
        if (!active.size) {
          const next = this.queued.get(key)?.shift();
          if (next) {
            next.launch();
          } else {
            this.active.delete(key);
            this.queued.delete(key);
          }
        }
      });
    };
    const queued = { matchesWorkflow: prepared.matchesWorkflow, launch };
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
      queue.splice(0, queue.length, queued);
      for (const h of active) h.cancel();
      return;
    }
    if (queue.length < binding.limit) queue.push(queued);
  }
  /** Explicit run IDs never select a workflow or discard its queued siblings. */
  cancel(id: string) {
    this.engine.cancelRun(id);
  }
  cancelWorkflow(id: string) {
    // Prune first: cancellation may immediately let a waiting replacement launch.
    for (const [key, queue] of this.queued) {
      const remaining = queue.filter((start) => !start.matchesWorkflow(id));
      if (remaining.length) this.queued.set(key, remaining);
      else this.queued.delete(key);
    }
    this.engine.cancelWorkflow(id);
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
    const gate = new Promise<void>((r) => {
      release = r;
    });
    // An aborted waiter must not let the next waiter overtake the owner.
    const current = previous.catch(() => {}).then(() => gate);
    this.tails.set(resource, current);
    try {
      await withCancellation(previous, signal, 0);
      signal.throwIfAborted();
      return await fn();
    } finally {
      release();
      void current.then(() => {
        if (this.tails.get(resource) === current) this.tails.delete(resource);
      });
    }
  }
}
