import type { Json } from "./schema";

// Stay within the runtime's 1 MB node output / 4 MB scope limits.
export const DATA_LIMITS = {
  depth: 32,
  visits: 10000,
  size: 1_000_000,
  path: 64,
};
export type DataPath = string | (string | number)[];
const forbidden = new Set(["__proto__", "prototype", "constructor"]);
export function parsePath(path: unknown): string[] {
  if (typeof path === "string" && path.length > 4096)
    throw new Error("Data path exceeds 4096 characters");
  const parts = typeof path === "string" ? path.split(".") : path;
  if (!Array.isArray(parts) || !parts.length || parts.length > DATA_LIMITS.path)
    throw new Error("Use a dot path or 1–64 path segments");
  return Array.from({ length: parts.length }, (_, index) => {
    const descriptor = Object.getOwnPropertyDescriptor(parts, String(index));
    if (!descriptor || !("value" in descriptor))
      throw new Error("Data path getters and holes are not allowed");
    const part: unknown = descriptor.value;
    if (
      typeof part !== "string" &&
      !(typeof part === "number" && Number.isSafeInteger(part) && part >= 0)
    )
      throw new Error(
        "Path segments must be strings or non-negative integer indexes",
      );
    const key = String(part);
    if (key.length > 4096 || forbidden.has(key))
      throw new Error("Unsafe data path");
    return key;
  });
}
export function ownPath(value: unknown, path: DataPath): Json | undefined {
  let current = value;
  for (const key of parsePath(path)) {
    if (current === null || typeof current !== "object") return undefined;
    const descriptor = Object.getOwnPropertyDescriptor(current, key);
    if (!descriptor) return undefined;
    if (!("value" in descriptor))
      throw new Error("Data property getters are not allowed");
    current = descriptor.value;
  }
  return current as Json | undefined;
}
export class DataBudget {
  private visits = 0;
  private size = 0;
  count(depth: number, size = 1) {
    this.size += size;
    if (
      depth > DATA_LIMITS.depth ||
      ++this.visits > DATA_LIMITS.visits ||
      this.size > DATA_LIMITS.size
    )
      throw new Error(
        "Data exceeds limits (depth 32, 10000 steps, 1000000 characters)",
      );
  }
  copy(value: unknown, depth = 0): Json {
    this.count(depth, typeof value === "string" ? value.length + 2 : 8);
    if (
      value === null ||
      typeof value === "string" ||
      typeof value === "boolean"
    )
      return value;
    if (typeof value === "number" && Number.isFinite(value)) return value;
    if (!value || typeof value !== "object")
      throw new Error("Use JSON data values only");
    if (Array.isArray(value)) {
      if (value.length > DATA_LIMITS.visits)
        throw new Error("Data exceeds value limit");
      return Array.from({ length: value.length }, (_, i) => {
        const d = Object.getOwnPropertyDescriptor(value, String(i));
        if (!d || !("value" in d))
          throw new Error("Use JSON arrays without getters or holes");
        return this.copy(d.value, depth + 1);
      });
    }
    const entries = Object.keys(value);
    if (entries.length > DATA_LIMITS.visits)
      throw new Error("Data exceeds value limit");
    return Object.fromEntries(
      entries.map((key) => {
        if (forbidden.has(key)) throw new Error("Unsafe data property name");
        this.count(depth, key.length + 3);
        const d = Object.getOwnPropertyDescriptor(value, key)!;
        if (!("value" in d))
          throw new Error("Data property getters are not allowed");
        return [key, this.copy(d.value, depth + 1)];
      }),
    );
  }
}
export const boundedJson = (value: unknown): Json =>
  new DataBudget().copy(value);
export const transforms = [
  "string",
  "number",
  "lowercase",
  "uppercase",
  "length",
];
export type Expression =
  { kind: "ref"; path: DataPath } | { kind: "template" } | { kind: "literal" };
export function expression(value: Json): Expression | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return;
  const keys = Object.keys(value);
  const reserved = ["$ref", "$template", "$literal"].filter((key) =>
    Object.hasOwn(value, key),
  );
  if (!reserved.length) return;
  if (reserved.length !== 1)
    throw new Error("Malformed data expression: use one reserved key");
  const key = reserved[0];
  const allowed = key === "$ref" ? [key, "fallback", "transform"] : [key];
  if (keys.some((k) => !allowed.includes(k)))
    throw new Error("Malformed data expression: unexpected keys");
  if (key === "$literal") return { kind: "literal" };
  if (key === "$template") {
    if (!Array.isArray(value.$template) || value.$template.length > 256)
      throw new Error("Template must contain at most 256 segments");
    return { kind: "template" };
  }
  parsePath(value.$ref);
  if (
    Object.hasOwn(value, "transform") &&
    (typeof value.transform !== "string" ||
      !transforms.includes(value.transform))
  )
    throw new Error("Unsupported data transform");
  return { kind: "ref", path: value.$ref as DataPath };
}
/** One grammar for runtime and validation, including nested fallbacks. */
export function inspectExpressions(
  value: Json,
  onRef: (path: string[], hasFallback: boolean) => void = () => {},
): boolean {
  boundedJson(value);
  let found = false;
  const visit = (v: Json) => {
    const e = expression(v);
    if (e) found = true;
    if (e?.kind === "literal") return;
    if (e?.kind === "ref") {
      const object = v as Record<string, Json>;
      onRef(parsePath(e.path), Object.hasOwn(object, "fallback"));
      if (Object.hasOwn(object, "fallback")) visit(object.fallback);
    } else if (Array.isArray(v)) v.forEach(visit);
    else if (v && typeof v === "object") Object.values(v).forEach(visit);
  };
  visit(value);
  return found;
}
export function decodeArgs(value: unknown): string[] {
  let args = value;
  if (typeof args === "string") {
    try {
      args = JSON.parse(args);
    } catch {
      throw new Error(
        "Arguments must be a JSON array of strings (maximum 256)",
      );
    }
  }
  if (
    !Array.isArray(args) ||
    args.length > 256 ||
    !args.every((a) => typeof a === "string")
  )
    throw new Error("Arguments must be a JSON array of strings (maximum 256)");
  return args;
}
