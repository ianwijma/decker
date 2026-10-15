import type { AppDocument } from "./schema";

/** Conservative authored pins include nested graph/target/literal asset fields.
 * Only document configuration is visited; runtime caches/history are excluded. */
export function authoredAssetReferences(document: AppDocument): Set<string> {
  const result = new Set<string>();
  const literal = (value: unknown) => {
    if (typeof value === "string" && /^[a-f0-9]{64}$/.test(value))
      result.add(value);
    else if (value && typeof value === "object") {
      if ("$ref" in value) {
        if ("fallback" in value) literal(value.fallback);
      } else for (const child of Object.values(value)) literal(child);
    }
  };
  const visit = (value: unknown) => {
    if (!value || typeof value !== "object") return;
    for (const [key, child] of Object.entries(value)) {
      if (key === "asset") {
        literal(child);
      }
      visit(child);
    }
  };
  visit(document);
  return result;
}
