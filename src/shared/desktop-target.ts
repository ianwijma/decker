import { z } from "zod";

const hasScheme = (value: string) => /^[a-z][a-z0-9+.-]*:/i.test(value);
export function supportedDesktopUrl(value: string): boolean {
  if (!/^https?:\/\//i.test(value) || /[\u0000-\u001f\u007f]/.test(value))
    return false;
  try {
    const url = new URL(value);
    return (
      ["http:", "https:"].includes(url.protocol) &&
      !url.username &&
      !url.password
    );
  } catch {
    return false;
  }
}
export const desktopUrlSchema = z
  .string()
  .refine(
    supportedDesktopUrl,
    "Use an HTTP or HTTPS URL without embedded credentials",
  );
export const desktopPathSchema = z
  .string()
  .refine(
    (value) =>
      value.trim().length > 0 &&
      !value.includes("\0") &&
      !hasScheme(value.trimStart()),
    "Use a local path, not a URL; relative paths resolve from the application working directory",
  );
