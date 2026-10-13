import { useState } from "react";
import {
  Check,
  Download,
  Plus,
  RefreshCw,
  ShieldCheck,
  Upload,
  Usb,
  Trash2,
} from "lucide-react";
import { useApp } from "./store";
import { uid } from "../../shared/defaults";
import { FieldLabel } from "./components";
const accents = [
  "#5865f2",
  "#9b59b6",
  "#eb459e",
  "#f08c46",
  "#f0b232",
  "#23a559",
  "#00a8a8",
  "#3498db",
];
export function Settings() {
  const { snapshot, edit, request } = useApp(),
    doc = snapshot!.document,
    [ref, setRef] = useState("obs-password"),
    [secret, setSecret] = useState(""),
    [persist, setPersist] = useState(false),
    [saved, setSaved] = useState(false);
  return (
    <div className="settings-screen">
      <div className="page-heading">
        <div>
          <div className="eyebrow">PREFERENCES</div>
          <h1>Your deck. Your way.</h1>
          <p>A few small details that make this space feel like yours.</p>
        </div>
      </div>
      <div className="settings-layout">
        <section className="settings-card appearance-card">
          <div className="card-heading">
            <div>
              <h2>Appearance</h2>
              <p>Choose the colour that ties your workspace together.</p>
            </div>
            <span className="accent-spark">✦</span>
          </div>
          <h3>ACCENT COLOUR</h3>
          <div className="accent-swatches">
            {accents.map((accent) => (
              <button
                aria-label={`Use accent ${accent}`}
                aria-pressed={doc.settings.accent === accent}
                key={accent}
                style={{ background: accent }}
                onClick={() =>
                  edit((d) => {
                    d.settings.accent = accent;
                  })
                }
              >
                {doc.settings.accent === accent && <Check size={20} />}
              </button>
            ))}
            <label className="custom-colour" title="Custom accent colour">
              <input
                aria-label="Custom accent colour"
                type="color"
                value={doc.settings.accent}
                onChange={(e) =>
                  edit((d) => {
                    d.settings.accent = e.target.value;
                  })
                }
              />
              <Plus size={18} />
            </label>
          </div>
          <div className="accent-preview">
            <span className="preview-avatar">D</span>
            <div>
              <strong>A little more you.</strong>
              <small>
                Buttons, selections, focus rings and your flow canvas.
              </small>
            </div>
            <button className="primary">Looking good</button>
          </div>
          <FieldLabel label="Accent hex">
            <input
              aria-label="Accent hex"
              value={doc.settings.accent}
              readOnly
            />
          </FieldLabel>
        </section>
        <section className="settings-card">
          <div className="card-heading">
            <div>
              <h2>Devices</h2>
              <p>Your connected decks and software simulator.</p>
            </div>
            <Usb size={22} />
          </div>
          {snapshot!.devices.map((device) => (
            <div className="device-row" key={device.id}>
              <span className="device-mini">▦</span>
              <div>
                <strong>{device.name}</strong>
                <small>
                  {device.rows} × {device.columns} · {device.iconSize}px ·{" "}
                  {device.simulated ? "Software device" : device.id}
                </small>
              </div>
              <span className="status-dot" />
            </div>
          ))}
          <label className="toggle-row">
            <span>
              <strong>XL simulator</strong>
              <small>Configure and test all 32 keys without hardware.</small>
            </span>
            <input
              type="checkbox"
              role="switch"
              checked={doc.settings.simulator}
              onChange={(e) =>
                edit((d) => {
                  d.settings.simulator = e.target.checked;
                })
              }
            />
          </label>
          <FieldLabel label={`Brightness · ${doc.settings.brightness}%`}>
            <input
              aria-label="Brightness"
              type="range"
              min={0}
              max={100}
              value={doc.settings.brightness}
              onChange={(e) =>
                edit((d) => {
                  d.settings.brightness = Number(e.target.value);
                })
              }
            />
          </FieldLabel>
          <p className="muted small">
            Reconnect restores the current page and brightness. Physical
            hardware has not been verified in this environment.
          </p>
        </section>
        <section className="settings-card full-width">
          <div className="card-heading">
            <div>
              <h2>Linux capabilities</h2>
              <p>
                Availability is checked against the current desktop session.
              </p>
            </div>
            <button onClick={() => void request({ type: "diagnose" })}>
              <RefreshCw size={15} /> Recheck
            </button>
          </div>
          <div className="capabilities">
            {snapshot!.capabilities.length ? (
              snapshot!.capabilities.map((c) => (
                <div className="capability" key={c.id}>
                  <span
                    className={`status-dot ${c.available ? "" : "unavailable"}`}
                  />
                  <div>
                    <strong>{c.id}</strong>
                    <p>{c.detail}</p>
                  </div>
                  <span className="tag">
                    {c.available ? "Available" : "Unavailable"}
                  </span>
                </div>
              ))
            ) : (
              <p className="muted">Checking desktop services…</p>
            )}
          </div>
          <details>
            <summary>Observed integration state</summary>
            <pre>{JSON.stringify(snapshot!.observed, null, 2)}</pre>
          </details>
          <p className="muted small">
            Keyboard input currently requires X11. MPRIS uses the session bus.
            Install xdotool and PipeWire/PulseAudio tools for desktop controls.
            USB setup is documented in README.
          </p>
        </section>
        <section className="settings-card full-width">
          <div className="card-heading">
            <div>
              <h2>Connections</h2>
              <p>Connect OBS Studio through its WebSocket server.</p>
            </div>
            <button
              onClick={() =>
                edit((d) => {
                  d.connections.push({
                    id: uid(),
                    name: "OBS Studio",
                    url: "ws://127.0.0.1:4455",
                    credentialRef: "obs-password",
                  });
                })
              }
            >
              <Plus size={15} /> Add OBS
            </button>
          </div>
          {doc.connections.length === 0 && (
            <p className="muted">
              No connections yet. Enable the WebSocket server in OBS → Tools.
            </p>
          )}
          {doc.connections.map((c) => (
            <div className="connection" key={c.id}>
              <div className="row">
                <strong>{c.name}</strong>
                <span className="tag">
                  {(
                    snapshot!.observed[`obs:${c.id}`] as { connected?: boolean }
                  )?.connected
                    ? "Connected"
                    : "Disconnected"}
                </span>
                <button
                  className="icon-button"
                  aria-label={`Delete ${c.name}`}
                  onClick={() =>
                    edit((d) => {
                      d.connections = d.connections.filter(
                        (x) => x.id !== c.id,
                      );
                    })
                  }
                >
                  <Trash2 size={16} />
                </button>
              </div>
              <div className="three-columns">
                <FieldLabel label="Connection name">
                  <input
                    value={c.name}
                    onChange={(e) =>
                      edit((d) => {
                        d.connections.find((x) => x.id === c.id)!.name =
                          e.target.value || "OBS";
                      })
                    }
                  />
                </FieldLabel>
                <FieldLabel label="WebSocket URL">
                  <input
                    defaultValue={c.url}
                    onBlur={(e) => {
                      try {
                        new URL(e.target.value);
                        edit((d) => {
                          d.connections.find((x) => x.id === c.id)!.url =
                            e.target.value;
                        });
                      } catch {
                        useApp
                          .getState()
                          .setError("Enter a valid WebSocket URL");
                      }
                    }}
                  />
                </FieldLabel>
                <FieldLabel label="Credential reference">
                  <input
                    value={c.credentialRef ?? ""}
                    onChange={(e) =>
                      edit((d) => {
                        d.connections.find(
                          (x) => x.id === c.id,
                        )!.credentialRef = e.target.value || undefined;
                      })
                    }
                  />
                </FieldLabel>
              </div>
              <small className="muted code">Connection ID: {c.id}</small>
            </div>
          ))}
        </section>
        <section className="settings-card">
          <div className="card-heading">
            <div>
              <h2>Credentials</h2>
              <p>
                {snapshot!.secureStorage
                  ? "OS-backed encryption is available."
                  : "Session-only storage · no secure keyring available."}
              </p>
            </div>
            <ShieldCheck size={23} />
          </div>
          <FieldLabel label="Credential reference">
            <input
              aria-label="Credential reference"
              value={ref}
              onChange={(e) => setRef(e.target.value)}
            />
          </FieldLabel>
          <FieldLabel label="Secret">
            <input
              aria-label="Secret"
              type="password"
              autoComplete="new-password"
              value={secret}
              onChange={(e) => {
                setSecret(e.target.value);
                setSaved(false);
              }}
            />
          </FieldLabel>
          <label className="checkbox-row">
            <input
              type="checkbox"
              checked={persist}
              disabled={!snapshot!.secureStorage}
              onChange={(e) => setPersist(e.target.checked)}
            />{" "}
            Persist with OS encryption
          </label>
          <button
            disabled={!ref || !secret}
            className="primary"
            onClick={async () => {
              const result = await request({
                type: "credential",
                ref,
                value: secret,
                persist,
              });
              if (result !== undefined) {
                setSecret("");
                setSaved(true);
              }
            }}
          >
            {saved ? "Saved" : "Save credential"}
          </button>
          <p className="muted small">
            Secret values are never sent to the editor or included in workspace
            exports. References can be used by HTTP and OBS actions.
          </p>
        </section>
        <section className="settings-card">
          <div className="card-heading">
            <div>
              <h2>Startup & history</h2>
              <p>Keep your shortcuts close, even with the editor closed.</p>
            </div>
          </div>
          {(
            [
              {
                key: "closeToTray",
                label: "Close editor to tray",
                hint: "The runtime continues until you explicitly quit.",
              },
              {
                key: "startHidden",
                label: "Start with editor hidden",
                hint: "Open Decker from the system tray.",
              },
              {
                key: "launchAtLogin",
                label: "Launch at login",
                hint: "Add Decker to Linux desktop autostart.",
              },
            ] as const
          ).map((setting) => (
            <label className="toggle-row" key={setting.key}>
              <span>
                <strong>{setting.label}</strong>
                <small>{setting.hint}</small>
              </span>
              <input
                type="checkbox"
                role="switch"
                checked={doc.settings[setting.key]}
                onChange={(e) =>
                  edit((d) => {
                    d.settings[setting.key] = e.target.checked;
                  })
                }
              />
            </label>
          ))}
          <FieldLabel label="Run history limit">
            <input
              aria-label="Run history limit"
              type="number"
              min={10}
              max={1000}
              value={doc.settings.historyLimit}
              onChange={(e) =>
                edit((d) => {
                  d.settings.historyLimit = Number(e.target.value);
                })
              }
            />
          </FieldLabel>
        </section>
        <section className="settings-card full-width">
          <div className="card-heading">
            <div>
              <h2>Take your workspace with you.</h2>
              <p>
                Export profiles, flows and images. Imported commands are shown
                for review before activation.
              </p>
            </div>
            <div className="row">
              <button onClick={() => void request({ type: "import" })}>
                <Upload size={16} /> Import
              </button>
              <button
                className="primary"
                onClick={() => void request({ type: "export" })}
              >
                <Download size={16} /> Export workspace
              </button>
            </div>
          </div>
        </section>
      </div>
    </div>
  );
}
