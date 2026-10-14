import { resolve } from "node:path";
import { desktopPathSchema, desktopUrlSchema } from "../shared/desktop-target";

export type DesktopShell = {
  openExternal: (url: string) => Promise<void>;
  openPath: (path: string) => Promise<string>;
};
// Values arrive after workflow resolution. Validate again at the host boundary.
export async function openDesktopTarget(
  action: "desktop.open" | "desktop.openUrl" | "desktop.openFile",
  value: unknown,
  shell: DesktopShell,
  cwd = process.cwd(),
): Promise<null> {
  if (
    action === "desktop.openUrl" ||
    (action === "desktop.open" &&
      typeof value === "string" &&
      /^https?:\/\//.test(value))
  ) {
    const url = desktopUrlSchema.parse(value);
    await shell.openExternal(new URL(url).href);
  } else {
    const path = desktopPathSchema.parse(value);
    const error = await shell.openPath(resolve(cwd, path));
    if (error) throw new Error(error);
  }
  return null;
}
