import { contextBridge, ipcRenderer } from 'electron'
import type { API, State } from '../shared/schema'
const api: API = {
  state: () => ipcRenderer.invoke('state'),
  save: (config) => ipcRenderer.invoke('save', config),
  press: (index, event = 'test') => ipcRenderer.invoke('press', index, event),
  run: (id, input = {}) => ipcRenderer.invoke('run', id, input),
  cancel: (id) => ipcRenderer.invoke('cancel', id),
  export: () => ipcRenderer.invoke('export'),
  import: (text) => ipcRenderer.invoke('import', text),
  credential: (id, value, persist) => ipcRenderer.invoke('credential', id, value, persist),
  image: (data) => ipcRenderer.invoke('image', data),
  quit: () => ipcRenderer.invoke('quit'),
  subscribe: (listener) => {
    const wrapped = (_: unknown, state: State) => listener(state)
    ipcRenderer.on('state:update', wrapped)
    return () => ipcRenderer.removeListener('state:update', wrapped)
  }
}
contextBridge.exposeInMainWorld('decker', api)
