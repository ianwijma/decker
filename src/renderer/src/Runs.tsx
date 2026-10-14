import { resolveWorkflowId } from "../../shared/workflow-identity";
import { useState } from "react";
import { CheckCircle2, Clock3, Search, Square, XCircle } from "lucide-react";
import { useApp } from "./store";
export function Runs() {
  const { snapshot, request } = useApp(),
    [selected, setSelected] = useState(""),
    [filter, setFilter] = useState("all"),
    [query, setQuery] = useState(""),
    [deckFilter, setDeckFilter] = useState("all"),
    [workflowFilter, setWorkflowFilter] = useState("all"),
    all = [...snapshot!.runs].reverse(),
    runs = all.filter(
      (r) =>
        (filter === "all" || r.status === filter) &&
        (deckFilter === "all" || r.deckId === deckFilter) &&
        (workflowFilter === "all" ||
          resolveWorkflowId(
            r.workflowId,
            snapshot!.document.workflowAliases,
          ) === workflowFilter) &&
        r.workflowName.toLowerCase().includes(query.toLowerCase()),
    ),
    run = all.find((r) => r.id === selected) ?? runs[0];
  return (
    <div className="runs-screen">
      <div className="page-heading">
        <div>
          <div className="eyebrow">ACTIVITY</div>
          <h1>A clear view of every run.</h1>
          <p>Follow the steps, find the answer, keep moving.</p>
        </div>
        <button onClick={() => void request({ type: "clearHistory" })}>
          Clear finished history
        </button>
      </div>
      <div className="run-metrics">
        {[
          { label: "Total runs", value: all.length },
          {
            label: "Successful",
            value: all.filter((r) => r.status === "success").length,
          },
          {
            label: "Running now",
            value: all.filter((r) => r.status === "running").length,
          },
        ].map((m) => (
          <div key={m.label}>
            <span>{m.label}</span>
            <strong>{m.value}</strong>
          </div>
        ))}
      </div>
      <div className="row run-filters">
        <select
          aria-label="Filter runs by deck"
          value={deckFilter}
          onChange={(e) => setDeckFilter(e.target.value)}
        >
          <option value="all">All decks</option>
          {snapshot!.document.decks.map((deck) => (
            <option value={deck.id} key={deck.id}>
              {deck.name}
            </option>
          ))}
        </select>
        <select
          aria-label="Filter runs by workflow"
          value={workflowFilter}
          onChange={(e) => setWorkflowFilter(e.target.value)}
        >
          <option value="all">All workflows</option>
          {[
            ...new Map(
              all.map((r) => [
                resolveWorkflowId(
                  r.workflowId,
                  snapshot!.document.workflowAliases,
                ),
                r.workflowName,
              ]),
            ).entries(),
          ].map(([id, name]) => (
            <option value={id} key={id}>
              {name}
            </option>
          ))}
        </select>
      </div>
      <div className="runs-layout">
        <section className="run-list">
          <div className="row">
            <div className="search grow">
              <Search size={16} />
              <input
                aria-label="Search runs"
                placeholder="Search runs"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
              />
            </div>
            <select
              aria-label="Run status filter"
              value={filter}
              onChange={(e) => setFilter(e.target.value)}
            >
              {[
                "all",
                "running",
                "success",
                "failure",
                "cancelled",
                "interrupted",
              ].map((s) => (
                <option key={s}>{s}</option>
              ))}
            </select>
          </div>
          {runs.length === 0 ? (
            <div className="empty-state">
              <Clock3 size={35} />
              <h2>Your story starts with a press.</h2>
              <p>Test a key or run a workflow to see its history here.</p>
            </div>
          ) : (
            runs.map((r) => (
              <button
                className={`run-row ${run?.id === r.id ? "active" : ""}`}
                key={r.id}
                onClick={() => setSelected(r.id)}
              >
                {r.status === "success" ? (
                  <CheckCircle2 className="success-text" size={22} />
                ) : r.status === "failure" ? (
                  <XCircle className="danger-text" size={22} />
                ) : (
                  <Clock3 size={22} />
                )}
                <div>
                  <strong>{r.workflowName}</strong>
                  <small>
                    {new Date(r.startedAt).toLocaleString()} · revision{" "}
                    {r.revision}
                  </small>
                </div>
                <span className={`status-pill ${r.status}`}>{r.status}</span>
              </button>
            ))
          )}
        </section>
        <section className="run-detail">
          {run ? (
            <>
              <div className="row">
                <div>
                  <span className="eyebrow">RUN INSPECTOR</span>
                  <h2>{run.workflowName}</h2>
                </div>
                {run.status === "running" && (
                  <button
                    onClick={() =>
                      void request({ type: "cancel", runId: run.id })
                    }
                  >
                    <Square size={14} /> Cancel
                  </button>
                )}
              </div>
              <p className="muted small">
                {run.id}
                <br />
                {snapshot!.document.decks.find((d) => d.id === run.deckId)
                  ?.name ?? "Software run"}{" "}
                · Revision {run.revision} ·{" "}
                {((run.endedAt ?? Date.now()) - run.startedAt) / 1000}s
              </p>
              {run.error && <div className="error-box">{run.error}</div>}
              <div className="timeline">
                {run.nodes.map((n) => (
                  <details key={n.id} className={`trace ${n.status}`}>
                    <summary>
                      <span className="trace-dot" />
                      <strong>{n.name}</strong>
                      <small>
                        {n.status} ·{" "}
                        {n.endedAt ? `${n.endedAt - n.startedAt}ms` : "running"}
                      </small>
                    </summary>
                    <p className="muted small code">
                      {n.path}
                      <br />
                      Attempt {n.attempt + 1}
                    </p>
                    {n.error && <div className="error-box">{n.error}</div>}
                    <h4>Input</h4>
                    <pre>{JSON.stringify(n.input ?? null, null, 2)}</pre>
                    <h4>Output</h4>
                    <pre>{JSON.stringify(n.output ?? null, null, 2)}</pre>
                  </details>
                ))}
              </div>
              <p className="muted small">
                History is bounded and sensitive fields are redacted.
                Interrupted runs are never replayed.
              </p>
            </>
          ) : (
            <div className="empty-state">
              Select a run to inspect its steps.
            </div>
          )}
        </section>
      </div>
    </div>
  );
}
