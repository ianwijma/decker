/** Per-originating-worker request identity. Invalidations never wait for storage. */
export class MainRpc {
  private requests = new Map<
    string,
    {
      worker: object;
      runId: string;
      actionId: string;
      controller: AbortController;
    }
  >();
  begin(worker: object, id: string, runId: string, actionId: string) {
    if (
      !id ||
      !runId ||
      !actionId ||
      this.requests.has(id) ||
      this.requests.size >= 256
    )
      throw new Error("Main action request unavailable");
    const controller = new AbortController();
    this.requests.set(id, { worker, runId, actionId, controller });
    return controller.signal;
  }
  cancel(worker: object, id: string, runId: string, actionId: string) {
    const r = this.requests.get(id);
    if (r?.worker === worker && r.runId === runId && r.actionId === actionId)
      r.controller.abort();
  }
  finish(worker: object, id: string) {
    if (this.requests.get(id)?.worker === worker) this.requests.delete(id);
  }
  invalidate(worker?: object, runId?: string) {
    for (const r of this.requests.values())
      if ((!worker || r.worker === worker) && (!runId || r.runId === runId))
        r.controller.abort();
  }
}
