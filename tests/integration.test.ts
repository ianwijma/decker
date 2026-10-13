import { it, expect } from 'vitest'
import { mkdtemp, readFile, writeFile, rm, access } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { Storage } from '../src/main/storage'
import { defaultConfig, bindingSchema, workflowSchema, nodeSchema } from '../src/shared/schema'
import { command } from '../src/adapters/linux'
import { execute } from '../src/runtime/engine'
import { delay } from '../src/runtime/data'
import { observedBinding } from '../src/shared/observed'
import { handlers } from '../src/actions/handlers'
import { createServer } from 'node:http'
it('persists configuration atomically, backs up invalid documents and interrupts active history', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'decker-storage-'))
  try {
    const storage = new Storage(directory),
      config = defaultConfig()
    await storage.save(config, [
      {
        id: 'active',
        workflowId: 'flow-focus',
        name: 'test',
        revision: 1,
        status: 'running',
        startedAt: 1,
        nodes: []
      }
    ])
    config.settings.accent = '#eb459e'
    await storage.save(config, [])
    expect(
      JSON.parse(await readFile(join(directory, 'config.backup.json'), 'utf8')).settings.accent
    ).toBe('#5865f2')
    const restored = await storage.load()
    expect(restored.config.settings.accent).toBe('#eb459e')
    await storage.save(config, [
      {
        id: 'active',
        workflowId: 'flow-focus',
        name: 'test',
        revision: 1,
        status: 'running',
        startedAt: 1,
        nodes: []
      }
    ])
    expect((await storage.load()).runs[0].status).toBe('interrupted')
    await writeFile(
      join(directory, 'config.json'),
      JSON.stringify({ ...config, schemaVersion: 999 })
    )
    await expect(storage.load()).rejects.toThrow('backup')
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})
it('cancels a shell process group before grandchildren perform later side effects', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'decker-process-')),
    marker = join(directory, 'leak')
  try {
    const controller = new AbortController()
    const pending = command(
      '/bin/sh',
      ['-c', '(sleep 0.3; printf leak > "$1") & wait', 'sh', marker],
      controller.signal
    )
    await delay(40, new AbortController().signal)
    controller.abort(new Error('Cancelled'))
    await expect(pending).rejects.toThrow('Cancelled')
    await delay(400, new AbortController().signal)
    await expect(access(marker)).rejects.toThrow()
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})
it('bounds cleanup for a handler that never settles', async () => {
  const f = workflowSchema.parse({
    id: 'bounded',
    name: 'bounded',
    revision: 1,
    timeoutMs: 5,
    nodes: [
      nodeSchema.parse({ id: 'start', label: 'start', kind: 'trigger', position: { x: 0, y: 0 } }),
      nodeSchema.parse({
        id: 'hang',
        label: 'hang',
        kind: 'action',
        action: { type: 'clipboard', config: { text: 'x' } },
        position: { x: 0, y: 0 }
      })
    ],
    edges: [{ id: 'e', source: 'start', target: 'hang' }]
  })
  const started = Date.now(),
    r = await execute(f, [f], async () => new Promise(() => {})).done
  expect(r.status).toBe('error')
  expect(Date.now() - started).toBeLessThan(2000)
})
it('observed mute and OBS feedback follows external state rather than presses', () => {
  const b = bindingSchema.parse({
    id: 'mic',
    appearance: { label: 'Microphone' },
    actions: [{ type: 'audio', config: { operation: 'mute', target: 'source', value: true } }]
  })
  expect(observedBinding(b, { 'audio:source': { muted: true } })?.appearance.label).toBe('Muted')
  expect(observedBinding(b, { 'audio:source': { muted: false } })?.appearance.label).toBe('Unmuted')
  b.actions = [
    {
      type: 'obs',
      version: 1,
      config: {
        connection: 'local',
        request: 'SetCurrentProgramScene',
        data: { sceneName: 'Main' }
      }
    }
  ]
  expect(observedBinding(b, { local: { connected: true, scene: 'Main' } })?.appearance.label).toBe(
    'Scene active'
  )
})
it('HTTP actions return structured results, bound responses and propagate aborts', async () => {
  const server = createServer((request, response) => {
    if (request.url === '/large') {
      response.end('x'.repeat(70000))
      return
    }
    if (request.url === '/slow') {
      const timer = setTimeout(() => response.end('late'), 5000)
      request.on('close', () => clearTimeout(timer))
      return
    }
    response.setHeader('Content-Type', 'application/json')
    response.end(JSON.stringify({ ready: true }))
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  try {
    const port = (server.address() as { port: number }).port,
      { handler, obs } = handlers(
        defaultConfig,
        async () => null,
        () => {}
      ),
      context = { runId: 'test', workflow: async () => null }
    const action = (path: string) => ({
      type: 'http',
      version: 1 as const,
      config: { url: `http://127.0.0.1:${port}${path}`, method: 'GET' }
    })
    expect(await handler(action('/'), new AbortController().signal, context)).toEqual({
      status: 200,
      ok: true,
      data: { ready: true }
    })
    await expect(handler(action('/large'), new AbortController().signal, context)).rejects.toThrow(
      '64 KiB'
    )
    await expect(handler(action('/slow'), AbortSignal.timeout(10), context)).rejects.toThrow()
    await obs.close()
  } finally {
    server.closeAllConnections()
    await new Promise<void>((resolve) => server.close(() => resolve()))
  }
})

it('exports configuration without inline HTTP authentication or connection credentials', async () => {
  const { exportConfig } = await import('../src/shared/export')
  const config = defaultConfig()
  config.connections = [
    { id: 'obs', name: 'obs', url: 'ws://localhost:4455', credentialRef: 'password' }
  ]
  config.profiles[0].pages[0].keys['1'].actions = [
    {
      type: 'http',
      version: 1,
      config: {
        url: 'https://example.com?token=private',
        headers: { Authorization: 'Bearer secret-value' }
      }
    }
  ]
  const exported = JSON.stringify(exportConfig(config))
  expect(exported).not.toContain('secret-value')
  expect(exported).not.toContain('token=private')
  expect(exported).not.toContain('credentialRef')
})

it('recovers damaged history without losing valid configuration and backs up malformed configuration JSON', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'decker-recovery-'))
  try {
    const storage = new Storage(directory),
      config = defaultConfig()
    config.settings.accent = '#eb459e'
    await storage.save(config, [])
    await writeFile(join(directory, 'runs.json'), '{broken')
    expect((await storage.load()).config.settings.accent).toBe('#eb459e')
    await writeFile(join(directory, 'config.json'), '{broken')
    await expect(storage.load()).rejects.toThrow('backup')
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})
