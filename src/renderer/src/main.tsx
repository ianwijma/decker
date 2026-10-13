import React, { useEffect, lazy, Suspense } from "react";
import { createRoot } from "react-dom/client";
import {
  Grid2X2,
  Workflow,
  History,
  Settings as SettingsIcon,
  X,
  Command,
} from "lucide-react";
import { useApp } from "./store";
import { Deck } from "./Deck";
const Flows = lazy(() =>
  import("./Flows").then((module) => ({ default: module.Flows })),
);
import { Runs } from "./Runs";
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
  const { snapshot, receive, tab, setTab, error, setError, saving } = useApp();
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
        {(
          [
            { id: "deck", label: "Deck", icon: Grid2X2 },
            { id: "flows", label: "Flows", icon: Workflow },
            { id: "runs", label: "Runs", icon: History },
          ] as const
        ).map((item) => (
          <button
            key={item.id}
            title={item.label}
            aria-label={item.label}
            className={`rail-item ${tab === item.id ? "active" : ""}`}
            onClick={() => setTab(item.id)}
          >
            <item.icon size={23} />
            <small>{item.label}</small>
          </button>
        ))}
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
                : tab === "runs"
                  ? "Run history"
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
        <ErrorBoundary>
          {tab === "deck" ? (
            <Deck />
          ) : tab === "flows" ? (
            <Suspense
              fallback={
                <div className="empty-state">Opening workflow studio…</div>
              }
            >
              <Flows />
            </Suspense>
          ) : tab === "runs" ? (
            <Runs />
          ) : (
            <Settings />
          )}
        </ErrorBoundary>
      </div>
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
