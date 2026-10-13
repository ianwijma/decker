import { useState } from 'react'
import { useStore, perform } from './store'
import { uid } from '../shared/schema'
import { JsonEditor } from './components'
export function Settings() {
  const { draft: c, state, update } = useStore(),
    [credentialId, setCredentialId] = useState(''),
    [secret, setSecret] = useState(''),
    [persist, setPersist] = useState(false),
    [message, setMessage] = useState('')
  if (!c) return null
  return (
    <div className="settings-layout">
      <div className="page-heading">
        <div>
          <div className="eyebrow">SETTLE INTO YOUR SPACE</div>
          <h1>Settings</h1>
          <p className="muted">Your colours, your devices, your connections.</p>
        </div>
      </div>
      <section className="settings-card">
        <h2>Appearance</h2>
        <p className="muted">Pick your accent. It follows you across the entire studio.</p>
        <div className="swatches">
          {['#5865f2', '#a855f7', '#eb459e', '#23a55a', '#f0b232', '#e67e22', '#00a8fc'].map(
            (colour) => (
              <button
                key={colour}
                aria-label={`Accent ${colour}`}
                aria-pressed={c.settings.accent === colour}
                className={c.settings.accent === colour ? 'picked' : ''}
                style={{ background: colour }}
                onClick={() =>
                  update((c) => {
                    c.settings.accent = colour
                  })
                }
              />
            )
          )}
          <label className="custom-colour">
            Custom{' '}
            <input
              aria-label="Accent colour"
              type="color"
              value={c.settings.accent}
              onChange={(e) =>
                update((c) => {
                  c.settings.accent = e.target.value
                })
              }
            />
            <code>{c.settings.accent}</code>
          </label>
        </div>
        <div className="accent-preview">
          <span>✦</span>
          <strong>Make it feel like you.</strong>
          <button className="primary push">Your accent</button>
        </div>
      </section>
      <section className="settings-card">
        <h2>Devices</h2>
        <label className="check">
          <input
            aria-label="Enable simulator"
            type="checkbox"
            checked={c.settings.simulator}
            onChange={(e) =>
              update((c) => {
                c.settings.simulator = e.target.checked
              })
            }
          />
          Enable Stream Deck XL simulator
        </label>
        <label className="field">
          Brightness · {c.settings.brightness}%
          <input
            aria-label="Brightness"
            type="range"
            min="0"
            max="100"
            value={c.settings.brightness}
            onChange={(e) =>
              update((c) => {
                c.settings.brightness = Number(e.target.value)
              })
            }
          />
        </label>
        {state?.devices.map((d) => (
          <div className="diagnostic" key={d.id}>
            <span className={`status-dot ${d.connected ? 'success' : 'error'}`} />
            <div>
              <strong>{d.name}</strong>
              <small>
                {d.rows} × {d.columns} · {d.id} ·{' '}
                {d.simulated ? 'simulated' : d.connected ? 'connected' : 'disconnected'}
              </small>
              {d.error && <p className="error">{d.error}</p>}
            </div>
          </div>
        ))}
        <p className="hint">
          On Linux, use the upstream desktop-user udev rule, replug your deck, and close other
          controlling applications. Hardware performance and USB permissions need verification on
          your machine.
        </p>
      </section>
      <section className="settings-card">
        <h2>Linux capabilities</h2>
        {state?.capabilities.map((cap) => (
          <div className="diagnostic" key={cap.id}>
            <span className={`status-dot ${cap.available ? 'success' : 'error'}`} />
            <div>
              <strong>{cap.id}</strong>
              <small>{cap.detail}</small>
            </div>
            <span className="push muted">{cap.available ? 'Available' : 'Unavailable'}</span>
          </div>
        ))}
        <p className="hint">
          Keyboard automation uses X11. General Wayland input injection is unavailable.
        </p>
      </section>
      <section className="settings-card">
        <div className="row">
          <h2>OBS connections</h2>
          <button
            className="secondary push"
            onClick={() =>
              update((c) =>
                c.connections.push({ id: uid(), name: 'OBS Studio', url: 'ws://127.0.0.1:4455' })
              )
            }
          >
            + Add connection
          </button>
        </div>
        {c.connections.map((connection, i) => (
          <div className="connection" key={connection.id}>
            <label className="field">
              Name
              <input
                value={connection.name}
                onChange={(e) =>
                  update((c) => {
                    c.connections[i].name = e.target.value
                  })
                }
              />
            </label>
            <label className="field">
              WebSocket URL
              <input
                value={connection.url}
                onChange={(e) =>
                  update((c) => {
                    c.connections[i].url = e.target.value
                  })
                }
              />
            </label>
            <label className="field">
              Credential reference
              <input
                value={connection.credentialRef ?? ''}
                onChange={(e) =>
                  update((c) => {
                    c.connections[i].credentialRef = e.target.value || undefined
                  })
                }
              />
            </label>
            <small className="muted">Connection ID: {connection.id}</small>
            <pre>
              {JSON.stringify(state?.observed[connection.id] ?? { connected: false }, null, 2)}
            </pre>
            <button
              className="danger"
              onClick={() =>
                update((c) => {
                  c.connections.splice(i, 1)
                })
              }
            >
              Remove connection
            </button>
          </div>
        ))}
        {!c.connections.length && (
          <p className="muted">Enable the WebSocket server in OBS, then add its address here.</p>
        )}
      </section>
      <section className="settings-card">
        <h2>Credentials</h2>
        <p className="muted">
          Storage: {state?.secretStorage}. Credentials stay outside exported configuration.
        </p>
        <label className="field">
          Reference name
          <input
            value={credentialId}
            onChange={(e) => setCredentialId(e.target.value)}
            placeholder="obs-local"
          />
        </label>
        <label className="field">
          Secret
          <input
            type="password"
            autoComplete="new-password"
            value={secret}
            onChange={(e) => setSecret(e.target.value)}
          />
        </label>
        <label className="check">
          <input type="checkbox" checked={persist} onChange={(e) => setPersist(e.target.checked)} />
          Persist using OS-backed encryption
        </label>
        <button
          className="primary"
          disabled={!credentialId || !secret}
          onClick={() =>
            perform(async () => {
              await window.decker.credential(credentialId, secret, persist)
              setSecret('')
              setMessage('Credential saved')
            })
          }
        >
          Save credential
        </button>
        {message && <p role="status">{message}</p>}
      </section>
      <section className="settings-card">
        <h2>Lifecycle & history</h2>
        <label className="check">
          <input
            type="checkbox"
            checked={c.settings.startHidden}
            onChange={(e) =>
              update((c) => {
                c.settings.startHidden = e.target.checked
              })
            }
          />
          Start hidden in the tray
        </label>
        <label className="check">
          <input
            type="checkbox"
            checked={c.settings.launchAtLogin}
            onChange={(e) =>
              update((c) => {
                c.settings.launchAtLogin = e.target.checked
              })
            }
          />
          Launch at login
        </label>
        <label className="field">
          Retained runs
          <input
            type="number"
            min="10"
            max="1000"
            value={c.settings.historyLimit}
            onChange={(e) =>
              update((c) => {
                c.settings.historyLimit = Number(e.target.value)
              })
            }
          />
        </label>
        <p className="muted">
          Closing the editor keeps the runtime active. Quit Decker stops runs and releases devices.
        </p>
        <button className="danger" onClick={() => perform(() => window.decker.quit())}>
          Quit Decker
        </button>
      </section>
      <section className="settings-card">
        <h2>Import & export</h2>
        <p className="muted">
          Imported bindings start disabled so you can review commands and enable them individually.
          Secrets are excluded.
        </p>
        <div className="row">
          <button
            className="secondary"
            onClick={() =>
              perform(async () => {
                const text = await window.decker.export()
                const url = URL.createObjectURL(new Blob([text], { type: 'application/json' }))
                const a = document.createElement('a')
                a.href = url
                a.download = 'decker-config.json'
                a.click()
                URL.revokeObjectURL(url)
              })
            }
          >
            Export configuration
          </button>
          <label className="secondary file-button">
            Import configuration
            <input
              aria-label="Import configuration"
              type="file"
              accept="application/json"
              onChange={(e) => {
                const file = e.target.files?.[0]
                if (file)
                  perform(async () => {
                    const config = await window.decker.import(await file.text())
                    useStore.setState({ draft: config, dirty: true })
                    setMessage('Imported as a draft. Review and save to activate.')
                  })
              }}
            />
          </label>
        </div>
        <details>
          <summary>Review configuration</summary>
          <JsonEditor
            value={c as unknown as import('../shared/schema').Json}
            onChange={() => {}}
            label="Configuration preview"
          />
        </details>
      </section>
    </div>
  )
}
