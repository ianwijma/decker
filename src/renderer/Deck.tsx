import { observedBinding } from '../shared/observed'
import { useState } from 'react'
import { Copy, ClipboardPaste, Play, Trash2, Plus, ArrowLeft } from 'lucide-react'
import { bindingSchema, uid, type Binding } from '../shared/schema'
import { useStore, perform } from './store'
import { ActionEditor, Catalog, newAction } from './components'
export function Deck() {
  const { draft: c, state, selected, update } = useStore(),
    [copied, setCopied] = useState<Binding>(),
    [tab, setTab] = useState<'actions' | 'release' | 'longPress'>('actions')
  if (!c) return null
  const profile = c.profiles.find((p) => p.id === c.activeProfile)!,
    page = profile.pages.find((p) => p.id === c.activePage)!,
    key = page.keys[String(selected)]
  const device =
    state?.devices.find((d) => d.id === c.settings.deviceSerial) ||
    state?.devices.find((d) => d.simulated) ||
    state?.devices.find((d) => d.connected)
  const edit = (fn: (b: Binding) => void) =>
    update((c) => {
      const p = c.profiles
        .find((p) => p.id === c.activeProfile)!
        .pages.find((p) => p.id === c.activePage)!
      p.keys[String(selected)] ??= bindingSchema.parse({
        id: uid(),
        appearance: { label: 'New action', icon: '✦' }
      })
      fn(p.keys[String(selected)])
    })
  const add = (type: string, index = selected) =>
    update((c) => {
      const p = c.profiles
        .find((p) => p.id === c.activeProfile)!
        .pages.find((p) => p.id === c.activePage)!
      p.keys[String(index)] ??= bindingSchema.parse({
        id: uid(),
        appearance: { label: newAction(type).type, icon: '✦' }
      })
      p.keys[String(index)].actions.push(newAction(type))
    })
  const switchPage = (id: string) =>
    update((c) => {
      c.activePage = id
    })
  return (
    <div className="deck-layout">
      <section className="deck-center">
        <div className="page-heading">
          <div>
            <div className="eyebrow">YOUR WORKSPACE, AT A TOUCH</div>
            <h1>Make every key yours.</h1>
            <p className="muted">
              Build shortcuts, launch your tools, and turn routines into flows.
            </p>
          </div>
          <span className="badge">
            {device?.simulated ? 'SIMULATOR' : device?.connected ? 'CONNECTED' : 'OFFLINE'}
          </span>
        </div>
        <div className="deck-toolbar">
          <label>
            Profile
            <select
              aria-label="Profile"
              value={c.activeProfile}
              onChange={(e) =>
                update((c) => {
                  c.activeProfile = e.target.value
                  c.activePage = c.profiles.find((p) => p.id === e.target.value)!.pages[0].id
                })
              }
            >
              {c.profiles.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </select>
          </label>
          <button
            className="icon-button"
            title="Add profile"
            aria-label="Add profile"
            onClick={() =>
              update((c) => {
                const id = uid(),
                  page = uid()
                c.profiles.push({
                  id,
                  name: 'New profile',
                  pages: [{ id: page, name: 'Home', keys: {} }]
                })
                c.activeProfile = id
                c.activePage = page
              })
            }
          >
            <Plus size={16} />
          </button>
          <label>
            Device
            <select
              aria-label="Device"
              value={c.settings.deviceSerial || 'auto'}
              onChange={(e) =>
                update((c) => {
                  c.settings.deviceSerial = e.target.value === 'auto' ? '' : e.target.value
                })
              }
            >
              <option value="auto">{device?.name ?? 'Stream Deck XL simulator'}</option>
              {state?.devices
                .filter((d) => !d.simulated && !d.id.startsWith('session:'))
                .map((d) => (
                  <option value={d.id} key={d.id}>
                    {d.name} · {d.id}
                  </option>
                ))}
            </select>
          </label>
        </div>
        <div className="deck-hardware">
          <div
            className="deck-keys"
            style={{ gridTemplateColumns: `repeat(${device?.columns ?? 8},1fr)` }}
          >
            {Array.from({ length: (device?.rows ?? 4) * (device?.columns ?? 8) }, (_, i) => {
              const b = observedBinding(page.keys[String(i)], state?.observed ?? {}),
                run = state?.runs.find((r) => r.bindingId === b?.id),
                running = run?.status === 'running'
              return (
                <button
                  key={i}
                  aria-label={`Key ${i + 1}${b ? ': ' + b.appearance.label : ''}`}
                  className={`deck-key ${selected === i ? 'selected' : ''} ${running ? 'running' : ''}`}
                  style={b ? { background: b.appearance.background } : undefined}
                  onClick={() => useStore.setState({ selected: i })}
                  onDoubleClick={() => perform(() => window.decker.press(i))}
                  onDragOver={(e) => e.preventDefault()}
                  onDrop={(e) => {
                    e.preventDefault()
                    const type = e.dataTransfer.getData('decker/action')
                    if (type) add(type, i)
                  }}
                >
                  <span className="key-number">{String(i + 1).padStart(2, '0')}</span>
                  {b ? (
                    <>
                      {b.appearance.asset && (
                        <img
                          className="key-image"
                          alt=""
                          src={`decker-asset://${b.appearance.asset}`}
                        />
                      )}
                      <span className="key-icon">{b.appearance.icon}</span>
                      <span className="key-label">{b.appearance.label}</span>
                      <span className={`key-status ${run?.status ?? ''}`} />
                    </>
                  ) : (
                    <span className="empty-plus">+</span>
                  )}
                </button>
              )
            })}
          </div>
          <div className="deck-brand">
            DECKER <span>STREAM DECK {device?.columns === 8 ? 'XL' : ''}</span>
          </div>
        </div>
        <div className="page-tabs">
          {page.parentId && (
            <button aria-label="Back to parent page" onClick={() => switchPage(page.parentId!)}>
              <ArrowLeft size={15} />
            </button>
          )}
          {profile.pages.map((p) => (
            <button
              key={p.id}
              className={p.id === page.id ? 'active' : ''}
              onClick={() => switchPage(p.id)}
            >
              {p.parentId ? '▣ ' : ''}
              {p.name}
            </button>
          ))}
          <button
            aria-label="Add page"
            onClick={() =>
              update((c) => {
                const p = c.profiles.find((p) => p.id === c.activeProfile)!
                const id = uid()
                p.pages.push({ id, name: `Page ${p.pages.length + 1}`, keys: {} })
                c.activePage = id
              })
            }
          >
            <Plus size={16} />
          </button>
        </div>
        <div className="hint">
          Drag an action onto a key. Double-click a key to test its saved binding.
        </div>
        <div className="workspace-card">
          <span className="feature-icon">⑂</span>
          <div>
            <strong>A little less repetitive.</strong>
            <p className="muted">
              One key can run a sequence, branch on a result, or bring an entire workflow to life.
            </p>
          </div>
          <button className="secondary push" onClick={() => useStore.getState().setView('flows')}>
            Explore flows →
          </button>
        </div>
        <details className="page-management">
          <summary>Manage profile & page</summary>
          <label className="field">
            Profile name
            <input
              value={profile.name}
              onChange={(e) =>
                update((c) => {
                  c.profiles.find((p) => p.id === profile.id)!.name = e.target.value
                })
              }
            />
          </label>
          <label className="field">
            Page name
            <input
              value={page.name}
              onChange={(e) =>
                update((c) => {
                  c.profiles
                    .find((p) => p.id === profile.id)!
                    .pages.find((p) => p.id === page.id)!.name = e.target.value
                })
              }
            />
          </label>
          <label className="field">
            Folder parent
            <select
              value={page.parentId ?? ''}
              onChange={(e) =>
                update((c) => {
                  c.profiles
                    .find((p) => p.id === profile.id)!
                    .pages.find((p) => p.id === page.id)!.parentId = e.target.value || undefined
                })
              }
            >
              <option value="">Top-level page</option>
              {profile.pages
                .filter((p) => p.id !== page.id)
                .map((p) => (
                  <option value={p.id} key={p.id}>
                    {p.name}
                  </option>
                ))}
            </select>
          </label>
          <button
            className="danger"
            disabled={profile.pages.length === 1}
            onClick={() =>
              update((c) => {
                const p = c.profiles.find((p) => p.id === profile.id)!
                p.pages = p.pages.filter((pg) => pg.id !== page.id)
                for (const pg of p.pages) if (pg.parentId === page.id) pg.parentId = undefined
                c.activePage = p.pages[0].id
              })
            }
          >
            Delete page
          </button>
          <button
            className="danger"
            disabled={c.profiles.length === 1}
            onClick={() =>
              update((c) => {
                c.profiles = c.profiles.filter((p) => p.id !== profile.id)
                c.activeProfile = c.profiles[0].id
                c.activePage = c.profiles[0].pages[0].id
              })
            }
          >
            Delete profile
          </button>
        </details>
      </section>
      <aside className="properties">
        <div className="section-label">
          KEY PROPERTIES <span className="muted push">{String(selected + 1).padStart(2, '0')}</span>
        </div>
        <div className="row tools">
          <button
            aria-label="Copy key"
            disabled={!key}
            onClick={() => setCopied(structuredClone(key))}
          >
            <Copy size={16} />
          </button>
          <button
            aria-label="Paste key"
            disabled={!copied}
            onClick={() =>
              edit((b) => Object.assign(b, { ...structuredClone(copied!), id: uid() }))
            }
          >
            <ClipboardPaste size={16} />
          </button>
          <button
            aria-label="Duplicate key"
            disabled={!key}
            onClick={() =>
              update((c) => {
                const p = c.profiles
                  .find((p) => p.id === c.activeProfile)!
                  .pages.find((p) => p.id === c.activePage)!
                const empty = Array.from({ length: 32 }, (_, i) => i).find((i) => !p.keys[i])
                if (empty !== undefined) p.keys[empty] = { ...structuredClone(key), id: uid() }
              })
            }
          >
            <Copy size={16} />+
          </button>
          <button
            aria-label="Clear key"
            disabled={!key}
            onClick={() =>
              update((c) => {
                delete c.profiles
                  .find((p) => p.id === c.activeProfile)!
                  .pages.find((p) => p.id === c.activePage)!.keys[String(selected)]
              })
            }
          >
            <Trash2 size={16} />
          </button>
        </div>
        {key ? (
          <>
            <label className="field">
              Label
              <input
                aria-label="Key label"
                value={key.appearance.label}
                onChange={(e) =>
                  edit((b) => {
                    b.appearance.label = e.target.value
                  })
                }
              />
            </label>
            <div className="row">
              <label className="field grow">
                Icon
                <input
                  value={key.appearance.icon}
                  onChange={(e) =>
                    edit((b) => {
                      b.appearance.icon = e.target.value
                    })
                  }
                />
              </label>
              <label className="field">
                Background
                <input
                  type="color"
                  value={key.appearance.background}
                  onChange={(e) =>
                    edit((b) => {
                      b.appearance.background = e.target.value
                    })
                  }
                />
              </label>
            </div>
            <label className="field">
              Image
              <input
                type="file"
                accept="image/*"
                onChange={(e) => {
                  const file = e.target.files?.[0]
                  if (file)
                    perform(async () => {
                      const data = await file.arrayBuffer()
                      const hash = await window.decker.image(
                        btoa(
                          Array.from(new Uint8Array(data), (byte) =>
                            String.fromCharCode(byte)
                          ).join('')
                        )
                      )
                      edit((b) => {
                        b.appearance.asset = hash
                      })
                    })
                }}
              />
            </label>
            <label className="check">
              <input
                type="checkbox"
                checked={key.enabled}
                onChange={(e) =>
                  edit((b) => {
                    b.enabled = e.target.checked
                  })
                }
              />
              Binding enabled (review imported commands first)
            </label>
            <label className="field">
              Repeated press
              <select
                value={key.policy}
                onChange={(e) =>
                  edit((b) => {
                    b.policy = e.target.value as Binding['policy']
                  })
                }
              >
                <option value="ignore">Ignore while running</option>
                <option value="queue">Bounded FIFO queue</option>
                <option value="restart">Cancel and restart</option>
                <option value="concurrent">Bounded concurrent runs</option>
              </select>
            </label>
            {key.policy !== 'ignore' && (
              <label className="field">
                Queue / concurrency limit
                <input
                  type="number"
                  min="1"
                  max="16"
                  value={key.limit}
                  onChange={(e) =>
                    edit((b) => {
                      b.limit = Number(e.target.value)
                    })
                  }
                />
              </label>
            )}
            <label className="field">
              Named workflow
              <select
                value={key.workflowId ?? ''}
                onChange={(e) =>
                  edit((b) => {
                    b.workflowId = e.target.value || undefined
                  })
                }
              >
                <option value="">Direct action / multi-action</option>
                {c.workflows.map((w) => (
                  <option key={w.id} value={w.id}>
                    {w.name}
                  </option>
                ))}
              </select>
            </label>
            <div className="small-tabs">
              {(['actions', 'release', 'longPress'] as const).map((t) => (
                <button key={t} className={tab === t ? 'active' : ''} onClick={() => setTab(t)}>
                  {t === 'actions' ? 'Press' : t === 'release' ? 'Release' : 'Long press'}
                </button>
              ))}
            </div>
            {tab === 'longPress' && (
              <label className="field">
                Long-press threshold (ms)
                <input
                  type="number"
                  value={key.longPressMs}
                  onChange={(e) =>
                    edit((b) => {
                      b.longPressMs = Number(e.target.value)
                    })
                  }
                />
              </label>
            )}
            {key[tab].map((a, i) => (
              <ActionEditor
                key={`${tab}-${i}-${a.type}`}
                action={a}
                onChange={(a) =>
                  edit((b) => {
                    b[tab][i] = a
                  })
                }
                onRemove={() =>
                  edit((b) => {
                    b[tab].splice(i, 1)
                  })
                }
              />
            ))}
            <select
              aria-label="Add action to binding"
              value=""
              onChange={(e) => {
                if (e.target.value)
                  edit((b) => {
                    b[tab].push(newAction(e.target.value))
                  })
              }}
            >
              <option value="">+ Add action to {tab === 'actions' ? 'press' : tab}</option>
              {importCatalogOptions()}
            </select>
            <button
              className="primary full"
              disabled={useStore.getState().dirty || !key.enabled}
              onClick={() => perform(() => window.decker.press(selected))}
            >
              <Play size={16} />
              Test key
            </button>
            <button
              className="secondary full"
              disabled={useStore.getState().dirty || !key.enabled}
              onPointerDown={(e) => {
                e.currentTarget.setPointerCapture(e.pointerId)
                perform(() => window.decker.press(selected, 'down'))
              }}
              onPointerUp={() => perform(() => window.decker.press(selected, 'up'))}
              onPointerCancel={() => perform(() => window.decker.press(selected, 'up'))}
            >
              Hold to simulate press / release
            </button>
          </>
        ) : (
          <div className="empty-state">
            Select an action from the library or drag one onto this key.
          </div>
        )}
      </aside>
      <aside className="catalog">
        <Catalog onPick={add} />
      </aside>
    </div>
  )
}
import { definitions } from '../shared/catalog'
function importCatalogOptions() {
  return definitions.map((d) => (
    <option key={d.id} value={d.id}>
      {d.name}
    </option>
  ))
}
