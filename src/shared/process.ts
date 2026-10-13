import { z } from 'zod'
import { configSchema, json, bindingSchema } from './schema'
export const workerMessage = z.discriminatedUnion('type', [
  z.object({ type: z.literal('config'), config: configSchema, assets: z.string().optional() }),
  z.object({
    type: z.literal('run'),
    requestId: z.string(),
    workflowId: z.string(),
    input: z.record(z.string(), json).default({})
  }),
  z.object({
    type: z.literal('binding'),
    binding: bindingSchema,
    event: z.enum(['press', 'release', 'long']),
    generation: z.number().int().optional()
  }),
  z.object({ type: z.literal('cancel'), id: z.string() }),
  z.object({ type: z.literal('cancelWorkflow'), id: z.string() }),
  z.object({
    type: z.literal('reply'),
    id: z.string(),
    value: json.optional(),
    error: z.string().optional()
  }),
  z.object({
    type: z.literal('feedback'),
    index: z.number().int().min(0).max(127),
    status: z.string()
  }),
  z.object({ type: z.literal('observed'), value: z.record(z.string(), json) }),
  z.object({ type: z.literal('stop') })
])
export type WorkerMessage = z.infer<typeof workerMessage>
