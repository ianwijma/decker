import { create } from 'zustand'
import type { API, Config, State } from '../shared/schema'
declare global {
  interface Window {
    decker: API
  }
}
interface Store {
  state?: State
  draft?: Config
  dirty: boolean
  error: string
  view: 'deck' | 'flows' | 'runs' | 'settings'
  selected: number
  setView(view: Store['view']): void
  update(fn: (config: Config) => void): void
  save(): Promise<void>
  init(): Promise<() => void>
  notify(error: unknown): void
}
export const useStore = create<Store>((set, get) => ({
  dirty: false,
  error: '',
  view: 'deck',
  selected: 0,
  setView: (view) => set({ view, error: '' }),
  update: (fn) => {
    const draft = structuredClone(get().draft!)
    fn(draft)
    set({ draft, dirty: true, error: '' })
  },
  save: async () => {
    try {
      await window.decker.save(get().draft!)
      set({ dirty: false, error: '' })
    } catch (e) {
      set({ error: String(e) })
    }
  },
  notify: (error) => set({ error: String(error) }),
  init: async () => {
    const state = await window.decker.state()
    set({ state, draft: state.config })
    return window.decker.subscribe((state) =>
      set((current) => ({ state, ...(!current.dirty ? { draft: state.config } : {}) }))
    )
  }
}))
export function perform(fn: () => Promise<unknown>): void {
  void fn().catch(useStore.getState().notify)
}
