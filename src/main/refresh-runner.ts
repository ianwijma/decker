import type { ButtonOrigin, TrustedLaunch } from "../shared/trigger-context";
import type { ScheduledHandle } from "./scheduler";
type Status = "success" | "failure" | "cancelled";
/** Private transport, independent of batched history. Cancel ends authority synchronously. */
export class RefreshRunner {
  private pending = new Map<
    string,
    {
      accept(h: ScheduledHandle): void;
      reject(e: Error): void;
      settle(s: Status): void;
      done: Promise<Status>;
      cancel(): void;
      acceptedRun?(id: string): void;
      timer: ReturnType<typeof setTimeout>;
      cleanup(): void;
    }
  >();
  constructor(
    private post: (message: unknown) => void,
    private source: (origin: ButtonOrigin) => TrustedLaunch,
    private invalidate: (launch: TrustedLaunch, runId?: string) => void,
  ) {}
  launch(
    origin: ButtonOrigin,
    stamp: string,
    token: string,
    signal: AbortSignal,
    configuration: string,
  ): Promise<ScheduledHandle> {
    if (signal.aborted || this.pending.size >= 4)
      return Promise.reject(new Error("Refresh unavailable"));
    const launch = this.source(origin);
    return new Promise((accept, reject) => {
      let settle!: (s: Status) => void;
      const done = new Promise<Status>((resolve) => {
        settle = resolve;
      });
      const cancel = () => {
        const pending = this.pending.get(token);
        if (!pending) return;
        this.pending.delete(token);
        pending.cleanup();
        try {
          this.post({ type: "refreshCancel", token });
        } catch {
          /* worker exited */
        }
        reject(new Error("Refresh cancelled"));
        settle("cancelled");
      };
      const timer = setTimeout(cancel, 10000);
      const cleanup = () => {
        clearTimeout(timer);
        signal.removeEventListener("abort", cancel);
      };
      let runId: string | undefined;
      this.pending.set(token, {
        accept,
        reject,
        settle,
        done,
        cancel,
        timer,
        acceptedRun: (id) => {
          runId = id;
        },
        cleanup: () => {
          cleanup();
          this.invalidate(launch, runId);
        },
      });
      signal.addEventListener("abort", cancel, { once: true });
      try {
        this.post({
          type: "refreshRun",
          token,
          origin,
          stamp,
          configuration,
          launch,
        });
      } catch {
        cancel();
      }
    });
  }
  message(message: {
    type: string;
    token: string;
    accepted?: boolean;
    status?: Status;
    runId?: string;
  }) {
    const p = this.pending.get(message.token);
    if (!p) {
      if (message.type === "refreshAccepted" && message.accepted)
        this.post({ type: "refreshCancel", token: message.token });
      return;
    }
    if (message.type === "refreshAccepted" && message.accepted) {
      if (message.runId) p.acceptedRun?.(message.runId);
      clearTimeout(p.timer);
      p.accept({ done: p.done, cancel: p.cancel });
    } else {
      this.pending.delete(message.token);
      p.cleanup();
      if (message.type === "refreshAccepted")
        p.reject(new Error("Refresh rejected"));
      p.settle(message.status ?? "failure");
    }
  }
  stop() {
    for (const p of [...this.pending.values()]) p.cancel();
  }
}
