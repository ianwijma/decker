import { memo, useLayoutEffect, useMemo, useRef, useState } from "react";
import {
  ReactFlow,
  Background,
  Controls,
  MiniMap,
  Handle,
  Position,
  useNodesState,
  useUpdateNodeInternals,
  type NodeProps,
  type Node as CanvasNode,
  type NodeChange,
  type Connection,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import { ArrowLeft, Play, Plus, Search, Square, Trash2 } from "lucide-react";
import { useApp } from "./store";
import { node, uid } from "../../shared/defaults";
import { catalog, makeAction } from "../../shared/catalog";
import type {
  FlowNode,
  Graph,
  Json,
  RunRecord,
  WorkflowDefinition,
} from "../../shared/schema";
import { validateWorkflow } from "../../runtime/validate";
import {
  ActionFields,
  ActionSelect,
  FieldLabel,
  JsonEditor,
} from "./components";
import {
  changedLayout,
  graphNodes,
  reconcileNodes,
  type FlowData,
  type FlowCanvasNode,
} from "./flow-canvas";
import {
  createLatestFlowRunSelector,
  selectFlowWorkflows,
  selectWorkflowAliases,
} from "./flow-selectors";
import "./flow-canvas.css";
import { WorkflowDropdown } from "./WorkflowDropdown";
type Path = Array<{ nodeId: string; branch?: number }>;
function WorkflowNode({ id, data, selected }: NodeProps<CanvasNode<FlowData>>) {
  const updateNodeInternals = useUpdateNodeInternals();
  const ports = JSON.stringify(data.ports);
  useLayoutEffect(() => {
    updateNodeInternals(id);
  }, [id, ports, updateNodeInternals]);
  return (
    <div
      className={`flow-node ${selected ? "selected" : ""} ${data.status ?? ""}`}
    >
      <Handle type="target" position={Position.Left} />
      <div className="flow-node-icon">{data.icon}</div>
      <div>
        <small>{data.kind}</small>
        <strong>{data.name}</strong>
      </div>
      {data.ports.map((port, index) => (
        <Handle
          key={port}
          id={port}
          type="source"
          position={Position.Right}
          style={{ top: `${((index + 1) / (data.ports.length + 1)) * 100}%` }}
          title={port}
        />
      ))}
      <div className="port-labels">
        {data.ports.filter((p) => p !== "next").join(" · ")}
      </div>
    </div>
  );
}
const nodeTypes = { workflow: WorkflowNode };
const blocks: Array<{ kind: FlowNode["kind"]; name: string; icon: string }> = [
  { kind: "trigger", name: "Trigger", icon: "ϟ" },
  { kind: "delay", name: "Delay", icon: "◷" },
  { kind: "condition", name: "Condition", icon: "◇" },
  { kind: "switch", name: "Switch", icon: "⋔" },
  { kind: "set", name: "Set / map data", icon: "{}" },
  { kind: "parallel", name: "Parallel / join", icon: "⑂" },
  { kind: "repeat", name: "Repeat", icon: "↻" },
  { kind: "foreach", name: "For each", icon: "↻" },
  { kind: "subflow", name: "Call subflow", icon: "⤷" },
  { kind: "return", name: "Return", icon: "↵" },
];
const emptyGraph = (): Graph => {
  const first = node("set", "Branch result");
  first.config = { result: "done" };
  return { entry: first.id, nodes: [first], edges: [] };
};
function at(graph: Graph, path: Path): Graph {
  let result = graph;
  for (const step of path) {
    const parent = result.nodes.find((n) => n.id === step.nodeId)!;
    result =
      step.branch === undefined ? parent.body! : parent.branches![step.branch];
  }
  return result;
}
function newNode(kind: FlowNode["kind"], name: string): FlowNode {
  const n = node(kind, name);
  switch (kind) {
    case "delay":
      n.config = { ms: 1000 };
      break;
    case "condition":
      n.config = { left: true, operator: "equals", right: true };
      break;
    case "switch":
      n.config = { value: "ready", cases: ["ready", "waiting"] };
      break;
    case "set":
      n.config = { message: "Hello" };
      break;
    case "parallel":
      n.config = { mode: "fail-fast" };
      n.branches = [emptyGraph(), emptyGraph()];
      break;
    case "repeat":
      n.config = { count: 3, maxIterations: 100 };
      n.body = emptyGraph();
      break;
    case "foreach":
      n.config = { items: ["one", "two"], maxIterations: 100, concurrency: 1 };
      n.body = emptyGraph();
      break;
    case "subflow":
      n.config = { workflowId: "", revision: 1, inputs: {} };
      break;
    case "return":
      n.config = { result: { $ref: "inputs" } };
      break;
  }
  return n;
}
function FlowCanvas({
  workflow,
  graph,
  latest,
  selected,
  onSelect,
  update,
  connect,
}: {
  workflow: WorkflowDefinition;
  graph: Graph;
  latest: RunRecord | undefined;
  selected: string;
  onSelect: (id: string) => void;
  update: (fn: (workflow: WorkflowDefinition, graph: Graph) => void) => void;
  connect: (connection: Connection) => void;
}) {
  const source = useMemo(
    () => graphNodes(graph, workflow.layout, latest),
    [graph, workflow.layout, latest],
  );
  const previousSource = useRef(source);
  const [nodes, setNodes, applyChanges] = useNodesState<FlowCanvasNode>(
    source.map((n) => ({ ...n, selected: n.id === selected })),
  );
  useLayoutEffect(() => {
    const before = previousSource.current;
    setNodes((previous) => reconcileNodes(previous, source, before, selected));
    previousSource.current = source;
  }, [source, selected, setNodes]);
  const persistPositions = (moved: FlowCanvasNode[]) => {
    const changed = changedLayout(moved, workflow.layout);
    if (changed.length)
      update((f, g) => {
        for (const n of changed)
          if (g.nodes.some((node) => node.id === n.id))
            f.layout[n.id] = { ...n.position };
      });
  };
  const nodeChanges = (changes: NodeChange<FlowCanvasNode>[]) => {
    applyChanges(changes);
    const selection = changes.findLast(
      (c) => c.type === "select" && c.selected,
    );
    if (selection?.type === "select") onSelect(selection.id);
    const removed = changes.filter((c) => c.type === "remove").map((c) => c.id);
    if (removed.length) {
      update((f, g) => {
        g.nodes = g.nodes.filter((n) => !removed.includes(n.id));
        g.edges = g.edges.filter(
          (e) => !removed.includes(e.source) && !removed.includes(e.target),
        );
        for (const id of removed) delete f.layout[id];
      });
      if (removed.includes(selected)) onSelect("");
    }
    // Arrow-key movement has no drag-stop event. Measurement and selection are local only.
    const keyboardMoves = changes.flatMap((c) =>
      c.type === "position" && c.position && c.dragging !== true
        ? nodes
            .filter((n) => n.id === c.id && !n.dragging)
            .map((n) => ({ ...n, position: c.position! }))
        : [],
    );
    if (keyboardMoves.length) persistPositions(keyboardMoves);
  };
  const edges = useMemo(
    () =>
      graph.edges.map((e) => ({
        id: e.id,
        source: e.source,
        target: e.target,
        sourceHandle: e.port,
        label: e.port === "next" ? "" : e.port,
        animated: latest?.status === "running",
      })),
    [graph.edges, latest?.status],
  );
  return (
    <ReactFlow
      nodes={nodes}
      edges={edges}
      nodeTypes={nodeTypes}
      onNodeClick={(_e, n) => onSelect(n.id)}
      onPaneClick={() => onSelect("")}
      onNodesChange={nodeChanges}
      onNodeDragStop={(_event, _node, moved) => persistPositions(moved)}
      onSelectionDragStop={(_event, moved) => persistPositions(moved)}
      onEdgesDelete={(removed) =>
        update((_f, g) => {
          g.edges = g.edges.filter((e) => !removed.some((x) => x.id === e.id));
        })
      }
      onConnect={connect}
      fitView
      colorMode="dark"
      minZoom={0.25}
      maxZoom={1.6}
    >
      <Background gap={24} size={1} />
      <Controls />
      <MiniMap pannable zoomable nodeColor="var(--accent)" />
    </ReactFlow>
  );
}

export const Flows = memo(function Flows() {
  const edit = useApp((state) => state.edit),
    request = useApp((state) => state.request);
  const workflows = useApp(selectFlowWorkflows);
  const aliases = useApp(selectWorkflowAliases);
  const doc = { workflows };
  const [flowId, setFlowId] = useState(doc.workflows[0]?.id ?? ""),
    [selected, setSelected] = useState(""),
    [search, setSearch] = useState(""),
    [path, setPath] = useState<Path>([]),
    [runInputs, setRunInputs] = useState<Json>({});
  const nameInput = useRef<HTMLInputElement>(null),
    focusNameFor = useRef<string | undefined>(undefined);
  const workflow =
    doc.workflows.find((f) => f.id === flowId) ?? doc.workflows[0];
  useLayoutEffect(() => {
    if (workflow && focusNameFor.current === workflow.id) {
      nameInput.current?.focus();
      nameInput.current?.select();
      focusNameFor.current = undefined;
    }
  }, [workflow?.id]);
  const graph = workflow ? at(workflow.graph, path) : undefined,
    current = graph?.nodes.find((n) => n.id === selected);
  const update = (fn: (workflow: WorkflowDefinition, graph: Graph) => void) => {
    if (workflow)
      edit((d) => {
        const f = d.workflows.find((f) => f.id === workflow.id)!;
        fn(f, at(f.graph, path));
      });
  };
  const updateNode = (fn: (node: FlowNode) => void) =>
    update((_f, g) => {
      const n = g.nodes.find((n) => n.id === selected);
      if (n) fn(n);
    });
  const add = (kind: FlowNode["kind"], name: string, action?: string) => {
    if (!workflow) return;
    const n = newNode(kind, name);
    if (action) n.action = makeAction(action);
    update((f, g) => {
      const previous = g.nodes.find((n) => n.id === selected) ?? g.nodes.at(-1);
      g.nodes.push(n);
      if (
        previous &&
        !g.edges.some((e) => e.source === previous.id && e.port === "next") &&
        !["condition", "switch", "return"].includes(previous.kind)
      )
        g.edges.push({
          id: uid(),
          source: previous.id,
          target: n.id,
          port: "next",
        });
      if (g.nodes.length === 1) g.entry = n.id;
      f.layout[n.id] = {
        x: 80 + ((g.nodes.length - 1) % 3) * 270,
        y: 100 + Math.floor((g.nodes.length - 1) / 3) * 170,
      };
    });
    setSelected(n.id);
  };
  const selectLatestRun = useMemo(
    () => createLatestFlowRunSelector(workflow?.id),
    [workflow?.id],
  );
  const latest = useApp(selectLatestRun);
  const issues = workflow
    ? validateWorkflow(workflow, doc.workflows, aliases)
    : [];
  const connect = (connection: Connection) =>
    update((_f, g) => {
      const port = connection.sourceHandle ?? "next";
      g.edges = g.edges.filter(
        (e) => !(e.source === connection.source && e.port === port),
      );
      g.edges.push({
        id: uid(),
        source: connection.source,
        target: connection.target,
        port,
      });
    });
  return (
    <div className="workspace flow-workspace">
      <aside className="secondary-sidebar">
        <div className="section-heading">
          YOUR WORKFLOWS
          <button
            className="icon-button"
            aria-label="Create workflow"
            onClick={() => {
              const first = node("trigger", "Deck press"),
                id = uid();
              edit((d) => {
                d.workflows.push({
                  id,
                  name: `Workflow ${d.workflows.length + 1}`,
                  revision: 1,
                  graph: { entry: first.id, nodes: [first], edges: [] },
                  inputs: [],
                  outputs: [],
                  timeoutMs: 300000,
                  layout: { [first.id]: { x: 80, y: 140 } },
                });
              });
              setFlowId(id);
              setPath([]);
              setSelected("");
              focusNameFor.current = id;
            }}
          >
            <Plus size={17} />
          </button>
        </div>
        <WorkflowDropdown
          workflows={doc.workflows}
          aliases={aliases}
          value={workflow?.id}
          onSelect={(id) => {
            setFlowId(id);
            setPath([]);
            setSelected("");
          }}
        />
        <div className="sidebar-divider" />
        <div className="section-heading">NODE LIBRARY</div>
        <div className="search">
          <Search size={16} />
          <input
            aria-label="Search nodes"
            placeholder="Find a node"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
        </div>
        <h3 className="palette-heading">Flow control</h3>
        {blocks
          .filter((b) => b.name.toLowerCase().includes(search.toLowerCase()))
          .map((b) => (
            <button
              className="catalog-action"
              key={b.kind}
              aria-label={`Add ${b.name} node`}
              onClick={() => add(b.kind, b.name)}
            >
              <span className="action-icon">{b.icon}</span>
              {b.name}
              <Plus size={13} />
            </button>
          ))}
        <h3 className="palette-heading">Actions</h3>
        {catalog
          .filter((a) => a.name.toLowerCase().includes(search.toLowerCase()))
          .map((a) => (
            <button
              key={a.id}
              className="catalog-action"
              aria-label={`Add ${a.name} node`}
              onClick={() => add("action", a.name, a.id)}
            >
              <span className={`action-icon group-${a.group.toLowerCase()}`}>
                {a.icon}
              </span>
              {a.name}
              <Plus size={13} />
            </button>
          ))}
      </aside>
      <main className="flow-main">
        {workflow ? (
          <>
            <div className="flow-toolbar">
              <div className="workflow-name-editor">
                <div className="eyebrow">
                  WORKFLOW STUDIO · REVISION {workflow.revision}
                </div>
                <input
                  ref={nameInput}
                  className="workflow-name-input"
                  aria-label="Workflow name"
                  value={workflow.name}
                  onChange={(e) =>
                    update((f) => {
                      f.name = e.target.value || "Untitled";
                    })
                  }
                />
              </div>
              <div className="grow" />
              {latest?.status === "running" ? (
                <button
                  onClick={() =>
                    void request({ type: "cancel", runId: latest.id })
                  }
                >
                  <Square size={15} /> Stop run
                </button>
              ) : (
                <button
                  className="primary"
                  disabled={issues.length > 0}
                  onClick={() =>
                    void request({
                      type: "run",
                      workflowId: workflow.id,
                      inputs: runInputs as Record<string, Json>,
                    })
                  }
                >
                  <Play size={15} /> Run workflow
                </button>
              )}
            </div>
            {path.length > 0 && (
              <div className="scope-bar">
                <button
                  onClick={() => {
                    setPath(path.slice(0, -1));
                    setSelected("");
                  }}
                >
                  <ArrowLeft size={14} /> Parent flow
                </button>
                <span>
                  Nested{" "}
                  {path.at(-1)?.branch === undefined
                    ? "loop body"
                    : `parallel branch ${path.at(-1)!.branch! + 1}`}{" "}
                  · changes saved with parent
                </span>
              </div>
            )}
            <div className="flow-canvas">
              <FlowCanvas
                key={JSON.stringify([workflow.id, path])}
                workflow={workflow}
                graph={graph!}
                latest={latest}
                selected={selected}
                onSelect={setSelected}
                update={update}
                connect={connect}
              />
            </div>
            <div
              className={`validation-bar ${issues.length ? "has-issues" : ""}`}
            >
              <span>
                {issues.length
                  ? `${issues.length} validation issue${issues.length === 1 ? "" : "s"}`
                  : "✓ Workflow is ready"}
              </span>
              <span>
                {graph!.nodes.length} nodes · {graph!.edges.length} connections
                · {latest ? `Last run: ${latest.status}` : "Never run"}
              </span>
            </div>
            {issues.length > 0 && (
              <ul className="validation-errors">
                {issues.map((issue) => (
                  <li key={issue}>{issue}</li>
                ))}
              </ul>
            )}
          </>
        ) : (
          <div className="empty-state">
            <h1>Your next great shortcut starts here.</h1>
            <p>Create a workflow using the + button.</p>
          </div>
        )}
      </main>
      <aside className="inspector">
        {workflow && (
          <>
            {current ? (
              <>
                <div className="inspector-title">
                  <div>
                    <div className="eyebrow">NODE PROPERTIES</div>
                    <h2>{current.kind}</h2>
                  </div>
                  <button
                    className="icon-button"
                    aria-label="Delete node"
                    onClick={() => {
                      update((_f, g) => {
                        g.nodes = g.nodes.filter((n) => n.id !== selected);
                        g.edges = g.edges.filter(
                          (e) => e.source !== selected && e.target !== selected,
                        );
                      });
                      setSelected("");
                    }}
                  >
                    <Trash2 size={17} />
                  </button>
                </div>
                <FieldLabel label="Node name">
                  <input
                    aria-label="Node name"
                    value={current.name}
                    onChange={(e) =>
                      updateNode((n) => {
                        n.name = e.target.value;
                      })
                    }
                  />
                </FieldLabel>
                <small className="muted code">ID: {current.id}</small>
                {current.kind === "action" && current.action && (
                  <>
                    <ActionSelect
                      value={current.action.type}
                      onChange={(type) =>
                        updateNode((n) => {
                          n.action = makeAction(type);
                        })
                      }
                    />
                    <ActionFields
                      action={current.action}
                      onChange={(action) =>
                        updateNode((n) => {
                          n.action = action;
                        })
                      }
                      bindings
                      available={[
                        ...workflow.inputs.map((i) => `inputs.${i}`),
                        ...graph!.nodes
                          .filter((n) => n.id !== selected)
                          .map((n) => `outputs.${n.id}`),
                        "vars",
                        "item",
                        "index",
                        "error",
                      ]}
                    />
                  </>
                )}
                {current.kind === "subflow" && (
                  <FieldLabel label="Subflow">
                    {current.config.workflowId &&
                    typeof current.config.workflowId === "object" ? (
                      <p className="muted small">
                        Workflow selected by data reference below.
                      </p>
                    ) : (
                      <WorkflowDropdown
                        label="Subflow"
                        workflows={doc.workflows.filter(
                          (f) => f.id !== workflow.id,
                        )}
                        aliases={aliases}
                        value={String(current.config.workflowId ?? "")}
                        onSelect={(id) => {
                          const child = doc.workflows.find((f) => f.id === id)!;
                          updateNode((n) => {
                            n.config = {
                              ...n.config,
                              workflowId: child.id,
                              revision: child.revision,
                            };
                          });
                        }}
                      />
                    )}
                    <small>
                      Selected revision:{" "}
                      {String(current.config.revision ?? "Choose a workflow")}.
                      Edit Configuration to pin a revision.
                    </small>
                  </FieldLabel>
                )}
                {current.kind !== "trigger" && current.kind !== "action" && (
                  <JsonEditor
                    label="Configuration"
                    value={
                      current.kind === "subflow" &&
                      typeof current.config.workflowId === "string"
                        ? Object.fromEntries(
                            Object.entries(current.config).filter(
                              ([key]) => key !== "workflowId",
                            ),
                          )
                        : current.config
                    }
                    onChange={(value) => {
                      if (
                        value &&
                        typeof value === "object" &&
                        !Array.isArray(value)
                      )
                        updateNode((n) => {
                          n.config =
                            n.kind === "subflow" &&
                            !Object.hasOwn(value, "workflowId")
                              ? { ...value, workflowId: n.config.workflowId }
                              : value;
                        });
                    }}
                    hint={
                      current.kind === "subflow"
                        ? 'The name selector sets the workflow. Pin its revision here, or add workflowId: { "$ref": "inputs.workflow" } for a data reference.'
                        : current.kind === "condition"
                          ? "Operators: equals, notEquals, greater, less, contains, truthy."
                          : current.kind === "parallel"
                            ? "mode: fail-fast or collect. Every branch has its own scope."
                            : current.kind === "foreach"
                              ? "items accepts an array or a data reference. concurrency: 1–16."
                              : 'Use { "$ref": "outputs.node-id.field", "fallback": null } to bind data.'
                    }
                  />
                )}
                {current.body && (
                  <button
                    className="primary wide"
                    onClick={() => {
                      setPath([...path, { nodeId: current.id }]);
                      setSelected("");
                    }}
                  >
                    Edit loop body →
                  </button>
                )}
                {current.branches && (
                  <>
                    <h3>Parallel branches</h3>
                    {current.branches.map((_b, index) => (
                      <button
                        className="wide branch-button"
                        key={index}
                        onClick={() => {
                          setPath([
                            ...path,
                            { nodeId: current.id, branch: index },
                          ]);
                          setSelected("");
                        }}
                      >
                        Edit branch {index + 1} →
                      </button>
                    ))}
                    <button
                      disabled={current.branches.length >= 16}
                      onClick={() =>
                        updateNode((n) => {
                          n.branches!.push(emptyGraph());
                        })
                      }
                    >
                      <Plus size={14} /> Add branch
                    </button>
                    <button
                      disabled={current.branches.length < 2}
                      onClick={() =>
                        updateNode((n) => {
                          n.branches!.pop();
                        })
                      }
                    >
                      Remove last branch
                    </button>
                    <p className="muted small">
                      This node joins its own branches before following the next
                      connection.
                    </p>
                  </>
                )}
                <details>
                  <summary>Timeouts & retries</summary>
                  <FieldLabel label="Node timeout (ms)">
                    <input
                      type="number"
                      min={10}
                      max={3600000}
                      value={current.timeoutMs}
                      onChange={(e) =>
                        updateNode((n) => {
                          n.timeoutMs = Number(e.target.value);
                        })
                      }
                    />
                  </FieldLabel>
                  <FieldLabel label="Retries">
                    <input
                      type="number"
                      min={0}
                      max={5}
                      value={current.retries}
                      onChange={(e) =>
                        updateNode((n) => {
                          n.retries = Number(e.target.value);
                        })
                      }
                    />
                  </FieldLabel>
                  <label className="checkbox-row">
                    <input
                      type="checkbox"
                      checked={current.retrySafe}
                      onChange={(e) =>
                        updateNode((n) => {
                          n.retrySafe = e.target.checked;
                        })
                      }
                    />{" "}
                    I confirm repeating this action is safe
                  </label>
                </details>
                <button
                  className="wide"
                  onClick={() =>
                    update((_f, g) => {
                      g.entry = current.id;
                    })
                  }
                  disabled={graph!.entry === current.id}
                >
                  {graph!.entry === current.id
                    ? "Entry node"
                    : "Make entry node"}
                </button>
                <details>
                  <summary>Connections</summary>
                  {graph!.edges
                    .filter((e) => e.source === current.id)
                    .map((edge) => (
                      <div className="row" key={edge.id}>
                        <small>
                          {edge.port} →{" "}
                          {graph!.nodes.find((n) => n.id === edge.target)?.name}
                        </small>
                        <button
                          aria-label={`Remove ${edge.port} connection`}
                          onClick={() =>
                            update((_f, g) => {
                              g.edges = g.edges.filter((e) => e.id !== edge.id);
                            })
                          }
                        >
                          ×
                        </button>
                      </div>
                    ))}
                  <p className="muted small">
                    Drag an output handle to another node. Error outputs recover
                    with structured error data.
                  </p>
                </details>
              </>
            ) : (
              <>
                <div className="eyebrow">WORKFLOW SETTINGS</div>
                <h2>Make it flow.</h2>
                <p className="muted">
                  Select a node to configure it. Connect handles to define the
                  order of work.
                </p>
                <FieldLabel label="Run timeout (ms)">
                  <input
                    type="number"
                    value={workflow.timeoutMs}
                    onChange={(e) =>
                      update((f) => {
                        f.timeoutMs = Number(e.target.value);
                      })
                    }
                  />
                </FieldLabel>
                <JsonEditor
                  label="Declared inputs"
                  value={workflow.inputs}
                  onChange={(v) => {
                    if (
                      Array.isArray(v) &&
                      v.every((x) => typeof x === "string")
                    )
                      update((f) => {
                        f.inputs = v as string[];
                      });
                  }}
                />
                <JsonEditor
                  label="Declared outputs"
                  value={workflow.outputs}
                  onChange={(v) => {
                    if (
                      Array.isArray(v) &&
                      v.every((x) => typeof x === "string")
                    )
                      update((f) => {
                        f.outputs = v as string[];
                      });
                  }}
                />
                <JsonEditor
                  label="Test inputs"
                  value={runInputs}
                  onChange={(v) => {
                    if (v && typeof v === "object" && !Array.isArray(v))
                      setRunInputs(v);
                  }}
                />
                <p className="muted small">
                  Running workflows keep their current revision when you edit.
                </p>
                <button
                  className="wide"
                  onClick={() => {
                    const copy = structuredClone(workflow);
                    copy.id = uid();
                    copy.name += " copy";
                    copy.revision = 1;
                    edit((d) => {
                      d.workflows.push(copy);
                    });
                    setFlowId(copy.id);
                    setPath([]);
                  }}
                >
                  Duplicate workflow
                </button>
                <button
                  className="danger wide"
                  onClick={() => {
                    edit((d) => {
                      d.workflows = d.workflows.filter(
                        (f) => f.id !== workflow.id,
                      );
                    });
                    setPath([]);
                    setSelected("");
                  }}
                >
                  Delete workflow
                </button>
              </>
            )}
          </>
        )}
      </aside>
    </div>
  );
});
