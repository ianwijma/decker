import { z } from "zod";

export const displayFields = ["label", "background", "icon", "asset"] as const;
export const displayPatchSchema = z
  .object({
    label: z.string().max(80).optional(),
    background: z
      .string()
      .regex(/^#[a-fA-F0-9]{6}$/)
      .optional(),
    icon: z.string().max(100).optional(),
    asset: z
      .string()
      .regex(/^[a-f0-9]{64}$/)
      .nullable()
      .optional(),
  })
  .strict();
export const displayUpdateSchema = displayPatchSchema
  .extend({
    reset: z.array(z.enum(displayFields)).max(4).optional(),
  })
  .strict();
export type DisplayPatch = z.infer<typeof displayPatchSchema>;
export type DisplayUpdate = z.infer<typeof displayUpdateSchema>;

/** Original version-1 actions had exactly label/background and truncated labels in main. */
export const displayActionSchema = z.preprocess((value) => {
  if (!value || typeof value !== "object" || Array.isArray(value)) return value;
  const fields = value as Record<string, unknown>,
    keys = Object.keys(fields);
  return keys.length === 2 &&
    keys.includes("label") &&
    keys.includes("background") &&
    typeof fields.label === "string"
    ? { ...fields, label: fields.label.slice(0, 80) }
    : value;
}, displayUpdateSchema);
