import { useMemo, useState } from 'react'
import {
  ReactFlow,
  Background,
  Controls,
  MiniMap,
  Handle,
  Position,
  applyNodeChanges,
  type NodeProps,
  type Node,
  type Connection,
  type NodeChange
} from '@xyflow/react'
import '@xyflow/react/dist/style.css'
import { Play, Square, Plus, Trash2 } from 'lucide-react'
import { useStore, perform } from './store'
import {
  uid,
  workflowSchema,
  nodeSchema,
  type Workflow,
  type FlowNode,
  type Json
} from '../shared/schema'
import { validateWorkflow } from '../runtime/validate'
import { flowKinds, nodeDefaults, definitions } from '../shared/catalog'
import { ActionEditor, JsonEditor, newAction } from './components'
type CanvasNode = Node<{ node: FlowNode; status: string }>
function FlowCard({ data, selected }: NodeProps<CanvasNode>) {
  const n = data.node
  const ports =
    n.kind === 'condition'
      ? ['true', 'false', 'error']
      : n.kind === 'parallel'
        ? ['branch:a', 'branch:b', 'next', 'error']
        : n.kind === 'repeat' || n.kind === 'foreach'
          ? ['body', 'next', 'error']
          : n.kind === 'switch'
            ? ['case:yes', 'case:no', 'default', 'error']
            : n.kind === 'return'
              ? []
              : ['next', 'error']
  return (
    <div className={`flow-card ${selected ? 'selected' : ''} ${data.status}`}>
      <Handle type="target" position={Position.Left} />
      <div className="flow-kind">{n.kind.toUpperCase()}</div>
      <strong>{n.label}</strong>
      <small>
        {n.action
          ? definitions.find((d) => d.id === n.action!.type)?.name
          : n.kind === 'parallel'
            ? 'Branches → wait for all → next'
            : n.kind === 'repeat' || n.kind === 'foreach'
              ? 'Body → bounded iterations → next'
              : 'Local workflow node'}
      </small>
      {ports.map((port, i) => (
        <div className="port-label" key={port} style={{ top: 40 + i * 20 }}>
          {port}
          <Handle type="source" position={Position.Right} id={port} style={{ top: 7 }} />
        </div>
      ))}
    </div>
  )
}
const nodeTypes = { decker: FlowCard }
export function Flows() {
  const { draft: c, state, update, dirty } = useStore(),
    [flowId, setFlowId] = useState(''),
    [selected, setSelected] = useState(''),
    [search, setSearch] = useState(''),
    [runInput, setRunInput] = useState<Record<string, Json>>({})
  const flow = c?.workflows.find((f) => f.id === flowId) ?? c?.workflows[0]
  const run = state?.runs.find((r) => r.workflowId === flow?.id)
  const nodes = useMemo(
    () =>
      flow?.nodes.map((n) => ({
        id: n.id,
        type: 'decker',
        position: n.position,
        data: {
          node: n,
          status:
            run?.status === 'running'
              ? (run.nodes.findLast((r) => r.nodeId === n.id)?.status ?? '')
              : ''
        },
        selected: n.id === selected
      })) ?? [],
    [flow, run, selected]
  )
  if (!c) return null
  const mutate = (fn: (flow: Workflow) => void) =>
    update((c) => {
      const f = c.workflows.find((w) => w.id === flow!.id)!
      fn(f)
      if (f.revision === state?.config.workflows.find((w) => w.id === f.id)?.revision) f.revision++
    })
  const current = flow?.nodes.find((n) => n.id === selected)
  const edit = (fn: (n: FlowNode) => void) =>
    mutate((f) => fn(f.nodes.find((n) => n.id === selected)!))
  const add = (kind: FlowNode['kind']) => {
    if (!flow) return
    const id = uid()
    mutate((f) =>
      f.nodes.push(
        nodeSchema.parse({
          id,
          kind,
          label: kind === 'action' ? 'New action' : kind[0].toUpperCase() + kind.slice(1),
          config: nodeDefaults(kind),
          position: { x: 80 + f.nodes.length * 40, y: 260 },
          ...(kind === 'action' ? { action: newAction('notification') } : {})
        })
      )
    )
    setSelected(id)
  }
  const connect = (connection: Connection) =>
    mutate((f) => {
      if (!connection.source || !connection.target) return
      const port = connection.sourceHandle ?? 'next'
      f.edges = f.edges.filter((e) => !(e.source === connection.source && e.port === port))
      f.edges.push({ id: uid(), source: connection.source, target: connection.target, port })
    })
  const changes = (changes: NodeChange[]) => {
    if (
      changes.some((ch) => ch.type === 'position' && ch.position) ||
      changes.some((ch) => ch.type === 'remove')
    )
      mutate((f) => {
        const applied = applyNodeChanges(changes, nodes)
        f.nodes = f.nodes
          .filter((n) => applied.some((a) => a.id === n.id))
          .map((n) => ({ ...n, position: applied.find((a) => a.id === n.id)!.position }))
        f.edges = f.edges.filter(
          (e) => f.nodes.some((n) => n.id === e.source) && f.nodes.some((n) => n.id === e.target)
        )
      })
  }
  const errors = flow ? validateWorkflow(flow, c.workflows) : []
  return (
    <div className="flow-layout">
      <aside className="node-palette">
        <div className="section-label">
          WORKFLOWS
          <button
            className="icon-button push"
            aria-label="New workflow"
            onClick={() => {
              const id = uid()
              update((c) =>
                c.workflows.push(
                  workflowSchema.parse({
                    id,
                    name: 'Untitled workflow',
                    revision: 1,
                    nodes: [
                      { id: uid(), kind: 'trigger', label: 'Start', position: { x: 60, y: 120 } }
                    ],
                    edges: []
                  })
                )
              )
              setFlowId(id)
            }}
          >
            <Plus size={16} />
          </button>
        </div>
        {c.workflows.map((f) => (
          <button
            className={`workflow-list ${flow?.id === f.id ? 'active' : ''}`}
            key={f.id}
            onClick={() => {
              setFlowId(f.id)
              setSelected('')
            }}
          >
            ⑂ <span>{f.name}</span>
            <small>v{f.revision}</small>
          </button>
        ))}
        <div className="section-label mt">NODE LIBRARY</div>
        <input
          placeholder="Find a node…"
          aria-label="Search nodes"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
        {flowKinds
          .filter((k) => k.includes(search.toLowerCase()))
          .map((kind) => (
            <button className="catalog-item" key={kind} onClick={() => add(kind)}>
              <span className="catalog-icon">
                {
                  {
                    trigger: 'ϟ',
                    action: '✦',
                    delay: '◷',
                    condition: '◇',
                    switch: '⑂',
                    set: '{}',
                    parallel: '⇶',
                    repeat: '↻',
                    foreach: '≡',
                    subflow: '⑂',
                    return: '↵'
                  }[kind]
                }
              </span>
              {kind === 'foreach' ? 'For Each' : kind[0].toUpperCase() + kind.slice(1)}
              <span className="push">+</span>
            </button>
          ))}
        <p className="hint">
          Connect output ports to control execution. Parallel “next” runs after its branches join.
          Loop “next” runs after the body completes.
        </p>
      </aside>
      {flow ? (
        <>
          <section className="flow-center">
            <div className="flow-toolbar">
              <div>
                <strong>{flow.name}</strong>
                <small className="muted">
                  Revision {flow.revision} · {flow.nodes.length} nodes
                </small>
              </div>
              <span className={`badge ${errors.length ? 'invalid' : ''}`}>
                {errors.length ? `${errors.length} ISSUES` : 'VALID'}
              </span>
              <button
                className="primary push"
                disabled={dirty || errors.length > 0 || run?.status === 'running'}
                onClick={() => perform(() => window.decker.run(flow.id, runInput))}
              >
                <Play size={15} />
                Run
              </button>
              <button
                className="secondary"
                disabled={run?.status !== 'running'}
                onClick={() => perform(() => window.decker.cancel(run!.id))}
              >
                <Square size={15} />
                Stop
              </button>
            </div>
            <ReactFlow
              nodes={nodes}
              edges={flow.edges.map((e) => ({
                ...e,
                sourceHandle: e.port,
                label: e.port === 'next' ? '' : e.port,
                animated: run?.status === 'running'
              }))}
              nodeTypes={nodeTypes}
              onNodesChange={changes}
              onNodeClick={(_, n) => setSelected(n.id)}
              onPaneClick={() => setSelected('')}
              onConnect={connect}
              onEdgesDelete={(edges) =>
                mutate((f) => {
                  f.edges = f.edges.filter((e) => !edges.some((x) => x.id === e.id))
                })
              }
              fitView
              minZoom={0.2}
              maxZoom={1.5}
              deleteKeyCode="Delete"
            >
              <Background color="#45474e" gap={24} />
              <Controls />
              <MiniMap nodeColor="var(--accent)" maskColor="#1e1f2280" />
            </ReactFlow>
            {errors.length > 0 && (
              <div className="validation">
                <strong>Resolve before saving or running</strong>
                {errors.map((e) => (
                  <div key={e}>{e}</div>
                ))}
              </div>
            )}
          </section>
          <aside className="properties flow-inspector">
            <div className="section-label">
              {current ? 'NODE PROPERTIES' : 'WORKFLOW PROPERTIES'}
            </div>
            {current ? (
              <>
                <label className="field">
                  Node label
                  <input
                    value={current.label}
                    onChange={(e) =>
                      edit((n) => {
                        n.label = e.target.value
                      })
                    }
                  />
                </label>
                <label className="field">
                  Node ID
                  <input readOnly value={current.id} />
                </label>
                {current.kind === 'action' && (
                  <>
                    <label className="field">
                      Action
                      <select
                        value={current.action?.type ?? ''}
                        onChange={(e) =>
                          edit((n) => {
                            n.action = newAction(e.target.value)
                          })
                        }
                      >
                        {definitions.map((d) => (
                          <option key={d.id} value={d.id}>
                            {d.name}
                          </option>
                        ))}
                      </select>
                    </label>
                    {current.action && (
                      <ActionEditor
                        action={current.action}
                        onChange={(a) =>
                          edit((n) => {
                            n.action = a
                          })
                        }
                      />
                    )}
                  </>
                )}
                {current.kind === 'subflow' && (
                  <label className="field">
                    Pinned subflow
                    <select
                      value={String(current.config.workflowId ?? '')}
                      onChange={(e) =>
                        edit((n) => {
                          const w = c.workflows.find((w) => w.id === e.target.value)
                          n.config.workflowId = w?.id ?? ''
                          n.config.revision = w?.revision ?? 1
                        })
                      }
                    >
                      <option value="">Choose workflow</option>
                      {c.workflows
                        .filter((w) => w.id !== flow.id)
                        .map((w) => (
                          <option key={w.id} value={w.id}>
                            {w.name} · v{w.revision}
                          </option>
                        ))}
                    </select>
                  </label>
                )}
                {current.kind !== 'action' && current.kind !== 'trigger' && (
                  <JsonEditor
                    value={current.config}
                    onChange={(v) => {
                      if (v && typeof v === 'object' && !Array.isArray(v))
                        edit((n) => {
                          n.config = v
                        })
                    }}
                  />
                )}
                <label className="field">
                  Timeout (ms)
                  <input
                    type="number"
                    min="1"
                    max="300000"
                    value={current.timeoutMs}
                    onChange={(e) =>
                      edit((n) => {
                        n.timeoutMs = Number(e.target.value)
                      })
                    }
                  />
                </label>
                <label className="check">
                  <input
                    type="checkbox"
                    checked={current.retrySafe}
                    onChange={(e) =>
                      edit((n) => {
                        n.retrySafe = e.target.checked
                      })
                    }
                  />
                  This operation is safe to retry
                </label>
                <label className="field">
                  Retries (0–5)
                  <input
                    type="number"
                    min="0"
                    max="5"
                    value={current.retries}
                    onChange={(e) =>
                      edit((n) => {
                        n.retries = Number(e.target.value)
                      })
                    }
                  />
                </label>
                <details>
                  <summary>Output ports & field picker</summary>
                  <p className="muted">
                    Select a field to copy its binding. Use a fallback when a condition may skip its
                    producer.
                  </p>
                  {[
                    'inputs',
                    'vars',
                    ...flow.nodes.filter((n) => n.id !== current.id).map((n) => `nodes.${n.id}`)
                  ].map((path) => (
                    <button
                      key={path}
                      className="binding-chip"
                      onClick={() => {
                        void navigator.clipboard.writeText(`{{${path}}}`)
                      }}
                    >{`{{${path}}}`}</button>
                  ))}
                  <label className="field">
                    Connect port
                    <select id="port-target" defaultValue="">
                      <option value="">Target node</option>
                      {flow.nodes
                        .filter((n) => n.id !== current.id)
                        .map((n) => (
                          <option key={n.id} value={n.id}>
                            {n.label}
                          </option>
                        ))}
                    </select>
                  </label>
                  <label className="field">
                    Port name
                    <input id="port-name" defaultValue="next" />
                  </label>
                  <button
                    className="secondary"
                    onClick={() => {
                      const target = (document.getElementById('port-target') as HTMLSelectElement)
                          .value,
                        port = (document.getElementById('port-name') as HTMLInputElement).value
                      if (target)
                        connect({
                          source: current.id,
                          target,
                          sourceHandle: port,
                          targetHandle: null
                        })
                    }}
                  >
                    Connect custom port
                  </button>
                </details>
                <button
                  className="danger full"
                  onClick={() => {
                    mutate((f) => {
                      f.nodes = f.nodes.filter((n) => n.id !== selected)
                      f.edges = f.edges.filter(
                        (e) => e.source !== selected && e.target !== selected
                      )
                    })
                    setSelected('')
                  }}
                >
                  <Trash2 size={15} />
                  Delete node
                </button>
              </>
            ) : (
              <>
                <label className="field">
                  Workflow name
                  <input
                    value={flow.name}
                    onChange={(e) =>
                      mutate((f) => {
                        f.name = e.target.value
                      })
                    }
                  />
                </label>
                <label className="field">
                  Run timeout (ms)
                  <input
                    type="number"
                    value={flow.timeoutMs}
                    onChange={(e) =>
                      mutate((f) => {
                        f.timeoutMs = Number(e.target.value)
                      })
                    }
                  />
                </label>
                <JsonEditor
                  label="Declared inputs"
                  value={flow.inputs}
                  onChange={(v) => {
                    if (Array.isArray(v) && v.every((x) => typeof x === 'string'))
                      mutate((f) => {
                        f.inputs = v as string[]
                      })
                  }}
                />
                <JsonEditor
                  label="Declared outputs"
                  value={flow.outputs}
                  onChange={(v) => {
                    if (Array.isArray(v) && v.every((x) => typeof x === 'string'))
                      mutate((f) => {
                        f.outputs = v as string[]
                      })
                  }}
                />
                <JsonEditor
                  label="Test inputs"
                  value={runInput}
                  onChange={(v) => {
                    if (v && typeof v === 'object' && !Array.isArray(v)) setRunInput(v)
                  }}
                />
                <p className="hint">
                  Choose a node to configure its action, data bindings, timeout and error routing.
                  Connect the error port to recover from a failed operation.
                </p>
                <button
                  className="secondary full"
                  onClick={() => {
                    const id = uid()
                    update((c) =>
                      c.workflows.push({
                        ...structuredClone(flow),
                        id,
                        name: flow.name + ' copy',
                        revision: 1
                      })
                    )
                    setFlowId(id)
                  }}
                >
                  Duplicate workflow
                </button>
                <button
                  className="danger full"
                  disabled={c.profiles.some((p) =>
                    p.pages.some((pg) =>
                      Object.values(pg.keys).some((b) => b.workflowId === flow.id)
                    )
                  )}
                  onClick={() => {
                    update((c) => {
                      c.workflows = c.workflows.filter((w) => w.id !== flow.id)
                    })
                    setFlowId('')
                  }}
                >
                  Delete workflow
                </button>
              </>
            )}
          </aside>
        </>
      ) : (
        <div className="empty-state">Create a workflow to begin.</div>
      )}
    </div>
  )
}
