import { z } from 'zod'
export const json: z.ZodType<Json> = z.lazy(() =>
  z.union([
    z.string(),
    z.number().finite(),
    z.boolean(),
    z.null(),
    z.array(json),
    z.record(z.string(), json)
  ])
)
export type Json = string | number | boolean | null | Json[] | { [key: string]: Json }
export const actionSchema = z.object({
  type: z.string().min(1),
  version: z.literal(1).default(1),
  config: z.record(z.string(), json).default({})
})
export type Action = z.infer<typeof actionSchema>
export const appearanceSchema = z.object({
  label: z.string().max(80).default(''),
  icon: z.string().max(64).default(''),
  background: z
    .string()
    .regex(/^#[\da-fA-F]{6}$/)
    .default('#232428'),
  asset: z
    .string()
    .regex(/^[a-f0-9]{64}$/)
    .optional()
})
export const bindingSchema = z.object({
  id: z.string(),
  appearance: appearanceSchema,
  actions: z.array(actionSchema).max(64).default([]),
  workflowId: z.string().optional(),
  release: z.array(actionSchema).max(64).default([]),
  longPress: z.array(actionSchema).max(64).default([]),
  longPressMs: z.number().int().min(200).max(10000).default(600),
  policy: z.enum(['ignore', 'queue', 'restart', 'concurrent']).default('ignore'),
  limit: z.number().int().min(1).max(16).default(4),
  enabled: z.boolean().default(true)
})
export type Binding = z.infer<typeof bindingSchema>
export const nodeSchema = z.object({
  id: z.string(),
  label: z.string(),
  kind: z.enum([
    'trigger',
    'action',
    'delay',
    'condition',
    'switch',
    'set',
    'parallel',
    'repeat',
    'foreach',
    'subflow',
    'return'
  ]),
  action: actionSchema.optional(),
  config: z.record(z.string(), json).default({}),
  position: z.object({ x: z.number(), y: z.number() }),
  timeoutMs: z.number().int().min(1).max(300000).default(30000),
  retries: z.number().int().min(0).max(5).default(0),
  retrySafe: z.boolean().default(false)
})
export type FlowNode = z.infer<typeof nodeSchema>
export const edgeSchema = z.object({
  id: z.string(),
  source: z.string(),
  target: z.string(),
  port: z.string().default('next')
})
export const workflowSchema = z.object({
  id: z.string(),
  name: z.string().min(1),
  revision: z.number().int().min(1),
  inputs: z.array(z.string()).default([]),
  outputs: z.array(z.string()).default([]),
  nodes: z.array(nodeSchema).max(256),
  edges: z.array(edgeSchema).max(1024),
  timeoutMs: z.number().int().min(1).max(3600000).default(60000)
})
export type Workflow = z.infer<typeof workflowSchema>
export const pageSchema = z.object({
  id: z.string(),
  name: z.string(),
  parentId: z.string().optional(),
  keys: z.record(z.string().regex(/^\d{1,3}$/), bindingSchema)
})
export const configSchema = z
  .object({
    schemaVersion: z.literal(1),
    profiles: z
      .array(
        z.object({ id: z.string(), name: z.string(), pages: z.array(pageSchema).min(1).max(100) })
      )
      .min(1)
      .max(100),
    workflows: z.array(workflowSchema).max(500),
    activeProfile: z.string(),
    activePage: z.string(),
    settings: z.object({
      accent: z.string().regex(/^#[\da-fA-F]{6}$/),
      brightness: z.number().int().min(0).max(100),
      simulator: z.boolean(),
      startHidden: z.boolean(),
      launchAtLogin: z.boolean(),
      historyLimit: z.number().int().min(10).max(1000),
      deviceSerial: z.string().default('')
    }),
    connections: z
      .array(
        z.object({
          id: z.string(),
          name: z.string(),
          url: z.string().url(),
          credentialRef: z.string().optional()
        })
      )
      .max(50)
  })
  .superRefine((c, ctx) => {
    const ids = c.profiles
      .map((p) => p.id)
      .concat(
        c.profiles.flatMap((p) => p.pages.map((pg) => pg.id)),
        c.workflows.map((w) => w.id),
        c.profiles.flatMap((p) => p.pages.flatMap((pg) => Object.values(pg.keys).map((b) => b.id)))
      )
    if (new Set(ids).size !== ids.length)
      ctx.addIssue({ code: 'custom', message: 'Document IDs must be unique' })
    const profile = c.profiles.find((p) => p.id === c.activeProfile)
    if (!profile?.pages.some((p) => p.id === c.activePage))
      ctx.addIssue({ code: 'custom', message: 'Active profile/page does not exist' })
    for (const p of c.profiles)
      for (const page of p.pages) {
        const seen = new Set([page.id])
        let parent = page.parentId
        while (parent) {
          if (seen.has(parent)) {
            ctx.addIssue({ code: 'custom', message: 'Folder ancestry contains a cycle' })
            break
          }
          seen.add(parent)
          parent = p.pages.find((pg) => pg.id === parent)?.parentId
        }
        if (page.parentId && !p.pages.some((pg) => pg.id === page.parentId && pg.id !== page.id))
          ctx.addIssue({ code: 'custom', message: 'Folder parent does not exist' })
        for (const key of Object.values(page.keys))
          if (key.workflowId && !c.workflows.some((w) => w.id === key.workflowId))
            ctx.addIssue({ code: 'custom', message: 'Binding references a missing workflow' })
      }
  })
export type Config = z.infer<typeof configSchema>
export interface NodeRecord {
  nodeId: string
  path: string
  status: 'running' | 'success' | 'error' | 'cancelled'
  startedAt: number
  endedAt?: number
  input?: Json
  output?: Json
  error?: string
}
export interface RunRecord {
  id: string
  bindingId?: string
  bindingGeneration?: number
  workflowId: string
  name: string
  revision: number
  status: 'running' | 'success' | 'error' | 'cancelled' | 'interrupted'
  startedAt: number
  endedAt?: number
  nodes: NodeRecord[]
  error?: string
  output?: Json
}
export interface DeviceStatus {
  id: string
  name: string
  connected: boolean
  simulated: boolean
  rows: number
  columns: number
  keySize: number
  error?: string
}
export interface Capability {
  id: string
  available: boolean
  detail: string
}
export interface State {
  config: Config
  runs: RunRecord[]
  devices: DeviceStatus[]
  capabilities: Capability[]
  observed: Record<string, Json>
  secretStorage: string
}
export interface API {
  state(): Promise<State>
  save(config: Config): Promise<void>
  press(index: number, event?: 'down' | 'up' | 'test'): Promise<void>
  run(workflowId: string, input?: Record<string, Json>): Promise<string>
  cancel(id: string): Promise<void>
  export(): Promise<string>
  import(text: string): Promise<Config>
  credential(id: string, value: string, persist: boolean): Promise<void>
  image(data: string): Promise<string>
  quit(): Promise<void>
  subscribe(listener: (state: State) => void): () => void
}
export const uid = () => crypto.randomUUID()
export function defaultConfig(): Config {
  const make = (id: string, label: string, icon: string, actions: Action[], workflowId?: string) =>
    bindingSchema.parse({ id, appearance: { label, icon }, actions, workflowId })
  const action = (type: string, config: Action['config']): Action => ({ type, version: 1, config })
  return configSchema.parse({
    schemaVersion: 1,
    profiles: [
      {
        id: 'profile-default',
        name: 'My workspace',
        pages: [
          {
            id: 'page-home',
            name: 'Home',
            keys: {
              '0': make('key-flow', 'Focus session', '✦', [], 'flow-focus'),
              '1': make('key-url', 'Documentation', '↗', [
                action('open', { target: 'https://www.electronjs.org/docs/latest/' })
              ]),
              '2': make('key-copy', 'Copy greeting', '▤', [
                action('clipboard', { text: 'Hello from Decker' })
              ]),
              '3': make('key-mute', 'Microphone', '🎙', [
                action('audio', { operation: 'mute', target: 'source', value: true })
              ]),
              '4': make('key-media', 'Play / pause', '▶', [
                action('media', { operation: 'PlayPause', player: '' })
              ]),
              '5': make('key-obs', 'OBS scene', '◉', [
                action('obs', {
                  connection: '',
                  request: 'SetCurrentProgramScene',
                  data: { sceneName: 'Main' }
                })
              ]),
              '8': make('key-folder', 'Tools', '▣', [action('page', { pageId: 'page-tools' })])
            }
          },
          {
            id: 'page-tools',
            name: 'Tools',
            parentId: 'page-home',
            keys: { '0': make('key-back', 'Back', '←', [action('back', {})]) }
          }
        ]
      }
    ],
    activeProfile: 'profile-default',
    activePage: 'page-home',
    workflows: [
      workflowSchema.parse({
        id: 'flow-focus',
        name: 'Focus session',
        revision: 1,
        nodes: [
          { id: 'start', kind: 'trigger', label: 'Button pressed', position: { x: 60, y: 120 } },
          {
            id: 'data',
            kind: 'set',
            label: 'Set intention',
            config: { values: { message: 'Time to focus' } },
            position: { x: 320, y: 120 }
          },
          {
            id: 'wait',
            kind: 'delay',
            label: 'Take a breath',
            config: { ms: 250 },
            position: { x: 580, y: 120 }
          },
          {
            id: 'notify',
            kind: 'action',
            label: 'You are ready',
            action: action('notification', {
              title: 'Focus session',
              body: '{{nodes.data.message}}'
            }),
            position: { x: 840, y: 120 }
          }
        ],
        edges: [
          { id: 'e1', source: 'start', target: 'data' },
          { id: 'e2', source: 'data', target: 'wait' },
          { id: 'e3', source: 'wait', target: 'notify' }
        ]
      })
    ],
    settings: {
      accent: '#5865f2',
      brightness: 70,
      simulator: true,
      startHidden: false,
      launchAtLogin: false,
      historyLimit: 100,
      deviceSerial: ''
    },
    connections: []
  })
}
