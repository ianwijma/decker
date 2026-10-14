import { z } from "zod";
import type { Json } from "./schema";
import {
  boundedJson,
  ownPath,
  parsePath,
  type DataPath,
} from "./data-contract";
export const jsonDataSchema = z.unknown().transform((value, ctx) => {
  try {
    return boundedJson(value);
  } catch (error) {
    ctx.addIssue({
      code: "custom",
      message: error instanceof Error ? error.message : "Invalid JSON data",
    });
    return z.NEVER;
  }
});
export const pathSchema = z
  .union([z.string(), z.array(z.union([z.string(), z.number()]))])
  .superRefine((value, ctx) => {
    try {
      parsePath(value);
    } catch (error) {
      ctx.addIssue({ code: "custom", message: (error as Error).message });
    }
  });
export const httpOutputSchema = z.object({
  status: z.number().int(),
  body: z.string(),
  truncated: z.boolean(),
});
export const parseJsonSchema = z.object({
  input: z.union([z.string().max(1_000_000), httpOutputSchema]),
});
export const extractValueSchema = z.object({
  input: jsonDataSchema,
  path: pathSchema,
  fallback: jsonDataSchema.optional(),
});
export const valueOutputSchema = z.object({ value: jsonDataSchema });
export function parseJson(input: unknown): { value: Json } {
  const { input: source } = parseJsonSchema.parse({
    input: boundedJson(input),
  });
  if (typeof source !== "string" && source.truncated)
    throw new Error(
      "Cannot parse truncated HTTP response; fetch a smaller response or paginate it",
    );
  const text = typeof source === "string" ? source : source.body;
  if (text.length > 1_000_000)
    throw new Error("JSON text exceeds 1000000 characters");
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    // Do not echo potentially secret response text or unbounded parser messages.
    throw new Error(
      "Invalid JSON: expected complete JSON text (use the HTTP envelope to detect truncation)",
    );
  }
  return { value: boundedJson(value) };
}
export function extractValue(config: Record<string, Json>): { value: Json } {
  const input = boundedJson(config.input);
  const value = ownPath(input, config.path as DataPath);
  if (value !== undefined) return { value: boundedJson(value) };
  if (Object.hasOwn(config, "fallback"))
    return { value: boundedJson(config.fallback) };
  throw new Error(
    "Extract value: path is missing; choose an existing path or supply fallback",
  );
}
