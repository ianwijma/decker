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
export const bindingSchema = z.object({
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
export type KeyBinding = z.infer<typeof bindingSchema>;
export const pageSchema = z.object({
  id,
  name: z.string().min(1).max(100),
  parentId: id.optional(),
  keys: z.record(z.string().regex(/^\d{1,3}$/), bindingSchema),
});
export const profileSchema = z.object({
  id,
  name: z.string().min(1).max(100),
  pages: z.array(pageSchema).min(1).max(100),
});
export const connectionSchema = z.object({
  id,
  name: z.string().min(1),
  url: z.string().url(),
  credentialRef: id.optional(),
});
export const documentSchema = z.object({
  schemaVersion: z.literal(1),
  profiles: z.array(profileSchema).min(1).max(100),
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
  id: string;
  workflowId: string;
  workflowName: string;
  revision: number;
  bindingId?: string;
  generation?: number;
  startedAt: number;
  endedAt?: number;
  status: RunStatus;
  nodes: NodeExecutionRecord[];
  error?: string;
};
export type Capability = { id: string; available: boolean; detail: string };
export type DeviceStatus = {
  id: string;
  name: string;
  connected: boolean;
  simulated: boolean;
  rows: number;
  columns: number;
  iconSize: number;
  error?: string;
};
export type Snapshot = {
  document: AppDocument;
  runs: RunRecord[];
  devices: DeviceStatus[];
  capabilities: Capability[];
  observed: Record<string, Json>;
  secureStorage: boolean;
};
export const requestSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("save"), document: documentSchema }),
  z.object({
    type: z.literal("press"),
    key: z.number().int().min(0).max(255),
    down: z.boolean(),
  }),
  z.object({ type: z.literal("test"), binding: bindingSchema }),
  z.object({
    type: z.literal("run"),
    workflowId: id,
    inputs: z.record(z.string(), json).default({}),
  }),
  z.object({ type: z.literal("cancel"), runId: id }),
  z.object({ type: z.literal("navigate"), profileId: id, pageId: id }),
  z.object({ type: z.literal("import") }),
  z.object({ type: z.literal("export") }),
  z.object({ type: z.literal("asset") }),
  z.object({
    type: z.literal("credential"),
    ref: id,
    value: z.string().max(16000),
    persist: z.boolean(),
  }),
  z.object({ type: z.literal("diagnose") }),
  z.object({ type: z.literal("clearHistory") }),
]);
export type Request = z.infer<typeof requestSchema>;
export interface DeckerAPI {
  snapshot(): Promise<Snapshot>;
  request(request: Request): Promise<unknown>;
  subscribe(listener: (snapshot: Snapshot) => void): () => void;
}

export const runRecordSchema: z.ZodType<RunRecord> = z.object({
  id,
  workflowId: id,
  workflowName: z.string(),
  revision: z.number().int().positive(),
  bindingId: id.optional(),
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
