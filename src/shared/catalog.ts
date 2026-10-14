import { z } from "zod";
import type { ActionInstance } from "./schema";
import { desktopPathSchema, desktopUrlSchema } from "./desktop-target";
import { mediaActions } from "./media";
export type Field = {
  key: string;
  label: string;
  type?:
    "text" | "number" | "boolean" | "select" | "secret" | "workflow" | "file";
  /** For a file field, offer the desktop-only native selector beside manual entry. */
  picker?: "openFile";
  options?: string[];
  default?: string | number | boolean;
  hint?: string;
};
export type ActionDefinition = {
  id: string;
  version: 1;
  name: string;
  group: string;
  description: string;
  icon: string;
  capabilities: string[];
  fields: Field[];
  schema: z.ZodType<Record<string, unknown>>;
  inputSchema: z.ZodType;
  outputSchema: z.ZodType;
  resource?: string;
  idempotent: boolean;
  /** Defaults to visible; false retains lookup/import/editing but hides new assignments. */
  paletteVisible?: boolean;
};
const f = (
  key: string,
  label: string,
  defaultValue: string | number | boolean = "",
  type: Field["type"] = "text",
  options?: string[],
): Field => ({ key, label, default: defaultValue, type, options });
const definitions: Omit<
  ActionDefinition,
  "version" | "schema" | "inputSchema" | "outputSchema"
