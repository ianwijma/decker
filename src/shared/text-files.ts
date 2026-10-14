import { z } from "zod";

// A read result remains below the 1 MB JSON output ceiling even when every
// character needs six-byte JSON escaping. Content is never echoed by mutations.
export const TEXT_READ_LIMIT = 65_536;
export const TEXT_CONTENT_LIMIT = 262_144;
export const textFilePathSchema = z
  .string()
  .max(4096)
  .refine(
    (path) =>
      path.startsWith("/") &&
      !path.includes("\0") &&
      !/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u.test(
        path,
      ) &&
      utf8ByteLength(path) <= 4096,
    "Use an absolute host path of at most 4096 UTF-8 bytes; no URL or home expansion",
  );
function utf8ByteLength(value: string) {
  return new TextEncoder().encode(value).length;
}
export const fileContentSchema = z
  .string()
  .max(TEXT_CONTENT_LIMIT)
  .refine((content) => {
    if (content.length > TEXT_CONTENT_LIMIT) return false;
    const bytes = new TextEncoder().encode(content);
    return (
      bytes.length <= TEXT_CONTENT_LIMIT &&
      new TextDecoder("utf-8", { ignoreBOM: true }).decode(bytes) === content
    );
  }, `Content must be valid Unicode text of at most ${TEXT_CONTENT_LIMIT} UTF-8 bytes`);
export const readTextFileSchema = z.object({ path: textFilePathSchema });
export const mutateTextFileSchema = z.object({
  path: textFilePathSchema,
  content: fileContentSchema,
  createParents: z.boolean().default(false),
});
export const readTextFileOutputSchema = z.object({
  text: z.string(),
  bytes: z.number().int().min(0).max(TEXT_READ_LIMIT),
  truncated: z.literal(false),
});
export const mutateTextFileOutputSchema = z.object({
  bytesWritten: z.number().int().min(0).max(TEXT_CONTENT_LIMIT),
  created: z.boolean(),
  operation: z.enum(["overwrite", "append"]),
});
