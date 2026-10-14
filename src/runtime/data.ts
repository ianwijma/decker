import type { Json } from "../shared/schema";
export type Scope = {
  inputs: Record<string, Json>;
  outputs: Record<string, Json>;
  vars: Record<string, Json>;
  item?: Json;
  index?: number;
  error?: Json;
};
export { ownPath as readPath } from "../shared/data-contract";
import {
  boundedJson,
  DataBudget,
  expression,
  inspectExpressions,
  ownPath,
} from "../shared/data-contract";
export function resolve(value: Json, scope: Scope): Json {
  inspectExpressions(value);
  const budget = new DataBudget();
  const visit = (v: Json, depth: number): Json => {
    budget.count(depth, typeof v === "string" ? v.length : 1);
    const e = expression(v);
    if (e) {
      const object = v as Record<string, Json>;
      if (e.kind === "literal") return budget.copy(object.$literal, depth);
      if (e.kind === "template") {
        const text = (object.$template as Json[])
          .map((segment) => {
            const result = visit(segment, depth + 1);
            return typeof result === "string" ? result : JSON.stringify(result);
          })
          .join("");
        budget.count(depth, text.length);
        return text;
      }
      let result = ownPath(scope, e.path);
      if (result === undefined) {
        if (Object.hasOwn(object, "fallback"))
          result = visit(object.fallback, depth + 1);
        else throw new Error(`Missing data: ${JSON.stringify(e.path)}`);
      }
      result = budget.copy(result, depth);
      switch (object.transform) {
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
          return result;
      }
    }
    if (Array.isArray(v)) return v.map((x) => visit(x, depth + 1));
    if (v && typeof v === "object")
      return Object.fromEntries(
        Object.entries(v).map(([key, x]) => [key, visit(x, depth + 1)]),
      );
    return v;
  };
  return boundedJson(visit(value, 0));
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
