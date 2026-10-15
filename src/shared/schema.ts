import {
  executionContextSchema,
  type ExecutionContext,
} from "./trigger-context";
import {
  obsTestRequestSchema,
  obsSaveRequestSchema,
  obsCancelRequestSchema,
  obsHelpRequestSchema,
} from "./obs-contract";
import { z } from "zod";
export const id = z.string().min(1).max(160);
export const json: z.ZodType<Json> = z.lazy(() =>
  z.union([
    z.string(),
    z.number().finite(),
    z.boolean(),
    z.null(),
    z.array(json),
    z.record(z.string(), json),
  ]),
);
export type Json =
  string | number | boolean | null | Json[] | { [key: string]: Json };
export const actionSchema = z.object({
  type: id,
  version: z.literal(1).default(1),
  config: z.record(z.string(), json).default({}),
});
export type ActionInstance = z.infer<typeof actionSchema>;
export const edgeSchema = z.object({
  id,
  source: id,
  target: id,
  port: z.string().default("next"),
});
export type Edge = z.infer<typeof edgeSchema>;
export type FlowNode = {
  id: string;
  name: string;
  kind:
    | "trigger"
    | "action"
    | "delay"
    | "condition"
    | "switch"
    | "set"
    | "parallel"
    | "repeat"
    | "foreach"
    | "subflow"
    | "return";
  config: Record<string, Json>;
  action?: ActionInstance;
  body?: Graph;
  branches?: Graph[];
  timeoutMs: number;
  retries: number;
  retrySafe: boolean;
};
export type Graph = { nodes: FlowNode[]; edges: Edge[]; entry: string };
export const nodeSchema: z.ZodType<FlowNode> = z.lazy(() =>
  z.object({
    id,
    name: z.string().max(100),
    kind: z.enum([
      "trigger",
      "action",
      "delay",
      "condition",
      "switch",
      "set",
      "parallel",
      "repeat",
      "foreach",
      "subflow",
      "return",
    ]),
    config: z.record(z.string(), json).default({}),
    action: actionSchema.optional(),
    body: graphSchema.optional(),
    branches: z.array(graphSchema).max(16).optional(),
    timeoutMs: z.number().int().min(10).max(3600000).default(30000),
    retries: z.number().int().min(0).max(5).default(0),
    retrySafe: z.boolean().default(false),
  }),
);
export const graphSchema: z.ZodType<Graph> = z.lazy(() =>
  z.object({
    nodes: z.array(nodeSchema).max(500),
    edges: z.array(edgeSchema).max(1000),
    entry: id,
  }),
);
export const workflowSchema = z.object({
  id,
  name: z.string().min(1).max(100),
  revision: z.number().int().positive(),
  graph: graphSchema,
  inputs: z.array(z.string()).default([]),
  outputs: z.array(z.string()).default([]),
  timeoutMs: z.number().int().min(10).max(3600000).default(300000),
  layout: z
    .record(z.string(), z.object({ x: z.number(), y: z.number() }))
    .default({}),
});
export type WorkflowDefinition = z.infer<typeof workflowSchema>;
export const targetSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("action"), action: actionSchema }),
  z.object({
    kind: z.literal("sequence"),
    actions: z.array(actionSchema).min(1).max(100),
  }),
  z.object({ kind: z.literal("workflow"), workflowId: id }),
]);
export type Target = z.infer<typeof targetSchema>;
export const appearanceSchema = z.object({
  label: z.string().max(80),
  icon: z.string().max(100).default(""),
  asset: z
    .string()
    .regex(/^[a-f0-9]{64}$/)
    .optional(),
  background: z
    .string()
    .regex(/^#[a-fA-F0-9]{6}$/)
    .default("#232428"),
  running: z
    .string()
    .regex(/^#[a-fA-F0-9]{6}$/)
    .default("#5865f2"),
  success: z
    .string()
    .regex(/^#[a-fA-F0-9]{6}$/)
    .default("#23a559"),
  error: z
    .string()
    .regex(/^#[a-fA-F0-9]{6}$/)
    .default("#f23f42"),
});
const v3BindingSchema = z.object({
  id,
  generation: z.number().int().nonnegative(),
  appearance: appearanceSchema,
  press: targetSchema.optional(),
  release: targetSchema.optional(),
  longPress: targetSchema.optional(),
  longPressMs: z.number().int().min(200).max(10000).default(600),
  policy: z
    .enum(["ignore", "queue", "restart", "concurrent"])
    .default("ignore"),
  limit: z.number().int().min(1).max(16).default(4),
});
const v4ToggleSchema = z
  .object({
    on: targetSchema,
    off: targetSchema,
    source: z.discriminatedUnion("kind", [
      z
        .object({ kind: z.literal("app"), initial: z.enum(["on", "off"]) })
        .strict(),
      z
        .object({
          kind: z.literal("external"),
          // User-authored, intended read-only. This is a contract, not enforcement.
          probe: targetSchema,
          timeoutMs: z.number().int().min(10).max(60000).default(10000),
        })
        .strict(),
    ]),
  })
  .strict();
export const observationSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("media"), player: z.string().max(200) }).strict(),
  z
    .object({
      kind: z.literal("audio"),
      target: z.enum(["microphone", "speaker"]),
    })
    .strict(),
  z
    .object({
      kind: z.literal("obs"),
      connectionId: id,
      property: z.enum(["recording", "streaming", "scene", "mute", "source"]),
      name: z.string().max(200),
      sourceId: z.number().int().nonnegative().optional(),
    })
    .strict()
    .superRefine((source, ctx) => {
      if (["scene", "mute", "source"].includes(source.property) && !source.name)
        ctx.addIssue({
          code: "custom",
          path: ["name"],
          message: "Choose a named OBS target",
        });
      if (source.property === "source" && source.sourceId === undefined)
        ctx.addIssue({
          code: "custom",
          path: ["sourceId"],
          message: "Choose a scene item",
        });
    }),
]);
export type ObservationSource = z.infer<typeof observationSchema>;
export const stateAppearanceSchema = z
  .object({
    label: z.string().max(80).optional(),
    icon: z.string().max(100).optional(),
    asset: z
      .string()
      .regex(/^[a-f0-9]{64}$/)
      .nullable()
      .optional(),
    background: z
      .string()
      .regex(/^#[a-fA-F0-9]{6}$/)
      .optional(),
  })
  .strict();
export type StateAppearance = z.infer<typeof stateAppearanceSchema>;
export const toggleSchema = v4ToggleSchema.extend({
  source: z.union([
    v4ToggleSchema.shape.source,
    z
      .object({
        kind: z.literal("observed"),
        observation: observationSchema,
        onWhen: z.boolean(),
      })
      .strict(),
  ]),
  appearance: z
    .object({
      on: stateAppearanceSchema.optional(),
      off: stateAppearanceSchema.optional(),
    })
    .strict()
    .optional(),
});
export type ToggleConfig = z.infer<typeof toggleSchema>;
const rejectPhases = (
  binding: {
    toggle?: unknown;
    press?: unknown;
    release?: unknown;
    longPress?: unknown;
  },
  ctx: z.RefinementCtx,
) => {
  if (binding.toggle && (binding.press || binding.longPress || binding.release))
    ctx.addIssue({
      code: "custom",
      path: ["toggle"],
      message:
        "Toggle mode owns input; remove ordinary press, release and longPress assignments explicitly",
    });
};
const v4BindingSchema = v3BindingSchema
  .extend({ toggle: v4ToggleSchema.optional() })
  .superRefine(rejectPhases);
export const bindingSchema = v3BindingSchema
  .extend({ toggle: toggleSchema.optional() })
  .superRefine(rejectPhases);
export type KeyBinding = z.infer<typeof bindingSchema>;
const v3PageSchema = z.object({
  id,
  name: z.string().min(1).max(100),
  parentId: id.optional(),
  keys: z.record(z.string().regex(/^\d{1,3}$/), v3BindingSchema.strict()),
});
const v3ProfileSchema = z.object({
  id,
  name: z.string().min(1).max(100),
  pages: z.array(v3PageSchema).min(1).max(100),
});
export const pageSchema = v3PageSchema.extend({
  keys: z.record(z.string().regex(/^\d{1,3}$/), bindingSchema),
});
export const profileSchema = v3ProfileSchema.extend({
  pages: z.array(pageSchema).min(1).max(100),
});
export const connectionSchema = z.object({
  id,
  name: z.string().min(1),
  url: z.string().url(),
  credentialRef: id.optional(),
});
export const legacyDocumentSchema = z.object({
  schemaVersion: z.literal(1),
  profiles: z.array(v3ProfileSchema).min(1).max(100),
  workflows: z.array(workflowSchema).max(200),
  connections: z.array(connectionSchema).max(30),
  devices: z
    .array(z.object({ id, brightness: z.number().int().min(0).max(100) }))
    .default([]),
  settings: z.object({
    accent: z.string().regex(/^#[a-fA-F0-9]{6}$/),
    brightness: z.number().int().min(0).max(100),
    startHidden: z.boolean(),
    launchAtLogin: z.boolean(),
    closeToTray: z.boolean(),
    simulator: z.boolean(),
    historyLimit: z.number().int().min(10).max(1000),
  }),
  activeProfileId: id,
  activePageId: id,
});
export const deckSchema = z.object({
  id,
  name: z.string().min(1).max(80),
  kind: z.enum(["hardware", "web", "simulator"]),
  icon: z.string().max(20).default("▦"),
  asset: z
    .string()
    .regex(/^[a-f0-9]{64}$/)
    .optional(),
  hardwareId: id.optional(),
  rows: z.number().int().min(1).max(16),
  columns: z.number().int().min(1).max(16),
  brightness: z.number().int().min(0).max(100).default(70),
  profileIds: z.array(id).min(1).max(100),
  activeProfileId: id,
  activePageId: id,
});
export type DeckConfig = z.infer<typeof deckSchema>;
export const v2DocumentSchema = legacyDocumentSchema
  .omit({ devices: true, activeProfileId: true, activePageId: true })
  .extend({
    schemaVersion: z.literal(2),
    decks: z.array(deckSchema).max(64),
    activeDeckId: z.string(),
    profiles: z.array(v3ProfileSchema).max(200),
    settings: legacyDocumentSchema.shape.settings
      .omit({ brightness: true, simulator: true })
      .extend({
        webEnabled: z.boolean().default(false),
        webPort: z.number().int().min(0).max(65535).default(9018),
      }),
  });
// Parse entries rather than z.record: z.record silently drops "__proto__",
// which can be a legacy workflow ID. fromEntries safely retains it as own data.
const workflowAliasesSchema = z.preprocess(
  (value) =>
    value && typeof value === "object" && !Array.isArray(value)
      ? Object.entries(value)
      : null,
  z
    .array(
      z.tuple([
        id.refine(
          (value) => !z.uuid().safeParse(value).success,
          "Workflow aliases must use legacy non-UUID identities",
        ),
        z.uuid(),
      ]),
    )
    .max(10000)
    .transform((entries) => Object.fromEntries(entries)),
);
const documentObjectSchema = v2DocumentSchema.extend({
  schemaVersion: z.literal(3),
  workflows: z.array(workflowSchema.extend({ id: z.uuid() })).max(200),
  workflowAliases: workflowAliasesSchema.default({}),
});
const validateAliases = (
  doc: Omit<z.infer<typeof documentObjectSchema>, "schemaVersion">,
  ctx: z.RefinementCtx,
) => {
  const workflowIds = new Set(doc.workflows.map((workflow) => workflow.id));
  const documentIds = new Set([
    ...doc.workflows.map((workflow) => workflow.id),
    ...doc.connections.map((c) => c.id),
    ...doc.decks.map((d) => d.id),
    ...doc.profiles.flatMap((p) => [
      p.id,
      ...p.pages.flatMap((page) => [
        page.id,
        ...Object.values(page.keys).map((b) => b.id),
      ]),
    ]),
  ]);
  for (const [alias, target] of Object.entries(doc.workflowAliases)) {
    // Targets may be tombstones after deletion. Never reuse their aliases.
    if (
      documentIds.has(alias) ||
      Object.hasOwn(doc.workflowAliases, target) ||
      (documentIds.has(target) && !workflowIds.has(target))
    )
      ctx.addIssue({
        code: "custom",
        path: ["workflowAliases", alias],
        message: "Workflow alias collides with an identity or another alias",
      });
  }
};
export const v3DocumentSchema =
  documentObjectSchema.superRefine(validateAliases);
export type V3Document = z.infer<typeof v3DocumentSchema>;
export const v4DocumentSchema = documentObjectSchema
  .extend({
    schemaVersion: z.literal(4),
    profiles: z
      .array(
        v3ProfileSchema.extend({
          pages: z
            .array(
              v3PageSchema.extend({
                keys: z.record(
                  z.string().regex(/^\d{1,3}$/),
                  v4BindingSchema.strict(),
                ),
              }),
            )
            .min(1)
            .max(100),
        }),
      )
      .max(200),
  })
  .superRefine(validateAliases);
export const documentSchema = documentObjectSchema
  .extend({
    schemaVersion: z.literal(5),
    profiles: z.array(profileSchema).max(200),
  })
  .superRefine(validateAliases);
export type AppDocument = z.infer<typeof documentSchema>;
export type RunStatus =
  "running" | "success" | "failure" | "cancelled" | "interrupted";
export type NodeExecutionRecord = {
  id: string;
  nodeId: string;
  name: string;
  path: string;
  startedAt: number;
  endedAt?: number;
  status: RunStatus;
  input?: Json;
  output?: Json;
  error?: string;
  attempt: number;
};
export type RunRecord = {
  context?: ExecutionContext;
  id: string;
  workflowId: string;
  workflowName: string;
  revision: number;
  bindingId?: string;
  deckId?: string;
  generation?: number;
  startedAt: number;
  endedAt?: number;
  status: RunStatus;
  nodes: NodeExecutionRecord[];
  error?: string;
};
export type Capability = {
  id: string;
  available: boolean;
  detail: string;
  state?: import("./health").HealthState;
  remedy?: import("./health").RemedyId;
  distribution?: string;
};
export type DeviceStatus = {
  id: string;
  name: string;
  connected: boolean;
  // Presence is discovery evidence; connected is retained as a ready-only alias.
  present: boolean;
  configured: boolean;
  state: DeviceState;
  updatedAt: number;
  // Completion of a driver write, not physical display readback.
  lastSuccessfulWriteAt?: number;
  errorDetails?: {
    stage: "open" | "write" | "discovery";
    message: string;
    code?: string;
    errno?: number;
    at: number;
  };
  simulated: boolean;
  rows: number;
  columns: number;
  iconSize: number;
  error?: string;
};
export type DeviceState =
  | "discovered"
  | "opening"
  | "ready"
  | "permission-denied"
  | "busy"
  | "open-error"
  | "io-error"
  | "disconnected";
export type CredentialStatus =
  "configured" | "missing" | "locked" | "session-only";
export type Snapshot = {
  document: AppDocument;
  toggles?: import("./toggle-contract").ToggleState[];
  runs: RunRecord[];
  devices: DeviceStatus[];
  capabilities: Capability[];
  observed: Record<string, Json>;
  health?: import("./health").HealthRecord[];
  secureStorage: boolean;
  credentialState?: {
    epoch: string;
    persistent: boolean;
    owners: Record<string, CredentialStatus>;
  };
  web: WebStatus;
};
export const requestSchema = z.discriminatedUnion("type", [
  obsTestRequestSchema,
  obsSaveRequestSchema,
  obsCancelRequestSchema,
  obsHelpRequestSchema,
  z.object({
    type: z.literal("save"),
    document: documentSchema,
    navigationEdits: z.array(id).optional(),
    brightnessEdits: z.array(id).optional(),
  }),
  z.object({
    type: z.literal("press"),
    key: z.number().int().min(0).max(255),
    down: z.boolean(),
    deckId: id,
  }),
  z.object({ type: z.literal("test"), binding: bindingSchema, deckId: id }),
  z.object({
    type: z.literal("run"),
    workflowId: id,
    inputs: z.record(z.string(), json).default({}),
    deckId: id.optional(),
  }),
  z.object({ type: z.literal("cancel"), runId: id }),
  z.object({ type: z.literal("activateToggles") }),
  z.object({
    type: z.literal("reconcileToggle"),
    deckId: id,
    bindingId: id,
    generation: z.number().int().nonnegative().optional(),
    expectedToggle: toggleSchema.optional(),
  }),
  z.object({
    type: z.literal("recoverToggle"),
    generation: z.number().int().nonnegative().optional(),
    deckId: id,
    bindingId: id,
    confirmed: z.enum(["on", "off"]),
  }),
  z.object({
    type: z.literal("navigate"),
    deckId: id,
    profileId: id,
    pageId: id,
  }),
  z.object({ type: z.literal("import") }),
  z.object({ type: z.literal("export") }),
  z.object({ type: z.literal("asset") }),
  z
    .object({
      type: z.literal("pickFile"),
      picker: z.enum(["openFile", "saveFile"]),
    })
    .strict(),
  z
    .object({
      type: z.literal("credential"),
      epoch: id,
      owner: z.string().min(1).max(10000),
      operation: z.enum(["set", "remove"]),
      value: z.string().max(16000).default(""),
      persist: z.boolean().default(false),
    })
    .strict()
    .superRefine((request, ctx) => {
      if (request.operation === "set" && !request.value)
        ctx.addIssue({ code: "custom", message: "Enter a password or token" });
      if (request.operation === "remove" && (request.value || request.persist))
        ctx.addIssue({ code: "custom", message: "Invalid remove request" });
    }),
  z.object({ type: z.literal("diagnose") }),
  z.object({
    type: z.literal("diagnosticRemedy"),
    healthId: id,
    action: z.enum(["copy", "open"]),
  }),
  z.object({ type: z.literal("retryDevice"), hardwareId: id }),
  z.object({ type: z.literal("clearHistory") }),
  z.object({ type: z.literal("selectDeck"), deckId: id }),
  z.object({
    type: z.literal("addDeck"),
    kind: z.enum(["hardware", "web", "simulator"]),
    name: z.string().min(1).max(80),
    icon: z.string().max(20),
    hardwareId: id.optional(),
    rows: z.number().int().min(1).max(16),
    columns: z.number().int().min(1).max(16),
  }),
  z.object({ type: z.literal("deleteDeck"), deckId: id }),
  z.object({ type: z.literal("copyProfile"), fromProfileId: id, toDeckId: id }),
  z.object({ type: z.literal("invite"), deckId: id }),
  z.object({
    type: z.literal("approvePairing"),
    pairingId: id,
    approved: z.boolean(),
  }),
  z.object({ type: z.literal("revokeClient"), clientId: id }),
  z.object({ type: z.literal("openWeb"), url: z.string().url() }),
  z.object({ type: z.literal("copyWebLink"), url: z.string().url() }),
]);
export type Request = z.infer<typeof requestSchema>;
export interface DeckerAPI {
  snapshot(): Promise<Snapshot>;
  request(request: Request): Promise<unknown>;
  subscribe(listener: (snapshot: Snapshot) => void): () => void;
}

export const runRecordSchema: z.ZodType<RunRecord> = z.object({
  context: executionContextSchema.optional(),
  id,
  workflowId: id,
  workflowName: z.string(),
  revision: z.number().int().positive(),
  bindingId: id.optional(),
  deckId: id.optional(),
  generation: z.number().int().optional(),
  startedAt: z.number(),
  endedAt: z.number().optional(),
  status: z.enum(["running", "success", "failure", "cancelled", "interrupted"]),
  error: z.string().optional(),
  nodes: z
    .array(
      z.object({
        id,
        nodeId: id,
        name: z.string(),
        path: z.string(),
        startedAt: z.number(),
        endedAt: z.number().optional(),
        status: z.enum([
          "running",
          "success",
          "failure",
          "cancelled",
          "interrupted",
        ]),
        input: json.optional(),
        output: json.optional(),
        error: z.string().optional(),
        attempt: z.number().int().nonnegative(),
      }),
    )
    .max(1000),
});

export type WebKey = {
  stateLabel?: string;
  toggle?: import("./toggle-presentation").ToggleDisplay;
  label: string;
  icon: string;
  background: string;
  asset?: string;
};
export type WebDeckView = {
  id: string;
  name: string;
  rows: number;
  columns: number;
  pageName: string;
  version: string;
  accent: string;
  keys: Record<string, WebKey>;
};
export type WebClient = {
  id: string;
  deckId: string;
  name: string;
  createdAt: number;
  lastSeen: number;
  online: boolean;
};
export type PairingRequest = {
  id: string;
  deckId: string;
  name: string;
  code: string;
  expiresAt: number;
};
export type WebStatus = {
  running: boolean;
  port: number;
  urls: string[];
  error?: string;
  clients: WebClient[];
  pending: PairingRequest[];
};
