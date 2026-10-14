import type { Json } from "../shared/schema";
export type Scope = {
  inputs: Record<string, Json>;
  outputs: Record<string, Json>;
  vars: Record<string, Json>;
  item?: Json;
  index?: number;
  error?: Json;
};
const forbidden = new Set(["__proto__", "prototype", "constructor"]);
export function readPath(scope: unknown, path: string): Json | undefined {
  let current: unknown = scope;
  for (const part of path.split(".")) {
    if (
      forbidden.has(part) ||
      current === null ||
      typeof current !== "object" ||
      !Object.hasOwn(current, part)
    )
      return undefined;
    current = (current as Record<string, unknown>)[part];
  }
  return current as Json | undefined;
}
export function resolve(value: Json, scope: Scope): Json {
  if (Array.isArray(value)) return value.map((v) => resolve(v, scope));
  if (value && typeof value === "object") {
    if (typeof value.$ref === "string") {
      let result = readPath(scope, value.$ref);
      if (result === undefined) {
        if (Object.hasOwn(value, "fallback"))
          result = resolve(value.fallback, scope);
        else throw new Error(`Missing data: ${value.$ref}`);
      }
      switch (value.transform) {
        case "string":
          return typeof result === "string" ? result : JSON.stringify(result);
        case "number": {
          const n = Number(result);
          if (!Number.isFinite(n))
            throw new Error("Cannot convert data to a number");
          return n;
        }
        case "lowercase":
          return String(result).toLowerCase();
        case "uppercase":
          return String(result).toUpperCase();
        case "length":
          return typeof result === "string" || Array.isArray(result)
            ? result.length
            : 0;
        default:
          return structuredClone(result);
      }
    }
    return Object.fromEntries(
      Object.entries(value).map(([k, v]) => [k, resolve(v, scope)]),
    );
  }
  return value;
}
export function redact(value: unknown, secrets: string[] = []): Json {
  let budget = 16000,
    visits = 0;
  const visit = (v: unknown, depth: number): Json => {
    if (budget <= 0 || ++visits > 512) return "[size limited]";
    if (depth > 6) return "[depth limited]";
    if (typeof v === "string") {
      let text = v;
      for (const secret of secrets.filter(Boolean))
        text = text.split(secret).join("[redacted]");
      const result = text.slice(0, Math.min(4096, budget));
      budget -= result.length;
      return result;
    }
    if (v === null || typeof v === "boolean" || typeof v === "number")
      return v as Json;
    if (Array.isArray(v)) return v.slice(0, 32).map((x) => visit(x, depth + 1));
    if (v && typeof v === "object")
      return Object.fromEntries(
        Object.entries(v)
          .slice(0, 50)
          .map(([k, x]) => [
            k.slice(0, 160),
            /authorization|cookie|password|token|secret|credential|api.?key/i.test(
              k,
            )
              ? "[redacted]"
              : visit(x, depth + 1),
          ]),
      );
    return String(v);
  };
  return visit(value, 0);
}
export function checkCondition(config: Record<string, Json>): boolean {
  const { left, right, operator = "equals" } = config;
  switch (operator) {
    case "equals":
      return JSON.stringify(left) === JSON.stringify(right);
    case "notEquals":
      return JSON.stringify(left) !== JSON.stringify(right);
    case "greater":
      return Number(left) > Number(right);
    case "less":
      return Number(left) < Number(right);
    case "contains":
      return typeof left === "string"
        ? left.includes(String(right))
        : Array.isArray(left) &&
            left.some((v) => JSON.stringify(v) === JSON.stringify(right));
    case "truthy":
      return Boolean(left);
    default:
      throw new Error(`Unknown condition operator: ${operator}`);
  }
}
