import { z } from "zod";

export const IMAGE_LIMITS = {
  inputBytes: 4 * 1024 * 1024,
  pixels: 16_000_000,
  timeoutMs: 15_000,
  outputBytes: 1024 * 1024,
  redirects: 4,
  concurrency: 2,
  queue: 16,
};
export const assetHashSchema = z.string().regex(/^[a-f0-9]{64}$/);
export function imageUrl(value: string): URL {
  try {
    const url = new URL(value);
    if (
      !["http:", "https:"].includes(url.protocol) ||
      url.username ||
      url.password
    )
      throw new Error();
    url.hash = "";
    return url;
  } catch {
    throw new Error("Use an HTTP(S) image URL without embedded credentials");
  }
}
export const fetchImageSchema = z
  .object({
    url: z
      .string()
      .min(1)
      .max(4096)
      .refine((value) => {
        try {
          imageUrl(value);
          return true;
        } catch {
          return false;
        }
      }, "Use an HTTP(S) image URL without embedded credentials"),
    maxBytes: z.number().int().min(1).max(IMAGE_LIMITS.inputBytes).optional(),
    maxPixels: z.number().int().min(1).max(IMAGE_LIMITS.pixels).optional(),
    timeoutMs: z.number().int().min(100).max(IMAGE_LIMITS.timeoutMs).optional(),
    credentialRef: z.string().max(4096).optional(),
  })
  .strict();
export const fetchImageOutputSchema = z
  .object({
    asset: assetHashSchema,
    width: z.literal(256),
    height: z.literal(256),
    format: z.literal("png"),
    bytes: z.number().int().min(1).max(IMAGE_LIMITS.outputBytes),
    sourceWidth: z.number().int().positive(),
    sourceHeight: z.number().int().positive(),
    sourceFormat: z.enum(["png", "jpeg", "webp"]),
  })
  .strict();
