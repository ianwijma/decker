import React, { useEffect, useState, lazy, Suspense } from "react";
import { createRoot } from "react-dom/client";
import {
  Grid2X2,
  Workflow,
  Plus,
  Settings as SettingsIcon,
  X,
  Command,
} from "lucide-react";
import { useApp } from "./store";
import { Deck } from "./Deck";
import { deviceStatusLabel } from "../../shared/device-status";
const Flows = lazy(() =>
  import("./Flows").then((module) => ({ default: module.Flows })),
);
import { AddDeck } from "./DeckManager";
import { Settings } from "./Settings";
import "./styles.css";
class ErrorBoundary extends React.Component<
  { children: React.ReactNode },
  { error?: string }
> {
  state: { error?: string } = {};
  static getDerivedStateFromError(error: Error) {
    return { error: error.message };
  }
  render() {
    return this.state.error ? (
      <div className="empty-state">
        <h1>Something needs attention.</h1>
        <p>{this.state.error}</p>
        <button onClick={() => location.reload()}>Reload editor</button>
      </div>
    ) : (
      this.props.children
    );
  }
}
function App() {
  const { snapshot, receive, tab, setTab, error, setError, saving, request } =
    useApp();
  const [adding, setAdding] = useState(false);
  useEffect(() => {
    void window.decker
      .snapshot()
      .then(receive)
      .catch((e) => setError(String(e)));
    return window.decker.subscribe(receive);
  }, [receive, setError]);
  useEffect(() => {
    if (!snapshot) return;
    const accent = snapshot.document.settings.accent;
    document.documentElement.style.setProperty("--accent", accent);
    const rgb = accent
      .match(/[a-f\d]{2}/gi)!
      .map((x) => parseInt(x, 16) / 255)
      .map((x) => (x <= 0.04045 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4));
    const light = 0.2126 * rgb[0] + 0.7152 * rgb[1] + 0.0722 * rgb[2];
    document.documentElement.style.setProperty(
      "--accent-contrast",
      light > 0.179 ? "#111214" : "#ffffff",
    );
  }, [snapshot?.document.settings.accent]);
  if (!snapshot)
    return (
      <div className="loading">
        <span className="app-logo">▦</span>
        <h1>Decker</h1>
        <p>{error ?? "Getting your workspace ready…"}</p>
      </div>
    );
  return (
    <div className="app-shell">
      <nav className="rail" aria-label="Main navigation">
        <button
          className="app-logo"
          aria-label="Decker home"
          onClick={() => setTab("deck")}
        >
          <Command size={26} />
        </button>
        <div className="rail-divider" />
        <button
          className={`rail-item ${tab === "flows" ? "active" : ""}`}
          title="Flows"
          aria-label="Flows"
          onClick={() => setTab("flows")}
        >
          <Workflow size={23} />
          <small>Flows</small>
        </button>
        <div className="rail-divider" />
        <div className="deck-rail-list">
          {snapshot.document.decks.map((deck) => {
            const hardware = snapshot.devices.find(
              (d) => d.id === deck.hardwareId,
            );
            const online =
              deck.kind === "simulator" ||
              (deck.kind === "web"
                ? snapshot.web.clients.some(
                    (c) => c.deckId === deck.id && c.online,
                  )
                : hardware?.state === "ready");
            return (
              <button
                key={deck.id}
                className={`rail-item deck-rail-item ${tab === "deck" && snapshot.document.activeDeckId === deck.id ? "active" : ""}`}
                aria-label={`Deck: ${deck.name}`}
                title={`${deck.name} · ${deck.kind} · ${deck.kind === "hardware" ? deviceStatusLabel(hardware) : online ? "connected" : "offline"}`}
                onClick={() => {
                  void request({ type: "selectDeck", deckId: deck.id });
                  setTab("deck");
                }}
              >
                {deck.asset ? (
                  <img alt="" src={`decker-asset://${deck.asset}`} />
                ) : (
                  <span className="deck-rail-icon">{deck.icon || "▦"}</span>
                )}
                <small>{deck.name}</small>
                <i
                  className={`deck-connection-dot ${online ? "connected" : ""}`}
                />
              </button>
            );
          })}
          <button
            className="rail-item add-deck-button"
            aria-label="Add deck"
            title="Add deck"
            onClick={() => setAdding(true)}
          >
            <Plus size={23} />
            <small>Add deck</small>
          </button>
        </div>
        <div className="grow" />
        <span className="local-indicator" title="Local workspace" />
        <button
          className={`rail-item ${tab === "settings" ? "active" : ""}`}
          title="Settings"
          aria-label="Settings"
          onClick={() => setTab("settings")}
        >
          <SettingsIcon size={23} />
          <small>Settings</small>
        </button>
      </nav>
      <div className="app-body">
        <header className="topbar">
          <strong>
            {tab === "deck"
              ? "Deck workspace"
              : tab === "flows"
                ? "Workflow studio"
                : "Settings"}
          </strong>
          <span className="topbar-divider" />
          <span>Less clicking. More creating.</span>
          <div className="grow" />
          <span className="save-indicator">
            <span className="status-dot" />
            {saving ? "Saving…" : "All changes saved"}
          </span>
          <span className="version">v0.1</span>
        </header>
        {snapshot.web.pending.length > 0 && (
          <div className="pairing-banner">
            <span>{snapshot.web.pending.length} browser awaiting approval</span>
            <button
              onClick={() => {
                useApp.getState().setSettingsSection("web");
                setTab("settings");
              }}
            >
              View pairing requests
            </button>
          </div>
        )}
        <ErrorBoundary>
          {tab === "deck" ? (
            snapshot.document.decks.length ? (
              <Deck key={snapshot.document.activeDeckId} />
            ) : (
              <div className="empty-state">
                <h1>Create your first deck.</h1>
                <p>Connect a Stream Deck or create a browser deck.</p>
                <button className="primary" onClick={() => setAdding(true)}>
                  Add deck
                </button>
              </div>
            )
          ) : tab === "flows" ? (
            <Suspense
              fallback={
                <div className="empty-state">Opening workflow studio…</div>
              }
            >
              <Flows />
            </Suspense>
          ) : (
            <Settings />
          )}
        </ErrorBoundary>
      </div>
      {adding && <AddDeck onClose={() => setAdding(false)} />}
      {error && (
        <div role="alert" className="toast">
          <div>
            <strong>Couldn’t complete that action</strong>
            <p>{error}</p>
          </div>
          <button aria-label="Dismiss error" onClick={() => setError()}>
            <X size={18} />
          </button>
        </div>
      )}
    </div>
  );
}
createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
