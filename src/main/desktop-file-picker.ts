import { isAbsolute } from "node:path";
import type { OpenDialogOptions, OpenDialogReturnValue } from "electron";
import { desktopPathSchema } from "../shared/desktop-target";

export async function pickDesktopFile(
  showOpenDialog: (
    options: OpenDialogOptions,
  ) => Promise<OpenDialogReturnValue>,
): Promise<string | null> {
  const result = await showOpenDialog({
    title: "Choose file",
    properties: ["openFile"],
  });
  if (result.canceled) return null;
  const path = desktopPathSchema.parse(result.filePaths[0]);
  if (result.filePaths.length !== 1 || !isAbsolute(path))
    throw new Error("The file selector must return one absolute path");
  return path;
}
