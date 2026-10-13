import { lazy, Suspense, useEffect } from 'react'
import {
  Grid2X2,
  GitBranch,
  History,
  Settings as SettingsIcon,
  Save,
  Radio,
  Command
} from 'lucide-react'
import { Deck } from './Deck'
const Flows = lazy(() => import('./Flows').then((module) => ({ default: module.Flows })))
import { Runs } from './Runs'
import { Settings } from './Settings'
import { useStore } from './store'
const screens = [
  { id: 'deck', name: 'Deck', icon: Grid2X2, description: 'Keys & actions' },
  { id: 'flows', name: 'Flows', icon: GitBranch, description: 'Visual automation' },
  { id: 'runs', name: 'Runs', icon: History, description: 'Execution history' },
  { id: 'settings', name: 'Settings', icon: SettingsIcon, description: 'Make it yours' }
] as const
export function App() {
  const { draft, state, view, dirty, error, setView, save, init, notify } = useStore()
  useEffect(() => {
    let dispose: (() => void) | undefined,
      cancelled = false
    void init()
      .then((fn) => {
        if (cancelled) fn()
        else dispose = fn
      })
      .catch(notify)
    return () => {
      cancelled = true
      dispose?.()
    }
  }, [init, notify])
  useEffect(() => {
    if (!draft) return
    document.documentElement.style.setProperty('--accent', draft.settings.accent)
    const hex = draft.settings.accent
    const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16))
    const luminance = [r, g, b]
      .map((v) => {
        const s = v / 255
        return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4
      })
      .reduce((v, x, i) => v + x * [0.2126, 0.7152, 0.0722][i], 0)
    document.documentElement.style.setProperty(
      '--on-accent',
      luminance > 0.4 ? '#111214' : '#ffffff'
    )
  }, [draft?.settings.accent])
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key === 's') {
        e.preventDefault()
        void save()
      }
    }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [save])
  return (
    <div className="app">
      <nav className="server-rail" aria-label="Workspace">
        <button
          className="server-icon active"
          aria-label="Decker home"
          onClick={() => setView('deck')}
        >
          <Command size={26} />
        </button>
        <div className="rail-divider" />
        {screens.map((s) => (
          <button
            key={s.id}
            className={`rail-icon ${view === s.id ? 'active' : ''}`}
            title={s.name}
            aria-label={`${s.name} navigation`}
            onClick={() => setView(s.id)}
          >
            <s.icon size={22} />
          </button>
        ))}
        <div className="rail-bottom">
          <Radio size={20} />
        </div>
      </nav>
      <aside className="sidebar">
        <div className="workspace-name">
          Decker <span className="badge">LOCAL</span>
        </div>
        <div className="sidebar-content">
          <div className="section-label">STUDIO</div>
          {screens.map((s) => (
            <button
              key={s.id}
              className={`nav-item ${view === s.id ? 'active' : ''}`}
              onClick={() => setView(s.id)}
            >
              <s.icon size={20} />
              <div>
                <strong>{s.name}</strong>
                <small>{s.description}</small>
              </div>
            </button>
          ))}
          <div className="sidebar-callout">
            <span>✦</span>
            <strong>Small keys. Big possibilities.</strong>
            <p>Your everyday tools, connected in one place.</p>
          </div>
        </div>
        <div className="user-bar">
          <span className="avatar">D</span>
          <div>
            <strong>Local workspace</strong>
            <small>
              {state?.devices.some((d) => d.connected && !d.simulated)
                ? 'Deck connected'
                : 'Simulator ready'}
            </small>
          </div>
          <button
            aria-label="Open settings"
            className="icon-button push"
            onClick={() => setView('settings')}
          >
            <SettingsIcon size={18} />
          </button>
        </div>
      </aside>
      <main className="main">
        <header className="topbar">
          <span className="channel-hash">#</span>
          <strong>{screens.find((s) => s.id === view)?.name.toLowerCase()}</strong>
          <span className="topbar-divider" />
          <span className="muted">{screens.find((s) => s.id === view)?.description}</span>
          <span className="save-status push">
            {dirty ? 'Unsaved changes' : 'All changes saved'}
          </span>
          <button
            className={dirty ? 'primary' : 'secondary'}
            disabled={!dirty}
            onClick={() => void save()}
          >
            <Save size={15} />
            Save changes
          </button>
        </header>
        {error && (
          <div className="error-banner" role="alert">
            {error}
            <button
              aria-label="Dismiss error"
              className="push"
              onClick={() => useStore.setState({ error: '' })}
            >
              ×
            </button>
          </div>
        )}
        {state?.observed.storage && (
          <div className="error-banner">
            Configuration storage: {JSON.stringify(state.observed.storage)}
          </div>
        )}
        {!draft ? (
          <div className="empty-state">Starting your studio…</div>
        ) : view === 'deck' ? (
          <Deck />
        ) : view === 'flows' ? (
          <Suspense fallback={<div className="empty-state">Loading workflow studio…</div>}>
            <Flows />
          </Suspense>
        ) : view === 'runs' ? (
          <Runs />
        ) : (
          <Settings />
        )}
      </main>
    </div>
  )
}
