import { useState } from 'react'
import { Square } from 'lucide-react'
import { useStore, perform } from './store'
export function Runs() {
  const { state } = useStore(),
    [selected, setSelected] = useState(''),
    [filter, setFilter] = useState('all')
  const runs = state?.runs.filter((r) => filter === 'all' || r.status === filter) ?? [],
    run = runs.find((r) => r.id === selected) ?? runs[0]
  return (
    <div className="runs-layout">
      <section className="run-list">
        <div className="page-heading">
          <div>
            <div className="eyebrow">EVERY EXECUTION HAS A STORY</div>
            <h1>Run history</h1>
          </div>
          <select
            aria-label="Filter run status"
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
          >
            {['all', 'running', 'success', 'error', 'cancelled', 'interrupted'].map((s) => (
              <option key={s} value={s}>
                {s}
              </option>
            ))}
          </select>
        </div>
        {runs.map((r) => (
          <button
            key={r.id}
            className={`run-item ${run?.id === r.id ? 'active' : ''}`}
            onClick={() => setSelected(r.id)}
          >
            <span className={`status-dot ${r.status}`} />
            <div>
              <strong>{r.name}</strong>
              <small>
                {new Date(r.startedAt).toLocaleString()} · v{r.revision}
              </small>
            </div>
            <span className="push">{r.status}</span>
          </button>
        ))}
        {!runs.length && (
          <div className="empty-state">Run a key or workflow to see its execution here.</div>
        )}
      </section>
      <section className="run-detail">
        {run ? (
          <>
            <div className="page-heading">
              <div>
                <span className={`badge ${run.status}`}>{run.status.toUpperCase()}</span>
                <h2>{run.name}</h2>
                <p className="muted">
                  Revision {run.revision} ·{' '}
                  {run.endedAt ? `${run.endedAt - run.startedAt} ms` : 'In progress'}
                  <br />
                  Run {run.id}
                </p>
              </div>
              {run.status === 'running' && (
                <button
                  className="danger"
                  onClick={() => perform(() => window.decker.cancel(run.id))}
                >
                  <Square size={15} />
                  Cancel run
                </button>
              )}
            </div>
            {run.error && <div className="validation">{run.error}</div>}
            {run.nodes.map((n, i) => (
              <details className="trace" key={i}>
                <summary>
                  <span className={`status-dot ${n.status}`} />
                  <strong>{n.nodeId}</strong>
                  <span className="push muted">
                    {n.status} · {n.endedAt ? `${n.endedAt - n.startedAt} ms` : '…'}
                  </span>
                </summary>
                <p className="muted">{n.path}</p>
                {n.error && <p className="error">{n.error}</p>}
                <div className="trace-data">
                  <div>
                    <small>INPUT</small>
                    <pre>{JSON.stringify(n.input, null, 2)}</pre>
                  </div>
                  <div>
                    <small>OUTPUT</small>
                    <pre>{JSON.stringify(n.output, null, 2)}</pre>
                  </div>
                </div>
              </details>
            ))}
            <p className="hint">
              History is bounded and sensitive fields are redacted. Interrupted runs are never
              replayed automatically.
            </p>
          </>
        ) : (
          <div className="empty-state">No run selected.</div>
        )}
      </section>
    </div>
  )
}
