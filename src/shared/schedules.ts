import { validateWorkflow } from "../runtime/validate";
import { z } from "zod";
import { CronExpressionParser } from "cron-parser";
import { DateTime, IANAZone } from "luxon";
import type { AppDocument, Json } from "./schema";

export const CURRENT_SCHEMA_VERSION = 6;
export const MAX_SCHEDULES = 200;
export const timezoneSchema = z
  .string()
  .min(1)
  .max(100)
  .refine(
    (zone) =>
      /^[A-Za-z_]+(?:\/[A-Za-z0-9_+.\-]+)*$/.test(zone) &&
      IANAZone.isValidZone(zone),
    "Use an IANA timezone, for example Australia/Sydney",
  );
export function parseCron(expression: string) {
  if (
    expression.length > 120 ||
    expression.trim().split(/\s+/).length !== 5 ||
    !/^[\d*,/\-\s]+$/.test(expression)
  )
    throw new Error(
      "Use five numeric cron fields: minute hour day month weekday",
    );
  // Fixed zero seconds. Standard numeric cron with DOM/DOW OR semantics.
  return CronExpressionParser.parse(`0 ${expression.trim()}`, {
    tz: "UTC",
    currentDate: 0,
  });
}
const cron = z
  .string()
  .min(1)
  .max(120)
  .superRefine((value, ctx) => {
    try {
      parseCron(value);
    } catch {
      ctx.addIssue({
        code: "custom",
        message: "Invalid five-field cron expression",
      });
    }
  });
export const scheduleInputsSchema = z
  .record(z.string().min(1).max(100), z.unknown())
  .superRefine((value, ctx) => {
    let visits = 0;
    const valid = (v: unknown, depth = 0): boolean => {
      if (++visits > 2048 || depth > 12) return false;
      if (v === null || typeof v === "boolean") return true;
      if (typeof v === "number") return Number.isFinite(v);
      if (typeof v === "string") return v.length <= 8192;
      if (Array.isArray(v))
        return Array.from(v).every((x) => valid(x, depth + 1));
      return (
        typeof v === "object" &&
        v !== null &&
        (Object.getPrototypeOf(v) === Object.prototype ||
          Object.getPrototypeOf(v) === null) &&
        Object.getOwnPropertySymbols(v).length === 0 &&
        Object.entries(v).every(
          ([k, x]) =>
            k.length <= 100 &&
            !["__proto__", "prototype", "constructor"].includes(k) &&
            valid(x, depth + 1),
        )
      );
    };
    if (!valid(value) || JSON.stringify(value).length > 16384)
      ctx.addIssue({
        code: "custom",
        message:
          "Inputs must be ordinary JSON within 16 KB, depth 12 and 2048 values",
      });
  })
  .transform((value) => value as Record<string, Json>);
export const scheduleSchema = z
  .object({
    id: z.uuid(),
    name: z.string().trim().min(1).max(80),
    workflowId: z.uuid(),
    enabled: z.boolean().default(false),
    inputs: scheduleInputsSchema.default({}),
    timing: z.discriminatedUnion("kind", [
      z
        .object({
          kind: z.literal("interval"),
          seconds: z.number().int().min(60).max(31536000),
        })
        .strict(),
      z
        .object({
          kind: z.literal("cron"),
          expression: cron,
          timezone: timezoneSchema,
        })
        .strict(),
    ]),
  })
  .strict();
export type Schedule = z.infer<typeof scheduleSchema>;
export type ScheduleState = {
  id: string;
  busy: boolean;
  nextAt?: number;
  skipped: number;
  lastAt?: number;
  lastStatus?: "running" | "success" | "failure" | "cancelled" | "interrupted";
  error?: string;
};
export function scheduleError(
  schedule: Schedule,
  document: AppDocument,
): string | undefined {
  const flow = document.workflows.find((f) => f.id === schedule.workflowId);
  if (!flow) return "Workflow is missing; choose an existing workflow";
  if (
    validateWorkflow(flow, document.workflows, document.workflowAliases).length
  )
    return "Workflow is invalid; fix its flow validation errors before enabling";
  const missing = flow.inputs.filter(
    (key) => !Object.hasOwn(schedule.inputs, key),
  );
  if (missing.length)
    return `Required inputs missing: ${missing.join(", ").slice(0, 160)}`;
  if (Object.keys(schedule.inputs).some((key) => !flow.inputs.includes(key)))
    return "Inputs must match the workflow's declared inputs";
}
/** Enumerate authored local times with the maintained parser, then resolve each
 * using Luxon. Reject normalized gap times; choose only the earliest overlap instant.
 * This also excludes second occurrences when starting/resuming inside an overlap. */
export function nextOccurrence(
  timing: Schedule["timing"],
  after: number,
): number {
  if (!Number.isFinite(after) || Math.abs(after) > 8e15)
    throw new Error("Invalid occurrence date");
  if (timing.kind === "interval") return after + timing.seconds * 1000;
  timezoneSchema.parse(timing.timezone);
  const local = DateTime.fromMillis(after, { zone: timing.timezone });
  const iterator = parseCron(timing.expression);
  iterator.reset(
    new Date(local.setZone("UTC", { keepLocalTime: true }).toMillis()),
  );
  for (let i = 0; i < 512; i++) {
    const wall = DateTime.fromJSDate(iterator.next().toDate(), { zone: "UTC" });
    const parts = {
      year: wall.year,
      month: wall.month,
      day: wall.day,
      hour: wall.hour,
      minute: wall.minute,
      second: 0,
    };
    const resolved = DateTime.fromObject(parts, { zone: timing.timezone });
    if (
      Object.entries(parts).some(
        ([key, value]) => resolved.get(key as keyof typeof parts) !== value,
      )
    )
      continue;
    const first = Math.min(
      ...resolved.getPossibleOffsets().map((d) => d.toMillis()),
    );
    if (first > after) return first;
  }
  throw new Error("No future occurrence within the scheduling search bound");
}
export function previewSchedule(schedule: Schedule, after: number, count = 3) {
  if (
    !Number.isInteger(count) ||
    count < 1 ||
    count > 5 ||
    !Number.isFinite(after)
  )
    throw new Error("Invalid preview bounds");
  const results: { at: number; label: string }[] = [];
  for (let i = 0; i < count; i++) {
    after = nextOccurrence(schedule.timing, after);
    const zone =
      schedule.timing.kind === "cron" ? schedule.timing.timezone : "UTC";
    results.push({
      at: after,
      label: `${DateTime.fromMillis(after, { zone }).toFormat("yyyy-MM-dd HH:mm:ss ZZ")} · ${zone}`,
    });
  }
  return results;
}
/** Renderer saves never authorize activation or resurrect a disabled definition. */
export function preserveScheduleActivation(
  current: AppDocument,
  next: AppDocument,
) {
  for (const schedule of next.schedules) {
    const old = current.schedules.find((s) => s.id === schedule.id);
    schedule.enabled = Boolean(old?.enabled && !scheduleError(schedule, next));
  }
}
