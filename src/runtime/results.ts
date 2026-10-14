import type { Json } from "../shared/schema";

export type InternalOutput =
  | { status: "available"; value: Json }
  | { status: "unavailable" | "oversized" | "invalid" };
export type ExecutionResult =
  | { status: "success"; output: InternalOutput }
  | { status: "failure" | "cancelled" | "timeout" };

/** Trusted consumers only. Never serialize this channel into history or IPC. */
export function boundedResult(value: unknown): InternalOutput {
  let bytes = 0,
    visits = 0;
  const copy = (v: unknown, depth: number): Json => {
    if (++visits > 4096 || depth > 16) throw new Error("oversized");
    if (v === null || typeof v === "boolean") {
      bytes += 5;
      return v;
    }
    if (typeof v === "number" && Number.isFinite(v)) {
      bytes += 24;
      return v;
    }
    if (typeof v === "string") {
      if (v.length > 65536) throw new Error("oversized");
      bytes += Buffer.byteLength(JSON.stringify(v));
      if (bytes > 65536) throw new Error("oversized");
      return v;
    }
    if (!v || typeof v !== "object") throw new Error("invalid");
    if (
      Object.getPrototypeOf(v) !== Object.prototype &&
      !Array.isArray(v) &&
      Object.getPrototypeOf(v) !== null
    )
      throw new Error("invalid");
    if (Array.isArray(v)) {
      if (v.length > 4096) throw new Error("oversized");
      return Array.from({ length: v.length }, (_, i) => {
        const descriptor = Object.getOwnPropertyDescriptor(v, String(i));
        if (!descriptor || !Object.hasOwn(descriptor, "value"))
          throw new Error("invalid");
        return copy(descriptor.value, depth + 1);
      });
    }
    return Object.fromEntries(
      Object.keys(v).map((key) => {
        const descriptor = Object.getOwnPropertyDescriptor(v, key)!;
        if (
          !Object.hasOwn(descriptor, "value") ||
          ["__proto__", "constructor", "prototype"].includes(key)
        )
          throw new Error("invalid");
        bytes += Buffer.byteLength(JSON.stringify(key)) + 2;
        if (bytes > 65536) throw new Error("oversized");
        return [key, copy(descriptor.value, depth + 1)];
      }),
    );
  };
  if (value === undefined) return { status: "unavailable" };
  try {
    const result = copy(value, 0);
    if (Buffer.byteLength(JSON.stringify(result)) > 65536)
      return { status: "oversized" };
    return { status: "available", value: result };
  } catch (error) {
    return {
      status:
        error instanceof Error && error.message === "oversized"
          ? "oversized"
          : "invalid",
    };
  }
}
