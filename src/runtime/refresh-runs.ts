import type { Engine, RunHandle } from "./engine";
import type { AppDocument } from "../shared/schema";
import {
  originBinding,
  originKey,
  type ButtonOrigin,
  type TrustedLaunch,
} from "../shared/trigger-context";
import { refreshError } from "../shared/refresh";
import { refreshStamp } from "./refresh-definition";
/** Saved definitions only; never routes through press policies or toggle transitions. */
export class RefreshRuns {
  private handles = new Map<
    string,
    { handle: RunHandle; origin: ButtonOrigin; stamp: string }
  >();
  constructor(
    private engine: Engine,
    private send: (message: unknown) => void,
  ) {}
  start(
    document: AppDocument,
    origin: ButtonOrigin,
    stamp: string,
    token: string,
    launch: TrustedLaunch,
    ready: boolean,
  ) {
    try {
      const b = originBinding(document, origin),
        r = b?.refresh;
      const deck = document.decks.find((d) => d.id === origin.deckId);
      if (
        !ready ||
        !r?.enabled ||
        refreshError(r, document) ||
        refreshStamp(document, origin) !== stamp ||
        deck?.activePageId !== origin.pageId ||
        deck.activeProfileId !== origin.profileId ||
        this.engine.activeCount >= 64 ||
        this.handles.size >= 4 ||
        this.handles.has(token) ||
        [...this.handles.values()].some(
          (h) => originKey(h.origin) === originKey(origin),
        ) ||
        launch.source.kind !== "refresh" ||
        !launch.authority ||
        JSON.stringify(launch.source.origin) !== JSON.stringify(origin)
      )
        throw new Error("Invalid refresh");
      const workflow = document.workflows.find((f) => f.id === r.workflowId)!;
      const handle = this.engine.start(workflow, document.workflows, r.inputs, {
        deckId: origin.deckId,
        bindingId: origin.bindingId,
        generation: origin.generation,
        launch,
      });
      this.handles.set(token, { handle, origin, stamp });
      this.send({
        type: "refreshAccepted",
        token,
        accepted: true,
        runId: handle.record.id,
      });
      void handle.done.then((record) => {
        this.handles.delete(token);
        this.send({
          type: "refreshSettled",
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
      this.send({ type: "refreshAccepted", token, accepted: false });
    }
  }
  configure(document: AppDocument) {
    for (const { handle, origin, stamp } of this.handles.values()) {
      const deck = document.decks.find((d) => d.id === origin.deckId);
      if (
        refreshStamp(document, origin) !== stamp ||
        deck?.activePageId !== origin.pageId ||
        deck.activeProfileId !== origin.profileId
      )
        handle.cancel();
    }
  }
  cancel(token: string) {
    this.handles.get(token)?.handle.cancel();
  }
  stop() {
    for (const { handle } of this.handles.values()) handle.cancel();
  }
}
