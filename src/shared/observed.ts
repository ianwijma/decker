import type { Binding, Json } from './schema'
export function observedBinding(
  binding: Binding | undefined,
  observed: Record<string, Json>
): Binding | undefined {
  if (!binding) return binding
  const action = binding.actions[0]
  if (!action) return binding
  const c = action.config
  let label: string | undefined,
    active = false
  const object = (id: string) => {
    const value = observed[id]
    return value && typeof value === 'object' && !Array.isArray(value) ? value : {}
  }
  if (action.type === 'audio') {
    const state = object(`audio:${c.target}`)
    if (typeof state.muted === 'boolean') {
      label = state.muted ? 'Muted' : 'Unmuted'
      active = state.muted
    } else if (state.available === false) label = 'Audio offline'
  }
  if (action.type === 'media') {
    const state = object(`media:${String(c.player ?? '')}`)
    if (typeof state.playback === 'string') {
      label = state.playback
      active = state.playback === 'Playing'
    } else if (state.available === false) label = 'No player'
  }
  if (action.type === 'obs') {
    const state = object(String(c.connection)),
      data = c.data && typeof c.data === 'object' && !Array.isArray(c.data) ? c.data : {}
    if (state.connected === false) label = 'OBS offline'
    else if (c.request === 'SetCurrentProgramScene' && typeof state.scene === 'string') {
      active = state.scene === data.sceneName
      label = active ? 'Scene active' : binding.appearance.label
    } else if (c.request === 'SetInputMute') {
      const input = object(`${c.connection}:${data.inputName}`)
      if (typeof input.muted === 'boolean') {
        active = input.muted
        label = active ? 'Muted' : 'Unmuted'
      }
    } else if (String(c.request).endsWith('Record') || String(c.request).endsWith('Stream')) {
      const output = object(
        `${c.connection}:${String(c.request).endsWith('Record') ? 'record' : 'stream'}`
      )
      if (typeof output.active === 'boolean') {
        active = output.active
        label = active ? 'Live' : 'Stopped'
      }
    } else if (c.request === 'SetSceneItemEnabled') {
      const item = object(`${c.connection}:source:${data.sceneName}:${data.sceneItemId}`)
      if (typeof item.enabled === 'boolean') {
        active = item.enabled
        label = active ? 'Visible' : 'Hidden'
      }
    }
  }
  if (!label) return binding
  return {
    ...binding,
    appearance: {
      ...binding.appearance,
      label: label,
      ...(active ? { background: '#23865e' } : {})
    }
  }
}
