import { randomUUID } from "node:crypto";
import type { AppDocument } from "../shared/schema";
import { visibleSlot } from "../shared/decks";
import {
  refreshError,
  type Refresh,
  type RefreshState,
} from "../shared/refresh";
import { originKey, type ButtonOrigin } from "../shared/trigger-context";
import { refreshStamp, viewVersion } from "../runtime/refresh-definition";
import type { ScheduledHandle } from "./scheduler";
type Entry = {
  origin: ButtonOrigin;
  definition: Refresh;
  stamp: string;
  eligible: boolean;
  visible: boolean;
  failures: number;
  cooldown: number;
  due?: number;
  state: RefreshState;
  token?: string;
  controller?: AbortController;
  handle?: ScheduledHandle;
};
export const REFRESH_LIMITS = {
  concurrency: 4,
  leases: 130,
  ttl: 15000,
  entries: 4096,
};
/** One main-owned heartbeat; surfaces report leases, never execution targets. */
export class RefreshService {
  private entries = new Map<string, Entry>();
  private leases = new Map<
    string,
    { deckId: string; version: string; kind: string; expires: number }
  >();
  private document?: AppDocument;
  private available = false;
  private stopped = false;
  private timer?: unknown;
  private cursor = 0;
  private wall = 0;
  private mono = 0;
  constructor(
    private deps: {
      now(): number;
      monotonic(): number;
      setTimer(callback: () => void, delay: number): unknown;
      clearTimer(timer: unknown): void;
      launch(
        origin: ButtonOrigin,
        definition: Refresh,
        stamp: string,
        token: string,
        signal: AbortSignal,
      ): Promise<ScheduledHandle>;
      changed(): void;
      heartbeat?(): void;
      version?(document: AppDocument, deckId: string): string;
    },
  ) {}
  private version(document: AppDocument, deckId: string) {
    return (
      this.deps.version?.(document, deckId) ?? viewVersion(document, deckId)
    );
  }
  configure(document: AppDocument) {
    this.document = document;
    const retained = new Set<string>();
    for (const deck of document.decks)
      for (const profile of document.profiles.filter((p) =>
        deck.profileIds.includes(p.id),
      ))
        for (const page of profile.pages)
          for (const [slot, b] of Object.entries(page.keys)) {
            if (!b.refresh || retained.size >= REFRESH_LIMITS.entries) continue;
            const origin = {
              deckId: deck.id,
              profileId: profile.id,
              pageId: page.id,
              bindingId: b.id,
              generation: b.generation,
            };
            const key = originKey(origin),
              stamp = refreshStamp(document, origin);
            retained.add(key);
            let entry = this.entries.get(key);
            if (entry?.stamp !== stamp) {
              if (entry) this.invalidate(entry);
              entry = {
                origin,
                definition: structuredClone(b.refresh),
                stamp,
                eligible: false,
                visible: false,
                failures: 0,
                cooldown: 0,
                state: { origin, status: "idle" },
              };
              this.entries.set(key, entry);
            }
            entry!.eligible =
              b.refresh.enabled &&
              !refreshError(b.refresh, document) &&
              deck.activeProfileId === profile.id &&
              deck.activePageId === page.id &&
              visibleSlot(Number(slot), deck.rows, deck.columns);
          }
    for (const [key, entry] of this.entries)
      if (!retained.has(key)) {
        this.invalidate(entry);
        this.entries.delete(key);
      }
    for (const [source, lease] of this.leases)
      if (
        this.version(document, lease.deckId) !== lease.version ||
        !document.decks.some(
          (d) => d.id === lease.deckId && d.kind === lease.kind,
        )
      )
        this.leases.delete(source);
    this.reconcile();
  }
  /** Callers validate sender/authentication/applied view first. TTL covers silent death. */
  lease(
    source: string,
    deckId: string,
    version: string,
    ttl = REFRESH_LIMITS.ttl,
  ) {
    if (
      this.stopped ||
      !this.document ||
      this.version(this.document, deckId) !== version ||
      !this.document.decks.some((d) => d.id === deckId)
    )
      return;
    if (!this.leases.has(source) && this.leases.size >= REFRESH_LIMITS.leases)
      return;
    if (!this.leases.size) {
      this.wall = this.deps.now();
      this.mono = this.deps.monotonic();
    }
    this.leases.set(source, {
      kind: this.document.decks.find((d) => d.id === deckId)!.kind,
      deckId,
      version,
      expires:
        this.deps.monotonic() + Math.min(Math.max(ttl, 1), REFRESH_LIMITS.ttl),
    });
    this.reconcile();
  }
  drop(source: string, version?: string) {
    if (version && this.leases.get(source)?.version !== version) return;
    if (this.leases.delete(source)) this.reconcile();
  }
  dropPrefix(prefix: string) {
    for (const source of this.leases.keys())
      if (source.startsWith(prefix)) this.leases.delete(source);
    this.reconcile();
  }
  ready(value: boolean) {
    if (this.stopped) return;
    this.available = value;
    this.wall = this.deps.now();
    this.mono = this.deps.monotonic();
    this.reconcile();
  }
  pause(clearLeases = false) {
    this.available = false;
    if (clearLeases) this.leases.clear();
    for (const entry of this.entries.values()) {
      this.invalidate(entry);
      entry.visible = false;
    }
    this.reconcile();
  }
  stop() {
    this.stopped = true;
    this.pause(true);
  }
  snapshot(): RefreshState[] {
    return [...this.entries.values()].map((e) => ({
      ...e.state,
      origin: { ...e.origin },
    }));
  }
  private invalidate(entry: Entry) {
    entry.token = undefined;
    entry.controller?.abort();
    entry.handle?.cancel();
    entry.controller = undefined;
    entry.handle = undefined;
    entry.due = undefined;
    delete entry.state.nextAt;
    if (entry.state.status === "running") entry.state.status = "stale";
  }
  private reconcile() {
    const before = JSON.stringify(this.snapshot());
    const mono = this.deps.monotonic();
    for (const [source, lease] of this.leases)
      if (lease.expires <= mono) this.leases.delete(source);
    for (const entry of this.entries.values()) {
      const visible =
        entry.eligible &&
        [...this.leases.values()].some((l) => l.deckId === entry.origin.deckId);
      if (!visible && entry.visible) this.invalidate(entry);
      if (visible && !entry.visible)
        entry.due = Math.max(
          mono +
            (entry.definition.initial ? 0 : entry.definition.seconds * 1000),
          entry.cooldown,
        );
      entry.visible = visible;
      if (!entry.token)
        entry.state.status = entry.failures
          ? entry.state.lastSuccess === undefined
            ? "error"
            : "stale"
          : entry.definition.enabled
            ? "waiting"
            : "idle";
      entry.state.nextAt =
        visible && entry.due !== undefined
          ? Math.round(
              (this.deps.now() + Math.max(0, entry.due - mono)) / 1000,
            ) * 1000
          : undefined;
    }
    this.arm();
    if (JSON.stringify(this.snapshot()) !== before) this.deps.changed();
  }
  private arm() {
    if (
      this.stopped ||
      (!this.leases.size && ![...this.entries.values()].some((e) => e.token))
    ) {
      if (this.timer !== undefined) this.deps.clearTimer(this.timer);
      this.timer = undefined;
      return;
    }
    if (this.timer !== undefined) return;
    this.timer = this.deps.setTimer(() => this.tick(), 1000);
  }
  private tick() {
    this.timer = undefined;
    this.deps.heartbeat?.();
    this.reconcile();
    const now = this.deps.now(),
      mono = this.deps.monotonic();
    const jumped =
      Math.abs(now - this.wall - (mono - this.mono)) > 1500 ||
      mono - this.mono > 5000;
    this.wall = now;
    this.mono = mono;
    if (!this.available) return;
    const entries = [...this.entries.values()];
    let capacity =
      REFRESH_LIMITS.concurrency - entries.filter((e) => e.token).length;
    const start = this.cursor;
    for (let i = 0; i < entries.length; i++) {
      const index = (start + i) % entries.length,
        entry = entries[index];
      if (!entry.visible || entry.due === undefined) continue;
      if (jumped) {
        entry.due = Math.max(
          mono + entry.definition.seconds * 1000,
          entry.cooldown,
        );
        continue;
      }
      if (entry.due > mono) continue;
      if (entry.token) {
        entry.due = mono + entry.definition.seconds * 1000;
        continue;
      }
      if (capacity <= 0) continue; // Bounded fair admission; one waiting opportunity per binding.
      capacity--;
      this.cursor = (index + 1) % entries.length;
      entry.due = mono + entry.definition.seconds * 1000;
      entry.cooldown = mono + 60000;
      void this.start(entry);
    }
    this.reconcile();
  }
  private valid(entry: Entry, token: string) {
    return (
      !this.stopped &&
      entry.visible &&
      this.entries.get(originKey(entry.origin)) === entry &&
      entry.token === token
    );
  }
  private async start(entry: Entry) {
    const token = randomUUID(),
      controller = new AbortController();
    entry.token = token;
    entry.controller = controller;
    entry.state.status = "running";
    try {
      const handle = await this.deps.launch(
        entry.origin,
        entry.definition,
        entry.stamp,
        token,
        controller.signal,
      );
      if (!this.valid(entry, token)) {
        handle.cancel();
        return;
      }
      entry.handle = handle;
      const status = await handle.done;
      if (!this.valid(entry, token)) return;
      if (status === "success") {
        entry.failures = 0;
        entry.state.lastSuccess = this.deps.now();
      } else entry.failures = Math.min(7, entry.failures + 1);
    } catch {
      if (this.valid(entry, token))
        entry.failures = Math.min(7, entry.failures + 1);
    } finally {
      if (this.valid(entry, token)) {
        entry.token = undefined;
        entry.controller = undefined;
        entry.handle = undefined;
        if (entry.failures)
          entry.cooldown =
            this.deps.monotonic() +
            Math.min(3600000, 60000 * 2 ** (entry.failures - 1));
        entry.due = Math.max(
          entry.due ?? this.deps.monotonic() + entry.definition.seconds * 1000,
          entry.cooldown,
        );
        this.reconcile();
      }
    }
  }
}
