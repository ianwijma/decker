import type { TrustedLaunch } from "../shared/trigger-context";
import { observedToggle } from "../shared/toggle-observation";
import { randomUUID } from "node:crypto";
import type {
  AppDocument,
  KeyBinding,
  Json,
  Target,
  ObservationSource,
} from "../shared/schema";
import {
  toggleBindings,
  toggleKey,
  type ConfirmedState,
  type ToggleState,
  type ToggleError,
} from "../shared/toggle-contract";
import type {
  StoredToggle,
  ToggleStorageRequest,
} from "../main/toggle-storage";
import { Engine, type RunHandle } from "./engine";
import {
  targetWorkflow,
  toggleDefinitionStamp,
  toggleStamp,
  type TargetDocument,
} from "./targets";
import type { ExecutionResult } from "./results";

type Entry = {
  key: string;
  stamp: string;
  definitionStamp: string;
  binding: KeyBinding;
  document: TargetDocument;
  state: ToggleState;
  valid: boolean;
  busy: boolean;
  ready: Promise<void>;
  handle?: RunHandle;
  observationActive: boolean;
};
export type ToggleStore = (
  request: ToggleStorageRequest,
) => Promise<StoredToggle | null>;

/** Strict probe contract: native boolean, {on:boolean}, or exact on/off string.
 * Command targets use stdout, trimmed once; workflow return can use {on:boolean}.
 * No truthiness, JSON guessing, history parsing or fallback-to-off.
 */
export function probeState(value: Json): ConfirmedState | undefined {
  if (typeof value === "boolean") return value ? "on" : "off";
  if (value === "on" || value === "off") return value;
  if (value && typeof value === "object" && !Array.isArray(value)) {
    if (Object.keys(value).length === 1 && typeof value.on === "boolean")
      return value.on ? "on" : "off";
    if (
      typeof value.stdout === "string" &&
      value.exitCode === 0 &&
      value.stdout.length <= 1024
    ) {
      const text = value.stdout.trim();
      if (text === "on" || text === "true") return "on";
      if (text === "off" || text === "false") return "off";
    }
  }
  return undefined;
}

