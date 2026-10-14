import { RefreshCw, Copy, ExternalLink } from "lucide-react";
import { useApp } from "./store";
import { buildHealth, redactDiagnostics, remedyFor } from "../../shared/health";
import "./diagnostics.css";
export function Diagnostics() {
  const { snapshot, request, setSettingsSection } = useApp();
  const records = snapshot!.health ?? buildHealth(snapshot!);
  return (
    <div className="settings-screen diagnostics-screen">
      <div className="page-heading">
        <div>
          <div className="eyebrow">DIAGNOSTICS</div>
          <h1>Understand your workspace.</h1>
          <p>Causes, affected features and guided repairs for this session.</p>
        </div>
        <button onClick={() => setSettingsSection("runs")}>
          Open run history
        </button>
      </div>
      <div className="settings-layout">
        <section className="settings-card full-width">
          <div className="card-heading">
            <div>
              <h2>Workspace health</h2>
              <p>Checks describe the current process and desktop session.</p>
            </div>
            <button onClick={() => void request({ type: "diagnose" })}>
              <RefreshCw size={15} /> Recheck
            </button>
          </div>
          {!records.length && (
            <p className="muted">Checking desktop services…</p>
          )}
          <div className="diagnostic-records">
            {records.map((record) => {
              const remedy = remedyFor(record);
              return (
                <article
                  className={`diagnostic-record health-${record.state}`}
                  key={record.id}
                  aria-label={record.feature}
                >
                  <div className="diagnostic-heading">
                    <h3>{record.feature}</h3>
                    <span className="tag">{record.state}</span>
                  </div>
                  <p>{record.cause}</p>
                  {remedy && (
                    <>
                      <p className="muted">{remedy.text}</p>
                      {remedy.copy && (
                        <pre aria-label="Suggested repair text">
                          {remedy.copy}
                        </pre>
                      )}
                      <div className="row">
                        {remedy.copy && (
                          <button
                            onClick={() =>
                              void request({
                                type: "diagnosticRemedy",
                                healthId: record.id,
                                action: "copy",
                              })
                            }
                          >
                            <Copy size={15} /> Copy repair text
                          </button>
                        )}
                        {remedy.url && (
                          <button
                            onClick={() =>
                              void request({
                                type: "diagnosticRemedy",
                                healthId: record.id,
                                action: "open",
                              })
                            }
                          >
                            <ExternalLink size={15} /> Open documentation
                          </button>
                        )}
                        <button
                          onClick={() =>
                            void request(
                              record.hardwareId &&
                                snapshot!.devices.some(
                                  (d) =>
                                    d.id === record.hardwareId && d.configured,
                                )
                                ? {
                                    type: "retryDevice",
                                    hardwareId: record.hardwareId,
                                  }
                                : { type: "diagnose" },
                            )
                          }
                        >
                          <RefreshCw size={15} /> Retry
                        </button>
                      </div>
                    </>
                  )}
                  {record.evidence && (
                    <details>
                      <summary>Feature details</summary>
                      <pre>
                        {JSON.stringify(
                          redactDiagnostics(record.evidence),
                          null,
                          2,
                        )}
                      </pre>
                    </details>
                  )}
                </article>
              );
            })}
          </div>
          <details>
            <summary>Observed integration state</summary>
            <pre>
              {JSON.stringify(
                redactDiagnostics({
                  ...snapshot!.observed,
                  devices: snapshot!.devices,
                  capabilities: snapshot!.capabilities,
                }),
                null,
                2,
              )}
            </pre>
          </details>
          <p className="muted small">
            Repair text is guidance for review in your terminal or configuration
            files. Decker does not execute it or install tools.
          </p>
        </section>
      </div>
    </div>
  );
}
