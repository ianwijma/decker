import { RefreshCw, Plus, ArrowRight } from "lucide-react";
import { useApp } from "./store";
import { homeHealth, deckReadiness } from "./home-health";
import {
  redactDiagnostics,
  remedyFor,
  type HealthRecord,
} from "../../shared/health";
import "./home.css";

function RepairLinks({ record }: { record: HealthRecord }) {
  const { snapshot, request, setTab, setSettingsSection } = useApp();
  const remedy = remedyFor(record);
  return (
    <div className="home-repair">
      <button
        onClick={() => {
          setSettingsSection("diagnostics");
          setTab("settings");
        }}
      >
        Diagnostics <ArrowRight size={14} />
      </button>
      {remedy && (
        <details>
          <summary>Repair guidance</summary>
          <p>{remedy.text}</p>
          <div className="home-actions">
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
                Copy repair text
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
                Open documentation
              </button>
            )}
          </div>
        </details>
      )}
      {remedy && (
        <button
          onClick={() =>
            void request(
              record.hardwareId &&
                snapshot!.devices.some(
                  (device) =>
                    device.id === record.hardwareId && device.configured,
                )
                ? { type: "retryDevice", hardwareId: record.hardwareId }
                : { type: "diagnose" },
            )
          }
        >
          <RefreshCw size={14} /> Retry
        </button>
      )}
    </div>
  );
}

export function Home({ onAdd }: { onAdd: () => void }) {
  const { snapshot, request, setTab, setSettingsSection } = useApp();
  const current = snapshot!;
  const { records, warnings, warningCount } = homeHealth(current);
  const diagnostics = () => {
    setSettingsSection("diagnostics");
    setTab("settings");
  };
  return (
    <main className="home-screen">
      <div className="home-heading">
        <div>
          <div className="eyebrow">HOME</div>
          <h1>Your workspace at a glance.</h1>
          <p>Deck readiness, connected browsers and tools for this session.</p>
        </div>
        <button onClick={() => void request({ type: "diagnose" })}>
          <RefreshCw size={15} /> Recheck
        </button>
      </div>
      <section
        className={`home-summary ${warningCount ? "home-warning" : ""}`}
        aria-label="Workspace summary"
        role="status"
      >
        <strong>
          {warningCount
            ? `${warningCount} feature${warningCount === 1 ? " needs" : "s need"} attention`
            : "No configured feature faults reported"}
        </strong>
        <span>Discovery alone does not establish hardware readiness.</span>
        <button onClick={diagnostics}>View diagnostics</button>
      </section>
      <section aria-labelledby="home-decks">
        <div className="home-section-heading">
          <h2 id="home-decks">Your decks</h2>
          <button onClick={onAdd}>
            <Plus size={15} /> Add deck
          </button>
        </div>
        {!current.document.decks.length && (
          <div className="home-empty">
            <h3>Create your first deck.</h3>
            <p>
              Connect a Stream Deck, or add a web deck or simulator to get
              started.
            </p>
          </div>
        )}
        <div className="home-grid">
          {current.document.decks.map((deck) => {
            const status = deckReadiness(current, deck);
            const record = records.find(
              (record) => record.id === `device:${deck.hardwareId}`,
            );
            const profile = current.document.profiles.find(
              (profile) => profile.id === deck.activeProfileId,
            );
            const page = profile?.pages.find(
              (page) => page.id === deck.activePageId,
            );
            return (
              <article
                key={deck.id}
                className="home-card"
                aria-label={`Deck overview: ${deck.name}`}
              >
                <button
                  className="home-deck-open"
                  aria-label={`Open deck: ${deck.name}`}
                  onClick={async () => {
                    if (await request({ type: "selectDeck", deckId: deck.id }))
                      setTab("deck");
                  }}
                >
                  {deck.asset ? (
                    <img alt="" src={`decker-asset://${deck.asset}`} />
                  ) : (
                    <span className="home-deck-icon" aria-hidden="true">
                      {deck.icon || "▦"}
                    </span>
                  )}
                  <span>
                    <strong>{deck.name}</strong>
                    <small>
                      {deck.kind} · {deck.rows} × {deck.columns}
                    </small>
                  </span>
                  <ArrowRight size={16} />
                </button>
                <span
                  className={`home-readiness ${status.ready ? "home-ready" : ""}`}
                >
                  {status.label}
                </span>
                <p>
                  {profile?.name} · {page?.name}
                </p>
                {deck.kind === "simulator" && (
                  <p className="small">
                    Software testing; physical hardware readiness is separate.
                  </p>
                )}
                {deck.kind === "web" && (
                  <p className="small">
                    {current.web.running
                      ? "Sharing server running"
                      : "Sharing server stopped"}{" "}
                    · browser presence is reported above.
                  </p>
                )}
                {record && record.state !== "healthy" && (
                  <>
                    <p>{String(redactDiagnostics(record.cause))}</p>
                    <RepairLinks record={record} />
                  </>
                )}
                {deck.kind === "hardware" && !record && !status.ready && (
                  <button onClick={diagnostics}>
                    Review device diagnostics
                  </button>
                )}
              </article>
            );
          })}
        </div>
      </section>
      <section
        aria-labelledby="home-sharing"
        className="home-card home-sharing"
      >
        <div>
          <h2 id="home-sharing">Web sharing</h2>
          <p>
            {current.web.running
              ? "Sharing server running"
              : current.document.settings.webEnabled
                ? "Sharing server stopped"
                : "Sharing disabled"}{" "}
            · {current.web.clients.filter((client) => client.online).length}{" "}
            paired browsers online
          </p>
          <p className="small">
            A running server does not mean a browser is connected.
          </p>
        </div>
        <button
          onClick={() => {
            setSettingsSection("web");
            setTab("settings");
          }}
        >
          Manage browsers
        </button>
      </section>
      <section aria-labelledby="home-tools">
        <div className="home-section-heading">
          <h2 id="home-tools">Tools and current faults</h2>
        </div>
        <div className="home-grid">
          {records
            .filter((record) => !record.id.startsWith("device:"))
            .map((record) => (
              <article
                key={record.id}
                className={`home-card ${warnings.includes(record) ? "home-warning" : ""}`}
                aria-label={record.feature}
              >
                <div className="home-section-heading">
                  <h3>{String(redactDiagnostics(record.feature))}</h3>
                  <span className="tag">{record.state}</span>
                </div>
                <p>{String(redactDiagnostics(record.cause))}</p>
                {!warnings.includes(record) && record.state !== "healthy" && (
                  <p className="small">
                    Optional setup guidance · no configured feature fault.
                  </p>
                )}
                {record.state !== "healthy" && <RepairLinks record={record} />}
              </article>
            ))}
          {!records.length && (
            <p>
              Checks are still being collected. Recheck or open Diagnostics for
              details.
            </p>
          )}
        </div>
      </section>
    </main>
  );
}
