import type { Schedule } from "../shared/schedules";
import type { TrustedLaunch } from "../shared/trigger-context";
import type { ScheduledHandle } from "./scheduler";
type Status = "success" | "failure" | "cancelled";
type Pending = {
  accept(handle: ScheduledHandle): void;
  reject(error: Error): void;
  settle(status: Status): void;
  timer: ReturnType<typeof setTimeout>;
  cleanup(): void;
  done: Promise<Status>;
};
/** Acceptance/settlement is independent of history batching and eviction. */
export class ScheduledRunner {
  private pending = new Map<string, Pending>();
  constructor(
    private post: (message: unknown) => void,
    private launchSource: (schedule: Schedule) => TrustedLaunch,
  ) {}
  launch(
    schedule: Schedule,
    token: string,
    signal: AbortSignal,
    configuration: string,
  ): Promise<ScheduledHandle> {
    if (signal.aborted || this.pending.size >= 64)
      return Promise.reject(new Error("Schedule launch unavailable"));
    return new Promise((accept, reject) => {
      let settle!: (status: Status) => void;
      const done = new Promise<Status>((resolve) => {
        settle = resolve;
      });
      const cancel = () => {
        const pending = this.pending.get(token);
        if (!pending) return;
        this.pending.delete(token);
        pending.cleanup();
        try {
          this.post({ type: "scheduleCancel", token });
        } catch {
          /* exited */
        }
        reject(new Error("Schedule cancelled"));
        settle("cancelled");
      };
      const timer = setTimeout(cancel, 10000);
      const cleanup = () => {
        clearTimeout(timer);
        signal.removeEventListener("abort", cancel);
      };
      this.pending.set(token, { accept, reject, settle, timer, cleanup, done });
      signal.addEventListener("abort", cancel, { once: true });
      try {
        this.post({
          type: "scheduleRun",
          token,
          configuration,
          scheduleId: schedule.id,
          launch: this.launchSource(schedule),
        });
      } catch (error) {
        cancel();
        reject(error);
      }
    });
  }
  message(message: {
    type: string;
    token: string;
    status?: Status;
    accepted?: boolean;
  }) {
    const pending = this.pending.get(message.token);
    if (!pending) {
      if (message.type === "scheduleAccepted" && message.accepted)
        this.post({ type: "scheduleCancel", token: message.token });
      return;
    }
    if (message.type === "scheduleAccepted" && message.accepted) {
      clearTimeout(pending.timer);
      pending.accept({
        done: pending.done,
        cancel: () => {
          if (!this.pending.has(message.token)) return;
          this.pending.delete(message.token);
          pending.cleanup();
          try {
            this.post({ type: "scheduleCancel", token: message.token });
          } catch {
            /* exited */
          }
          pending.settle("cancelled");
        },
      });
    } else {
      this.pending.delete(message.token);
      pending.cleanup();
      if (message.type === "scheduleAccepted")
        pending.reject(new Error("Schedule launch rejected"));
      pending.settle(message.status ?? "failure");
    }
  }
  stop() {
    for (const pending of this.pending.values()) {
      pending.cleanup();
      pending.reject(new Error("Runner unavailable"));
      pending.settle("cancelled");
    }
    this.pending.clear();
  }
}