>[] = [
  {
    id: "app.launch",
    name: "Launch application",
    group: "Developer",
    icon: "⌘",
    description: "Start an executable with an argument array.",
    capabilities: [],
    fields: [
      f("executable", "Executable", "code"),
      f("args", "Arguments (JSON array)", "[]"),
    ],
    idempotent: false,
  },
  {
    id: "desktop.open",
    paletteVisible: false,
    name: "Open URL or file",
    group: "Developer",
    icon: "↗",
    description: "Open a URL, file or directory with the desktop default.",
    capabilities: [],
    fields: [f("target", "URL or path", "https://example.com")],
    idempotent: false,
  },
  {
    id: "desktop.openUrl",
    name: "Open URL",
    group: "Developer",
    icon: "↗",
    description: "Open an HTTP or HTTPS URL without embedded credentials.",
    capabilities: [],
    fields: [f("url", "URL", "https://example.com")],
    idempotent: false,
  },
  {
    id: "desktop.openFile",
    name: "Open file",
    group: "Developer",
    icon: "↗",
    description: "Open a local file with the desktop default application.",
    capabilities: [],
    fields: [
      {
        ...f("path", "File path", "./file.txt", "file"),
        picker: "openFile",
        hint: "Choose a file or enter a path. Relative paths resolve from the application working directory; spaces and Unicode are preserved.",
      },
    ],
    idempotent: false,
  },
  {
    id: "command.run",
    name: "Run command",
    group: "Developer",
    icon: ">_",
    description: "Run an executable without shell expansion.",
    capabilities: [],
    fields: [
      f("executable", "Executable", "echo"),
      f("args", "Arguments (JSON array)", '["Hello from Decker"]'),
      f("cwd", "Working directory", ""),
    ],
    resource: "command",
    idempotent: false,
  },
  {
    id: "command.shell",
    name: "Shell script",
    group: "Developer",
    icon: "$_",
    description: "Explicit trusted shell script. Review before running.",
    capabilities: [],
    fields: [
      f("script", "Script", 'printf "Hello from Decker\\n"'),
      f("cwd", "Working directory", ""),
    ],
    resource: "command",
    idempotent: false,
  },
  {
    id: "http.request",
    name: "HTTP request",
    group: "Developer",
    icon: "⇄",
    description: "Fetch a URL with bounded response data.",
    capabilities: [],
    fields: [
      f("url", "URL", "https://example.com"),
      f("method", "Method", "GET", "select", [
        "GET",
        "POST",
        "PUT",
        "PATCH",
        "DELETE",
      ]),
      f("body", "Body", ""),
      f("credentialRef", "Bearer credential reference", ""),
    ],
    idempotent: false,
  },
  {
    id: "desktop.notify",
    name: "Notification",
    group: "Developer",
    icon: "♧",
    description: "Show a desktop notification.",
    capabilities: [],
    fields: [
      f("title", "Title", "Decker"),
      f("body", "Message", "Workflow complete"),
    ],
    idempotent: false,
  },
  {
    id: "desktop.copy",
    name: "Copy text",
    group: "Developer",
    icon: "▣",
    description: "Copy text to the system clipboard.",
    capabilities: [],
    fields: [f("text", "Text", "Hello")],
    idempotent: true,
  },
  {
    id: "keyboard.shortcut",
    name: "Send shortcut",
    group: "Desktop",
    icon: "⌨",
    description: "Inject a shortcut on X11 using xdotool.",
    capabilities: ["keyboard"],
    fields: [f("keys", "Keys", "ctrl+alt+t")],
    resource: "keyboard",
    idempotent: false,
  },
  {
    id: "keyboard.type",
    name: "Type text",
    group: "Desktop",
    icon: "T",
    description: "Type literal text on X11.",
    capabilities: ["keyboard"],
    fields: [f("text", "Text", "Hello")],
    resource: "keyboard",
    idempotent: false,
  },
  {
    id: "media.control",
    paletteVisible: false,
    name: "Media control",
    group: "Desktop",
    icon: "▶",
    description: "Control an MPRIS player over the session bus.",
    capabilities: ["media"],
    fields: [
      f("operation", "Operation", "PlayPause", "select", [
        "PlayPause",
        "Play",
        "Pause",
        "Next",
        "Previous",
        "Stop",
      ]),
      f("player", "Player bus name (blank: first)", ""),
    ],
    resource: "media",
    idempotent: false,
  },
  ...mediaActions.map((action) => ({
    id: action.id,
    name: action.name,
    group: "Media",
    icon: action.icon,
    description: `${action.name} on the selected MPRIS player. Blank player selects the first sorted bus name.`,
    capabilities: ["media"],
    fields: [f("player", "Player bus name (blank: first)", "")],
    resource: "media",
    idempotent: false,
  })),
  {
    id: "audio.control",
    name: "Audio / microphone",
    group: "Desktop",
    icon: "♫",
    description: "Set volume, mute, or default device.",
    capabilities: ["audio"],
    fields: [
      f("operation", "Operation", "mute", "select", [
        "mute",
        "volume",
        "default",
      ]),
      f("target", "Target", "@DEFAULT_AUDIO_SINK@"),
      f("deviceKind", "Device kind", "output", "select", ["output", "input"]),
      f("value", "Value", "toggle"),
    ],
    resource: "audio",
    idempotent: false,
  },
  {
    id: "obs.control",
    name: "OBS Studio",
    group: "Streaming",
    icon: "◉",
    description: "Scenes, sources, input mute, streaming and recording.",
    capabilities: ["obs"],
    fields: [
      f("connectionId", "Connection ID", "obs"),
      f("operation", "Operation", "scene", "select", [
        "scene",
        "source",
        "mute",
        "recording",
        "streaming",
      ]),
      f("name", "Scene / input name", ""),
      f("sourceId", "Scene item ID", 0, "number"),
      f("enabled", "Enabled", true, "boolean"),
    ],
    resource: "obs",
    idempotent: true,
  },
  {
    id: "deck.page",
    name: "Change page / folder",
    group: "Deck",
    icon: "▦",
    description: "Navigate to a page or nested folder.",
    capabilities: [],
    fields: [f("pageId", "Page ID", "")],
    idempotent: true,
  },
  {
    id: "deck.profile",
    name: "Change profile",
    group: "Deck",
    icon: "▤",
    description: "Activate a profile and its first page.",
    capabilities: [],
    fields: [f("profileId", "Profile ID", "")],
    idempotent: true,
  },
  {
    id: "deck.back",
    name: "Leave folder",
    group: "Deck",
    icon: "←",
    description: "Return to the parent page.",
    capabilities: [],
    fields: [],
    idempotent: true,
  },
  {
    id: "deck.brightness",
    name: "Set brightness",
    group: "Deck",
    icon: "☀",
    description: "Set deck brightness from 0 to 100.",
    capabilities: [],
    fields: [f("value", "Brightness", 70, "number")],
    idempotent: true,
  },
  {
    id: "deck.appearance",
    name: "Change key appearance",
    group: "Deck",
    icon: "✦",
    description: "Change the triggering key label and background.",
    capabilities: [],
    fields: [
      f("label", "Label", "Ready"),
      f("background", "Background", "#23a559"),
    ],
    idempotent: true,
  },
  {
    id: "workflow.run",
    name: "Run workflow",
    group: "Deck",
    icon: "⑂",
    description: "Run a named workflow as a child of this run.",
    capabilities: [],
    fields: [f("workflowId", "Workflow", "", "workflow")],
    idempotent: false,
  },
  {
    id: "workflow.cancel",
    name: "Cancel workflow",
    group: "Deck",
    icon: "■",
    description: "Cancel active runs for a workflow.",
    capabilities: [],
    fields: [f("workflowId", "Workflow", "", "workflow")],
    idempotent: true,
  },
];
export const catalog: ActionDefinition[] = definitions.map((d) => ({
  ...d,
  version: 1,
  inputSchema: z.record(z.string(), z.unknown()),
  outputSchema: z.unknown(),
  schema: z.object(
    Object.fromEntries(
      d.fields.map((field) => [
        field.key,
        d.id === "desktop.openUrl" && field.key === "url"
          ? desktopUrlSchema
          : d.id === "desktop.openFile" && field.key === "path"
            ? desktopPathSchema
            : field.type === "number"
              ? z.number()
              : field.type === "boolean"
                ? z.boolean()
                : field.options
                  ? z.enum(field.options as [string, ...string[]])
                  : field.key === "args"
                    ? z.string().refine((value) => {
                        try {
                          const args = JSON.parse(value);
                          return (
                            Array.isArray(args) &&
                            args.length <= 256 &&
                            args.every((a) => typeof a === "string")
                          );
                        } catch {
                          return false;
                        }
                      }, "Use a JSON array of at most 256 string arguments")
                    : ["executable", "url", "target", "keys"].includes(
                          field.key,
                        )
                      ? z.string().min(1)
                      : z.string(),
      ]),
    ),
  ),
}));
export const actionById = (id: string) => catalog.find((d) => d.id === id);
// Visibility affects only new assignments, never lookup, import or execution.
export const paletteCatalog = catalog.filter((d) => d.paletteVisible !== false);
export const makeAction = (type: string): ActionInstance => ({
  type,
  version: 1,
  config: Object.fromEntries(
    actionById(type)!.fields.map((field) => [field.key, field.default ?? ""]),
  ),
});
