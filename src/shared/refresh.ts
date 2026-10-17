import { z } from "zod";
import { scheduleInputsSchema, scheduleError } from "./schedules";
import type { AppDocument } from "./schema";
import type { ButtonOrigin } from "./trigger-context";
export const MAX_REFRESH_BINDINGS = 64;
export const refreshSchema = z
  .object({
    id: z.uuid(),
    workflowId: z.uuid(),
    inputs: scheduleInputsSchema.default({}),
    seconds: z.number().int().min(60).max(86400).default(60),
    initial: z.boolean().default(true),
    enabled: z.boolean().default(false),
  })
  .strict();
export type Refresh = z.infer<typeof refreshSchema>;
export type RefreshState = {
  origin: ButtonOrigin;
  status: "idle" | "waiting" | "running" | "stale" | "error";
  lastSuccess?: number;
  nextAt?: number;
};
export function refreshError(refresh: Refresh, document: AppDocument) {
  return scheduleError(
    {
      ...refresh,
      name: "Refresh",
      timing: { kind: "interval", seconds: refresh.seconds },
    },
    document,
  );
}
export function preserveRefreshActivation(
  current: AppDocument,
  next: AppDocument,
) {
  const old = new Map(
    current.profiles.flatMap((p) =>
      p.pages.flatMap((page) =>
        Object.values(page.keys).map((b) => [b.id, b.refresh] as const),
      ),
    ),
  );
  for (const p of next.profiles)
    for (const page of p.pages)
      for (const b of Object.values(page.keys)) {
        if (!b.refresh) continue;
        const previous = old.get(b.id);
        // Definition changes require a deliberate enable of the exact committed configuration.
        b.refresh.enabled = Boolean(
          previous?.enabled &&
          JSON.stringify({ ...previous, enabled: false }) ===
            JSON.stringify({ ...b.refresh, enabled: false }) &&
          !refreshError(b.refresh, next),
        );
      }
}
