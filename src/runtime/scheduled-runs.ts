import type { Engine, RunHandle } from "./engine";
import type { AppDocument } from "../shared/schema";
import type { TrustedLaunch } from "../shared/trigger-context";
import { scheduleError } from "../shared/schedules";
export class ScheduledRuns {
  private handles = new Map<string, RunHandle>();
  private activeSchedules = new Set<string>();
  constructor(
    private engine: Engine,
    private send: (message: unknown) => void,
  ) {}
  start(
    document: AppDocument,
    scheduleId: string,
    token: string,
    launch: TrustedLaunch,
    ready: boolean,
  ) {
    try {
      const schedule = document.schedules.find((s) => s.id === scheduleId);
      if (
        this.engine.activeCount >= 64 ||
        this.activeSchedules.has(scheduleId) ||
        !ready ||
        !schedule?.enabled ||
        scheduleError(schedule, document) ||
        this.handles.has(token) ||
        launch.authority ||
        launch.source.kind !== "scheduled" ||
        launch.source.origin ||
        launch.source.schedule?.id !== schedule.id ||
        launch.source.schedule.name !== schedule.name
      )
        throw new Error("Invalid scheduled launch");
      const workflow = document.workflows.find(
        (f) => f.id === schedule.workflowId,
      )!;
      const handle = this.engine.start(
        workflow,
        document.workflows,
        schedule.inputs,
        { launch },
      );
      this.handles.set(token, handle);
      this.activeSchedules.add(scheduleId);
      this.send({ type: "scheduleAccepted", token, accepted: true });
      void handle.done.then((record) => {
        this.handles.delete(token);
        this.activeSchedules.delete(scheduleId);
        this.send({
          type: "scheduleSettled",
          token,
          status:
            record.status === "success"
              ? "success"
              : record.status === "cancelled"
                ? "cancelled"
                : "failure",
        });
      });
    } catch {
      this.send({ type: "scheduleAccepted", token, accepted: false });
    }
  }
  cancel(token: string) {
    this.handles.get(token)?.cancel();
  }
  stop() {
    for (const handle of this.handles.values()) handle.cancel();
  }
}
