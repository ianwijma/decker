import { z } from 'zod'
import { json, type Action } from './schema'
const str = z.string().max(65536)
const record = z.record(z.string(), json)
const catalog = [
  {
    id: 'launch',
    name: 'Launch application',
    group: 'Developer',
    icon: '⌘',
    capability: 'launch',
    schema: z.object({
      executable: str.min(1),
      args: z.array(str).default([]),
      desktopEntry: z.boolean().default(false)
    }),
    defaults: { executable: 'code', args: [] }
  },
  {
    id: 'open',
    name: 'Open URL or file',
    group: 'Developer',
    icon: '↗',
    capability: 'desktop',
    schema: z.object({ target: str.min(1) }),
    defaults: { target: 'https://example.com' }
  },
  {
    id: 'command',
    name: 'Run command',
    group: 'Developer',
    icon: '>_',
    capability: 'command',
    schema: z.object({
      executable: str.min(1),
      args: z.array(str).default([]),
      resource: str.default('commands')
    }),
    defaults: { executable: 'echo', args: ['Hello from Decker'] }
  },
  {
    id: 'shell',
    name: 'Shell script',
    group: 'Developer',
    icon: '$_',
    capability: 'command',
    schema: z.object({ script: str.min(1), resource: str.default('commands') }),
    defaults: { script: 'echo "Hello from Decker"' }
  },
  {
    id: 'http',
    name: 'HTTP request',
    group: 'Developer',
    icon: '⇄',
    capability: 'http',
    schema: z.object({
      url: z.string().url(),
      method: z.enum(['GET', 'POST', 'PUT', 'PATCH', 'DELETE']).default('GET'),
      headers: z.record(z.string(), str).default({}),
      body: str.default(''),
      credentialRef: str.optional()
    }),
    defaults: { url: 'https://example.com', method: 'GET', headers: {}, body: '' }
  },
  {
    id: 'notification',
    name: 'Show notification',
    group: 'Developer',
    icon: '♧',
    capability: 'desktop',
    schema: z.object({ title: str, body: str }),
    defaults: { title: 'Decker', body: 'Workflow complete' }
  },
  {
    id: 'clipboard',
    name: 'Copy text',
    group: 'Developer',
    icon: '▤',
    capability: 'desktop',
    schema: z.object({ text: str }),
    defaults: { text: 'Hello' }
  },
  {
    id: 'shortcut',
    name: 'Send shortcut',
    group: 'Desktop',
    icon: '⌨',
    capability: 'keyboard',
    schema: z.object({ keys: str.regex(/^[\w+ -]+$/) }),
    defaults: { keys: 'ctrl+alt+t' }
  },
  {
    id: 'type',
    name: 'Type text',
    group: 'Desktop',
    icon: 'Aa',
    capability: 'keyboard',
    schema: z.object({ text: str }),
    defaults: { text: 'Hello' }
  },
  {
    id: 'media',
    name: 'Media control',
    group: 'Desktop',
    icon: '▶',
    capability: 'media',
    schema: z.object({
      operation: z.enum(['PlayPause', 'Play', 'Pause', 'Next', 'Previous', 'Stop']),
      player: str.default('')
    }),
    defaults: { operation: 'PlayPause', player: '' }
  },
  {
    id: 'audio',
    name: 'Audio control',
    group: 'Desktop',
    icon: '♫',
    capability: 'audio',
    schema: z.object({
      operation: z.enum(['volume', 'mute', 'device']),
      target: z.enum(['sink', 'source']),
      value: json,
      device: str.default('')
    }),
    defaults: { operation: 'mute', target: 'source', value: true, device: '' }
  },
  {
    id: 'obs',
    name: 'OBS control',
    group: 'Streaming',
    icon: '◉',
    capability: 'obs',
    schema: z.object({
      connection: str,
      request: z.enum([
        'SetCurrentProgramScene',
        'SetSceneItemEnabled',
        'SetInputMute',
        'StartRecord',
        'StopRecord',
        'StartStream',
        'StopStream'
      ]),
      data: record.default({})
    }),
    defaults: { connection: '', request: 'SetCurrentProgramScene', data: { sceneName: 'Main' } }
  },
  {
    id: 'profile',
    name: 'Change profile',
    group: 'Deck',
    icon: '◫',
    capability: 'deck',
    schema: z.object({ profileId: str }),
    defaults: { profileId: 'profile-default' }
  },
  {
    id: 'page',
    name: 'Open page / folder',
    group: 'Deck',
    icon: '▣',
    capability: 'deck',
    schema: z.object({ pageId: str }),
    defaults: { pageId: 'page-home' }
  },
  {
    id: 'back',
    name: 'Leave folder',
    group: 'Deck',
    icon: '←',
    capability: 'deck',
    schema: z.object({}),
    defaults: {}
  },
  {
    id: 'brightness',
    name: 'Set brightness',
    group: 'Deck',
    icon: '☀',
    capability: 'deck',
    schema: z.object({ value: z.number().int().min(0).max(100) }),
    defaults: { value: 70 }
  },
  {
    id: 'appearance',
    name: 'Change key appearance',
    group: 'Deck',
    icon: '✦',
    capability: 'deck',
    schema: z.object({
      index: z.number().int().min(0).max(127),
      label: str.optional(),
      icon: str.optional(),
      background: z
        .string()
        .regex(/^#[\da-fA-F]{6}$/)
        .optional()
    }),
    defaults: { index: 0, label: 'Ready', background: '#23865e' }
  },
  {
    id: 'workflow',
    name: 'Run workflow',
    group: 'Deck',
    icon: '⑂',
    capability: 'deck',
    schema: z.object({ workflowId: str, input: record.default({}) }),
    defaults: { workflowId: 'flow-focus', input: {} }
  },
  {
    id: 'cancel',
    name: 'Cancel workflow',
    group: 'Deck',
    icon: '■',
    capability: 'deck',
    schema: z.object({ workflowId: str }),
    defaults: { workflowId: 'flow-focus' }
  }
] as const
export const definitions = catalog.map((definition) => ({
  ...definition,
  version: 1 as const,
  inputSchema: z.record(z.string(), json),
  outputSchema: json
}))
export function validateAction(action: Action): Action {
  const d = definitions.find((d) => d.id === action.type)
  if (!d || action.version !== 1) throw new Error(`Unknown action/version: ${action.type}`)
  return { ...action, config: d.schema.parse(action.config) }
}
export const flowKinds = [
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
] as const
export function nodeDefaults(kind: string): Record<string, import('./schema').Json> {
  switch (kind) {
    case 'delay':
      return { ms: 1000 }
    case 'condition':
      return { left: '{{inputs.ready}}', operator: 'equals', right: true }
    case 'switch':
      return { value: '{{inputs.choice}}' }
    case 'set':
      return { values: { message: 'Hello' } }
    case 'parallel':
      return { mode: 'fail-fast' }
    case 'repeat':
      return { count: 3, maxIterations: 100, concurrency: 1 }
    case 'foreach':
      return { items: [1, 2, 3], maxIterations: 100, concurrency: 1 }
    case 'subflow':
      return { workflowId: '', revision: 1, input: {} }
    case 'return':
      return { value: '{{vars}}' }
    default:
      return {}
  }
}
