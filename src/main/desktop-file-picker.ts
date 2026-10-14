import { isAbsolute } from "node:path";
import type {
  OpenDialogOptions,
  OpenDialogReturnValue,
  SaveDialogOptions,
  SaveDialogReturnValue,
} from "electron";
import { desktopPathSchema } from "../shared/desktop-target";
import { textFilePathSchema } from "../shared/text-files";

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

export async function pickDesktopDestination(
  showSaveDialog: (
    options: SaveDialogOptions,
  ) => Promise<SaveDialogReturnValue>,
): Promise<string | null> {
  const result = await showSaveDialog({
    title: "Choose text file destination",
  });
  if (result.canceled) return null;
  return textFilePathSchema.parse(result.filePath);
}
