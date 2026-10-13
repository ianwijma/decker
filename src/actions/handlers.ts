import type { Action, Config, Json } from '../shared/schema'
import { validateAction } from '../shared/catalog'
import { command, locks, audio, media, launch } from '../adapters/linux'
import { OBSConnections } from '../integrations/obs'
import { abortError } from '../runtime/data'
import type { Handler } from '../runtime/engine'
export function handlers(
  getConfig: () => Config,
  bridge: (type: string, data: Record<string, Json>) => Promise<Json>,
  observed: (id: string, value: Json) => void
): { handler: Handler; obs: OBSConnections } {
  const obs = new OBSConnections(observed, async (ref) =>
    String(await bridge('credential', { ref }))
  )
  const handler: Handler = async (a: Action, signal, context) => {
    a = validateAction(a)
    abortError(signal)
    const c = a.config
    switch (a.type) {
      case 'command':
      case 'shell':
        return locks.use(String(c.resource || 'commands'), signal, () =>
          a.type === 'shell'
            ? command('/bin/sh', ['-c', String(c.script)], signal)
            : command(String(c.executable), (c.args ?? []) as string[], signal)
        )
      case 'launch':
        return launch(
          c.desktopEntry ? 'gtk-launch' : String(c.executable),
          c.desktopEntry
            ? [String(c.executable), ...((c.args ?? []) as string[])]
            : ((c.args ?? []) as string[]),
          signal
        )
      case 'shortcut':
      case 'type':
        return locks.use('keyboard', signal, async () => {
          if (process.env.XDG_SESSION_TYPE === 'wayland')
            throw new Error('Keyboard injection requires X11; Wayland is unsupported')
          return command(
            'xdotool',
            a.type === 'type'
              ? ['type', '--clearmodifiers', '--', String(c.text)]
              : ['key', '--clearmodifiers', String(c.keys)],
            signal
          )
        })
      case 'audio': {
        const result = await audio(c, signal)
        observed(`audio:${c.target}`, result)
        return result
      }
      case 'media': {
        const result = await media(c, signal)
        observed('media', result)
        return result
      }
      case 'http': {
        const url = new URL(String(c.url))
        if (!['http:', 'https:'].includes(url.protocol))
          throw new Error('Only HTTP(S) requests are supported')
        const headers = { ...((c.headers ?? {}) as Record<string, string>) }
        if (c.credentialRef)
          headers.Authorization = `Bearer ${String(await bridge('credential', { ref: c.credentialRef }))}`
        const response = await fetch(url, {
          method: String(c.method || 'GET'),
          headers,
          body: c.method === 'GET' ? undefined : String(c.body || ''),
          signal
        })
        const reader = response.body?.getReader()
        let body = '',
          bytes = 0
        const decoder = new TextDecoder()
        try {
          while (reader) {
            const chunk = await reader.read()
            if (chunk.done) break
            bytes += chunk.value.byteLength
            if (bytes > 65536) throw new Error('HTTP response exceeds 64 KiB')
            body += decoder.decode(chunk.value, { stream: true })
          }
        } finally {
          await reader?.cancel()
        }
        body += decoder.decode()
        let data: Json = body
        try {
          data = JSON.parse(body)
        } catch {}
        return { status: response.status, ok: response.ok, data }
      }
      case 'obs': {
        const connection = getConfig().connections.find((x) => x.id === c.connection)
        if (!connection) throw new Error('Select an OBS connection in Settings')
        return obs.call(
          connection,
          String(c.request),
          (c.data ?? {}) as Record<string, Json>,
          signal
        )
      }
      case 'workflow':
        return context.workflow(String(c.workflowId), (c.input ?? {}) as Record<string, Json>)
      default:
        return bridge(a.type, { ...c, runId: context.runId, bindingId: context.bindingId ?? '' })
    }
  }
  return { handler, obs }
}
