import { z } from "zod";
import { decodeArgs } from "./data-contract";
import {
  extractValueSchema,
  httpOutputSchema,
  parseJsonSchema,
  valueOutputSchema,
} from "./data-actions";
import type { ActionInstance } from "./schema";
import { desktopPathSchema, desktopUrlSchema } from "./desktop-target";
import { mediaActions } from "./media";
import {
  readTextFileSchema,
  mutateTextFileSchema,
  readTextFileOutputSchema,
  mutateTextFileOutputSchema,
} from "./text-files";
import {
  DEFAULT_BRIGHTNESS_STEP,
  brightnessStepSchema,
  brightnessValueSchema,
} from "./brightness";
export type PaletteContext = "button" | "workflow";
export type Field = {
  key: string;
  label: string;
  type?:
    | "text"
    | "number"
    | "boolean"
    | "select"
    | "secret"
    | "connection"
    | "workflow"
    | "profile"
    | "page"
    | "file"
    | "json";
  /** For a file field, offer the desktop-only native selector beside manual entry. */
  picker?: "openFile" | "saveFile";
  multiline?: boolean;
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
  /** Defaults to both contexts. Global paletteVisible:false always wins. */
  paletteContexts?: PaletteContext[];
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
    id: "file.readText",
    name: "Read text file",
    group: "Developer",
    icon: "▤",
    description:
      "Read complete UTF-8 text up to 65,536 bytes; larger files fail explicitly.",
    capabilities: [],
    fields: [
      {
        ...f("path", "File path", "", "file"),
        picker: "openFile",
        hint: "Absolute host path only. Final symlinks, hard links and non-regular files are unsupported.",
      },
    ],
    idempotent: true,
  },
  ...(["write", "append"] as const).map((operation) => ({
    id: operation === "write" ? "file.writeText" : "file.appendText",
    name: operation === "write" ? "Write text file" : "Append text file",
    group: "Developer",
    icon: "▤",
    description:
      operation === "write"
        ? "Replace UTF-8 content atomically. Successful writes cannot be undone by cancellation."
        : "Add UTF-8 content without overwriting existing bytes. Partial appends cannot be undone; retries are off by default.",
    capabilities: [],
    fields: [
      {
        ...f("path", "File path", "", "file"),
        picker: "saveFile" as const,
        hint: "Choose a destination, including a new file, or enter an absolute host path. No home/environment expansion.",
      },
      {
        ...f("content", "Content", ""),
        multiline: true,
        hint: "At most 262,144 UTF-8 bytes. References must resolve to text; mixed templates explicitly format JSON values.",
      },
      {
        ...f("createParents", "Create parent directories", false, "boolean"),
        hint: "Off by default. Created directories and successful file effects remain after cancellation.",
      },
    ],
    idempotent: operation === "write",
  })),
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
      f("credentialRef", "Bearer token", "", "secret"),
    ],
    idempotent: false,
  },
  {
    id: "data.parseJson",
    name: "Parse JSON",
    group: "Developer",
    icon: "{}",
    description:
      "Parse complete JSON text or an HTTP result, rejecting known truncation.",
    capabilities: [],
    fields: [f("input", "JSON text or HTTP result", "{}", "json")],
    idempotent: true,
  },
  {
    id: "data.extract",
    name: "Extract value",
    group: "Developer",
    icon: ".",
    description:
      "Read an own property with a dot path or segment array. Optional fallback handles missing values.",
    capabilities: [],
    fields: [
      f("input", "Input value", "", "json"),
      f("path", "Data path", "value", "json"),
    ],
    idempotent: true,
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
      f("connectionId", "OBS connection", "", "connection"),
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
    fields: [f("pageId", "Page / folder", "", "page")],
    idempotent: true,
  },
  {
    id: "deck.profile",
    name: "Change profile",
    group: "Deck",
    icon: "▤",
    description: "Activate a profile and its first page.",
    capabilities: [],
    fields: [f("profileId", "Profile", "", "profile")],
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
    paletteContexts: ["workflow"],
    name: "Set brightness",
    group: "Deck",
    icon: "☀",
    description: "Set deck brightness from 0 to 100.",
    capabilities: [],
    fields: [f("value", "Brightness", 70, "number")],
    idempotent: true,
  },
  ...[
    { id: "deck.brightnessIncrease", name: "Increase brightness", icon: "☀+" },
    { id: "deck.brightnessDecrease", name: "Decrease brightness", icon: "☀−" },
  ].map((action) => ({
    ...action,
    group: "Deck",
    description:
      "Adjust the originating deck by a positive step, clamped to 0–100.",
    capabilities: [],
    fields: [f("step", "Step", DEFAULT_BRIGHTNESS_STEP, "number")],
    idempotent: false,
  })),
  {
    id: "deck.appearance",
    paletteContexts: ["workflow"],
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
const argsSchema = z
  .union([z.string(), z.array(z.string()).max(256)])
  .superRefine((value, ctx) => {
    try {
      decodeArgs(value);
    } catch (error) {
      ctx.addIssue({ code: "custom", message: (error as Error).message });
    }
  });
const commandOutputSchema = z.object({
  stdout: z.string(),
  stderr: z.string(),
  exitCode: z.number().int(),
});
export const catalog: ActionDefinition[] = definitions.map((d) => {
  let schema: z.ZodType<Record<string, unknown>> =
    d.id === "data.parseJson"
      ? parseJsonSchema
      : d.id === "data.extract"
        ? extractValueSchema
        : z.object(
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
                            ? argsSchema
                            : ["executable", "url", "target", "keys"].includes(
                                  field.key,
                                )
                              ? z.string().min(1)
                              : z.string(),
              ]),
            ),
          );
  if (d.id === "file.readText") schema = readTextFileSchema;
  if (d.id === "file.writeText" || d.id === "file.appendText")
    schema = mutateTextFileSchema;
  if (d.id === "deck.brightnessIncrease" || d.id === "deck.brightnessDecrease")
    schema = z.object({ step: brightnessStepSchema });
  return {
    ...d,
    version: 1,
    schema,
    inputSchema: schema,
    outputSchema:
      d.id === "file.readText"
        ? readTextFileOutputSchema
        : d.id === "file.writeText" || d.id === "file.appendText"
          ? mutateTextFileOutputSchema
          : d.id === "deck.brightnessIncrease" ||
              d.id === "deck.brightnessDecrease"
            ? brightnessValueSchema
            : d.id === "http.request"
              ? httpOutputSchema
              : d.id === "data.parseJson" || d.id === "data.extract"
                ? valueOutputSchema
                : d.id === "command.run" || d.id === "command.shell"
                  ? commandOutputSchema
                  : d.id === "app.launch"
                    ? z.object({ pid: z.number().int() })
                    : z.unknown(),
  };
});
export const actionById = (id: string) => catalog.find((d) => d.id === id);
// Visibility affects only new assignments, never lookup, import or execution.
export const visibleInPalette = (
  d: ActionDefinition,
  context: PaletteContext,
) =>
  d.paletteVisible !== false &&
  (!d.paletteContexts || d.paletteContexts.includes(context));
export const catalogForPalette = (context: PaletteContext) =>
  catalog.filter((d) => visibleInPalette(d, context));
// Compatibility export for button libraries. Workflows must select their context.
export const paletteCatalog = catalogForPalette("button");
export const makeAction = (type: string): ActionInstance => ({
  type,
  version: 1,
  config: Object.fromEntries(
    actionById(type)!.fields.map((field) => [field.key, field.default ?? ""]),
  ),
});