export class Toggles {
  private entries = new Map<string, Entry>();
  private stopped = false;
  private observations: Record<string, Json> = {};
  private observationRevision = 0;
  constructor(
    private engine: Engine,
    private storage: ToggleStore,
    private emit: (states: ToggleState[]) => void,
    private readObservation?: (
      source: ObservationSource,
      owner: {
        deckId: string;
        bindingId: string;
        generation: number;
        definitionStamp: string;
      },
    ) => Promise<Record<string, Json>>,
  ) {}
  snapshot() {
    return [...this.entries.values()]
      .slice(0, 4096)
      .map((e) => ({ ...e.state }));
  }
  private publish() {
    this.emit(this.snapshot());
  }
  configure(document: AppDocument, activate = false) {
    if (this.stopped) return;
    const keep = new Set<string>();
    let definitions: TargetDocument | undefined;
    for (const { deckId, binding } of toggleBindings(document)) {
      const key = toggleKey(deckId, binding),
        definitionStamp = toggleDefinitionStamp(binding, document);
      keep.add(key);
      const previous = this.entries.get(key);
      if (previous?.definitionStamp === definitionStamp) {
        if (activate) previous.observationActive = true;
        if (activate && !previous.busy) void this.reconcile(deckId, binding.id);
        continue;
      }
      if (previous) {
        previous.valid = false;
        previous.handle?.cancel();
      }
      const entry: Entry = {
        key,
        stamp: toggleStamp(binding),
        definitionStamp,
        binding: structuredClone(binding),
        document: (definitions ??= structuredClone({
          workflows: document.workflows,
          workflowAliases: document.workflowAliases,
        })),
        valid: true,
        observationActive: activate,
        busy: true,
        ready: Promise.resolve(),
        state: {
          deckId,
          bindingId: binding.id,
          generation: binding.generation,
          confirmed: "unknown",
          transitioning: false,
          reconciling: false,
          fresh: false,
          blocked: false,
        },
      };
      this.entries.set(key, entry);
      entry.ready = this.initialize(entry, activate).finally(() => {
        entry.busy = false;
        if (entry.valid) {
          this.publish();
          this.refreshObserved(entry);
        }
      });
    }
    for (const [key, entry] of this.entries)
      if (!keep.has(key)) {
        entry.valid = false;
        entry.handle?.cancel();
        this.entries.delete(key);
      }
    this.publish();
  }
  private async initialize(e: Entry, activate: boolean) {
    try {
      const stored = await this.storage({
        operation: "read",
        key: e.key,
        stamp: e.stamp,
        definitionStamp: e.definitionStamp,
      });
      if (!e.valid) return;
      const source = e.binding.toggle!.source;
      e.state.confirmed =
        stored?.confirmed ??
        (source.kind === "app" ? source.initial : "unknown");
      if (stored?.pending) {
        e.state.blocked = true;
        e.state.error = "interrupted";
      }
      if (source.kind !== "app") {
        if (activate) await this.observe(e, undefined, true);
      } else e.state.fresh = !e.state.blocked;
    } catch {
      this.fail(e, "storage", true);
    }
  }
  private fail(e: Entry, error: ToggleError, blocked = false) {
    e.state.error = error;
    e.state.blocked ||= blocked;
    e.state.fresh = false;
  }
  private launch(
    e: Entry,
    target: Target,
    probe = false,
    launch?: TrustedLaunch,
  ): RunHandle {
    const workflow = structuredClone(targetWorkflow(target, e.document));
    if (probe && e.binding.toggle!.source.kind === "external")
      workflow.timeoutMs = Math.min(
        workflow.timeoutMs,
        e.binding.toggle!.source.timeoutMs,
      );
    const handle = this.engine.start(
      workflow,
      e.document.workflows,
      {},
      {
        bindingId: e.binding.id,
        generation: e.binding.generation,
        deckId: e.state.deckId,
        launch,
      },
      e.document.workflowAliases,
      { privateResult: probe },
    );
    e.handle = handle;
    return handle;
  }
  private async observe(e: Entry, expected?: ConfirmedState, refresh = false) {
    const source = e.binding.toggle!.source;
    if (source.kind === "app" || !e.valid || this.stopped) return;
    e.state.reconciling = true;
    e.state.fresh = false;
    this.publish();
    let revision = this.observationRevision;
    try {
      let observed: ConfirmedState | undefined;
      if (source.kind === "observed") {
        if (refresh && this.readObservation) {
          const sample = await this.readObservation(source.observation, {
            deckId: e.state.deckId,
            bindingId: e.binding.id,
            generation: e.binding.generation,
            definitionStamp: e.definitionStamp,
          });
          if (!e.valid) return;
          this.observations = {
            ...this.observations,
            ...structuredClone(sample),
          };
          revision = ++this.observationRevision;
        }
        const value = observedToggle(source.observation, this.observations);
        observed =
          value === undefined
            ? undefined
            : value === source.onWhen
              ? "on"
              : "off";
        if (!observed) {
          this.fail(e, "unavailable");
          return;
        }
      } else {
        const result = await this.launch(e, source.probe, true).result;
        if (!e.valid) return;
        if (result.status !== "success") {
          this.fail(
            e,
            result.status === "failure" ? "probe-failed" : result.status,
          );
          return;
        }
        observed =
          result.output.status === "available"
            ? probeState(result.output.value)
            : undefined;
        if (!observed) {
          this.fail(e, "probe-invalid");
          return;
        }
      }
      // A valid external observation can recover a pending/crashed transition.
      try {
        await this.storage({
          operation: "recover",
          key: e.key,
          stamp: e.stamp,
          definitionStamp: e.definitionStamp,
          confirmed: observed,
        });
      } catch {
        this.fail(e, "storage", true);
        return;
      }
      if (!e.valid) return;
      if (source.kind === "observed" && revision !== this.observationRevision) {
        await this.observe(e, expected);
        return;
      }
      e.state.confirmed = observed;
      e.state.fresh = true;
      e.state.blocked = false;
      e.state.error =
        expected && expected !== observed ? "probe-disagreed" : undefined;
    } catch {
      this.fail(e, "unavailable");
    } finally {
      e.handle = undefined;
      e.state.reconciling = false;
      if (e.valid) this.publish();
    }
  }
  press(
    deckId: string,
    binding: Pick<KeyBinding, "id" | "generation">,
    launch?: TrustedLaunch,
  ): Promise<boolean> {
    const e = this.entries.get(toggleKey(deckId, binding));
    if (
      !e ||
      !e.valid ||
      e.busy ||
      e.state.blocked ||
      !e.state.fresh ||
      e.state.confirmed === "unknown" ||
      this.stopped
    ) {
      this.engine.discardLaunch(launch);
      return Promise.resolve(false);
    }
    e.busy = true;
    e.state.transitioning = true;
    e.state.error = undefined;
    const next = e.state.confirmed === "on" ? "off" : "on";
    this.publish();
    return this.transition(e, next, launch).finally(() => {
      this.engine.discardLaunch(launch);
      e.busy = false;
      e.handle = undefined;
      e.state.transitioning = false;
      if (e.valid) this.publish();
    });
  }
  private async transition(
    e: Entry,
    next: ConfirmedState,
    launch?: TrustedLaunch,
  ): Promise<boolean> {
    const token = randomUUID();
    try {
      // Journal before effects: a crash or failed final commit is never replayed.
      await this.storage({
        operation: "prepare",
        key: e.key,
        stamp: e.stamp,
        definitionStamp: e.definitionStamp,
        token,
        confirmed:
          e.state.confirmed === "unknown" ? undefined : e.state.confirmed,
      });
    } catch {
      this.fail(e, "storage", true);
      return false;
    }
    if (!e.valid || this.stopped) return false;
    let result: ExecutionResult;
    try {
      result = await this.launch(e, e.binding.toggle![next], false, launch)
        .result;
    } catch {
      result = { status: "failure" };
    }
    if (!e.valid) return false;
    const source = e.binding.toggle!.source;
    try {
      const confirmed =
        result.status === "success" && source.kind === "app"
          ? next
          : e.state.confirmed;
      await this.storage({
        operation: "commit",
        key: e.key,
        stamp: e.stamp,
        definitionStamp: e.definitionStamp,
        token,
        confirmed: confirmed === "unknown" ? undefined : confirmed,
      });
      if (!e.valid) return false;
      if (source.kind === "app") {
        if (result.status === "success") {
          e.state.confirmed = next;
          e.state.fresh = true;
        } else {
          e.state.error =
            result.status === "failure" ? "transition-failed" : result.status;
        }
      } else if (result.status === "cancelled") this.fail(e, "cancelled");
      else {
        await this.observe(
          e,
          result.status === "success" ? next : undefined,
          true,
        );
        if (result.status !== "success" && e.state.fresh)
          e.state.error =
            result.status === "failure" ? "transition-failed" : result.status;
      }
      return result.status === "success";
    } catch {
      this.fail(e, "storage", true);
      return false;
    }
  }
  /** Reuses adapter events/polls, never executes a target or adds a timer. */
  updateObservations(observed: Record<string, Json>) {
    this.observations = { ...this.observations, ...structuredClone(observed) };
    this.observationRevision++;
    for (const e of this.entries.values()) this.refreshObserved(e);
  }
  private refreshObserved(e: Entry) {
    const source = e.binding.toggle!.source;
    if (
      source.kind !== "observed" ||
      !e.observationActive ||
      !e.valid ||
      e.busy ||
      this.stopped ||
      e.state.error === "storage"
    )
      return;
    const value = observedToggle(source.observation, this.observations);
    if (value === undefined) {
      this.fail(e, "unavailable");
      this.publish();
      return;
    }
    const confirmed = value === source.onWhen ? "on" : "off";
    if (e.state.fresh && !e.state.blocked && e.state.confirmed === confirmed)
      return;
    e.busy = true;
    void this.observe(e).finally(() => {
      e.busy = false;
      this.refreshObserved(e);
    });
  }
  /** Explicit/lifecycle reconciliation only; never a periodic timer. */
  async reconcile(deckId: string, bindingId: string) {
    const e = [...this.entries.values()].find(
      (e) => e.state.deckId === deckId && e.binding.id === bindingId,
    );
    if (!e || !e.valid || e.busy || this.stopped) return false;
    e.busy = true;
    e.observationActive = true;
    try {
      await this.observe(e, undefined, true);
      return e.state.fresh;
    } finally {
      e.busy = false;
    }
  }
  async recover(deckId: string, bindingId: string, confirmed: ConfirmedState) {
    const e = [...this.entries.values()].find(
      (e) => e.state.deckId === deckId && e.binding.id === bindingId,
    );
    if (
      !e ||
      e.busy ||
      !e.valid ||
      this.stopped ||
      e.binding.toggle!.source.kind !== "app"
    )
      return false;
    e.busy = true;
    try {
      await this.storage({
        operation: "recover",
        key: e.key,
        stamp: e.stamp,
        definitionStamp: e.definitionStamp,
        confirmed,
      });
      if (!e.valid) return false;
      Object.assign(e.state, {
        confirmed,
        blocked: false,
        fresh: true,
        error: undefined,
      });
      this.publish();
      return true;
    } catch {
      this.fail(e, "storage", true);
      this.publish();
      return false;
    } finally {
      e.busy = false;
    }
  }
  async settled() {
    await Promise.all([...this.entries.values()].map((e) => e.ready));
  }
  stop() {
    this.stopped = true;
    for (const e of this.entries.values()) {
      e.valid = false;
      e.handle?.cancel();
    }
    this.entries.clear();
    this.publish();
  }
}
