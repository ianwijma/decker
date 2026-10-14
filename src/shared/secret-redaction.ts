import type { Json } from "./schema";
export function lookupSecret(
  values: Record<string, string>,
  ref: string,
): string | undefined {
  return Object.hasOwn(values, ref) && typeof values[ref] === "string"
    ? values[ref]
    : undefined;
}

// Preserve HTTP response shape/limits; redact before values can enter expressions,
// traces or exceptions. This is separate from bounded diagnostic formatting.
export async function protectSecret(
  secret: string | undefined,
  operation: () => Promise<Json>,
): Promise<Json> {
  const mask = (text: string) =>
    secret ? text.split(secret).join("[redacted]") : text;
  const visit = (value: Json): Json =>
    typeof value === "string"
      ? mask(value)
      : Array.isArray(value)
        ? value.map(visit)
        : value && typeof value === "object"
          ? Object.fromEntries(
              Object.entries(value).map(([k, v]) => [mask(k), visit(v)]),
            )
          : value;
  try {
    return visit(await operation());
  } catch (error) {
    if (!secret) throw error;
    // Keep the original error class/name (notably AbortError) and never its cause.
    const safe = new Error(
      mask(error instanceof Error ? error.message : String(error)),
    );
    safe.name = error instanceof Error ? error.name : "Error";
    throw safe;
  }
}
