import { randomUUID } from "node:crypto";
import {
  nextOccurrence,
  scheduleError,
  type Schedule,
  type ScheduleState,
} from "../shared/schedules";
import type { AppDocument } from "../shared/schema";
export type ScheduledHandle = {
  done: Promise<"success" | "failure" | "cancelled">;
  cancel(): void;
};
type Entry = {
  definition: Schedule;
  blocked?: boolean;
  stamp: string;
  state: ScheduleState;
  token?: string;
  controller?: AbortController;
  handle?: ScheduledHandle;
};
export type SchedulerDependencies = {
  now(): number;
  monotonic(): number;
  setTimer(callback: () => void, delay: number): unknown;
  clearTimer(timer: unknown): void;
  claim(scheduleId: string, at: number): Promise<void>;
  watermark(scheduleId: string): number;
  launch(
    schedule: Schedule,
    token: string,
    signal: AbortSignal,
  ): Promise<ScheduledHandle>;
  changed(): void;
};
/** One process-owned, bounded clock. No rendering, probes or refresh behavior. */
export class Scheduler {
  private entries = new Map<string, Entry>();
  private timer?: unknown;
  private available = false;
  private stopped = false;
  private wall = 0;
  private monotonic = 0;
  constructor(private deps: SchedulerDependencies) {}
  configure(document: AppDocument) {
    const retained = new Set<string>();
    // Captured executable definitions invalidate pending launches, including nested calls/aliases.
    const definitions = JSON.stringify([
      document.workflows.map(
        ({ layout: _layout, name: _name, ...executable }) => executable,
      ),
      document.workflowAliases,
      document.connections,
    ]);
    for (const definition of document.schedules) {
      retained.add(definition.id);
      const stamp = JSON.stringify(definition) + definitions;
      const old = this.entries.get(definition.id);
      if (old?.stamp === stamp) continue;
      if (old) this.invalidate(old);
      const entry: Entry = {
        definition: structuredClone(definition),
        stamp,
        state: { id: definition.id, busy: false, skipped: 0 },
      };
      const error = scheduleError(definition, document);
      if (error) {
        entry.state.error = error;
        entry.blocked = true;
      } else if (definition.enabled) this.next(entry);
      this.entries.set(definition.id, entry);
    }
    for (const [id, entry] of this.entries)
      if (!retained.has(id)) {
        this.invalidate(entry);
        this.entries.delete(id);
      }
    this.arm();
    this.deps.changed();
  }
  /** Temporarily gate launches until the worker accepts the current document. */
  ready(value: boolean) {
    if (this.stopped) return;
    this.available = value;
    if (value) {
      const now = this.deps.now();
      for (const entry of this.entries.values())
        if (
          entry.definition.enabled &&
          !entry.blocked &&
          (entry.state.nextAt === undefined || entry.state.nextAt <= now)
        )
          this.next(entry);
      this.wall = now;
      this.monotonic = this.deps.monotonic();
    }
    this.arm();
    this.deps.changed();
  }
  /** Suspend/runner replacement: invalidate uncertain effects, then reanchor on readiness. */
  pause() {
    this.available = false;
    for (const entry of this.entries.values()) {
      if (entry.state.busy) entry.state.lastStatus = "interrupted";
      this.invalidate(entry);
    }
    this.arm();
    this.deps.changed();
  }
  stop() {
    this.pause();
    this.stopped = true;
  }
  snapshot(): ScheduleState[] {
    return [...this.entries.values()].map((e) => ({ ...e.state }));
  }
  private valid(entry: Entry, token: string) {
    return (
      !this.stopped &&
      this.entries.get(entry.definition.id) === entry &&
      entry.token === token
    );
  }
  private invalidate(entry: Entry) {
    entry.token = undefined;
    entry.controller?.abort();
    entry.handle?.cancel();
    entry.controller = undefined;
    entry.handle = undefined;
    entry.state.busy = false;
    entry.state.nextAt = undefined;
  }
  private next(entry: Entry, anchor = this.deps.now()) {
    try {
      entry.state.nextAt = nextOccurrence(
        entry.definition.timing,
        entry.definition.timing.kind === "cron"
          ? Math.max(anchor, this.deps.watermark(entry.definition.id))
          : anchor,
      );
    } catch {
      entry.blocked = true;
      entry.state.error =
        "Cannot calculate the next occurrence; edit this schedule";
      entry.state.nextAt = undefined;
    }
  }
  private arm() {
    if (this.timer !== undefined) this.deps.clearTimer(this.timer);
    this.timer = undefined;
    if (!this.available || this.stopped) return;
    const times = [...this.entries.values()].flatMap((e) =>
      e.state.nextAt === undefined ? [] : [e.state.nextAt],
    );
    if (!times.length) return;
    // A bounded heartbeat detects wall-clock changes; never pass long delays to native timers.
    const delay = Math.max(
      1,
      Math.min(1000, Math.min(...times) - this.deps.now()),
    );
    this.timer = this.deps.setTimer(() => this.tick(), delay);
  }
  private tick() {
    this.timer = undefined;
    if (!this.available || this.stopped) return;
    const now = this.deps.now(),
      mono = this.deps.monotonic();
    const jumped = Math.abs(now - this.wall - (mono - this.monotonic)) > 1500;
    this.wall = now;
    this.monotonic = mono;
    for (const entry of this.entries.values()) {
      const due = entry.state.nextAt;
      if (due === undefined) continue;
      if (jumped || now - due > 1500) {
        if (entry.state.busy && !entry.handle) this.invalidate(entry);
        this.next(entry);
        entry.state.skipped = Math.min(1000000, entry.state.skipped + 1);
        continue;
      }
      if (due > now) continue;
      // Cadence uses the last due instant, not completion. Late/missed ticks never queue.
      this.next(entry, due);
      if (
        entry.state.busy ||
        [...this.entries.values()].filter((e) => e.state.busy).length >= 64
      ) {
        entry.state.skipped = Math.min(1000000, entry.state.skipped + 1);
        continue;
      }
      void this.start(entry, due);
    }
    this.arm();
    this.deps.changed();
  }
  private async start(entry: Entry, at: number) {
    const token = randomUUID(),
      controller = new AbortController();
    entry.token = token;
    entry.controller = controller;
    entry.state.busy = true;
    try {
      // Persist before effects. A crash or obsolete callback can only skip, never replay.
      await this.deps.claim(entry.definition.id, at);
      if (!this.valid(entry, token) || !this.available) return;
      if (this.deps.now() - at > 1500 || this.deps.now() < at) {
        entry.state.skipped = Math.min(1000000, entry.state.skipped + 1);
        return;
      }
      const handle = await this.deps.launch(
        entry.definition,
        token,
        controller.signal,
      );
      if (!this.valid(entry, token) || !this.available) {
        handle.cancel();
        return;
      }
      entry.handle = handle;
      entry.state.lastAt = this.deps.now();
      entry.state.lastStatus = "running";
      delete entry.state.error;
      this.deps.changed();
      const status = await handle.done;
      if (this.valid(entry, token)) entry.state.lastStatus = status;
    } catch {
      if (this.valid(entry, token)) {
        entry.state.lastStatus = "failure";
        entry.state.error =
          "Launch or storage failed; check workflow inputs, runner and the 64-run limit";
      }
    } finally {
      if (this.valid(entry, token)) {
        entry.token = undefined;
        entry.controller = undefined;
        entry.handle = undefined;
        entry.state.busy = false;
        this.deps.changed();
      }
    }
  }
}
