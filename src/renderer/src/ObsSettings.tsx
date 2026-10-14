import { useLayoutEffect, useRef, useState } from "react";
import { Plus, Trash2 } from "lucide-react";
import type { AppDocument } from "../../shared/schema";
import {
  obsUrlSchema,
  type ObsTestRequest,
  type ObsTestResult,
} from "../../shared/obs-contract";
import { InlineSecret, SecretEntry } from "./InlineSecret";
import { useApp } from "./store";
import "./obs-settings.css";
type Connection = AppDocument["connections"][number];
const ownerOf = (c: Connection) => JSON.stringify(["connection", c.id]);

function useObsTest(epoch?: string) {
  const [result, setResult] = useState<ObsTestResult>();
  const [testing, setTesting] = useState(false);
  const revision = useRef(0),
    active = useRef<string | undefined>(undefined);
  const invalidate = () => {
    revision.current++;
    setResult(undefined);
    setTesting(false);
    if (active.current)
      void window.decker
        .request({ type: "obsCancel", id: active.current })
        .catch(() => {});
    active.current = undefined;
  };
  useLayoutEffect(() => {
    invalidate();
    return () => {
      revision.current++;
      if (active.current)
        void window.decker
          .request({ type: "obsCancel", id: active.current })
          .catch(() => {});
    };
  }, [epoch]);
  const test = async (
    target: ObsTestRequest["target"],
    credential: ObsTestRequest["credential"],
  ) => {
    invalidate();
    const current = revision.current,
      id = crypto.randomUUID();
    active.current = id;
    setTesting(true);
    try {
      const result = (await window.decker.request({
        type: "obsTest",
        id,
        target,
        credential,
      })) as ObsTestResult;
      if (current === revision.current) {
        setResult(result);
        setTesting(false);
        active.current = undefined;
      }
    } catch {
      if (current === revision.current) {
        setResult({
          id,
          status: "error",
          message: "Test could not be completed. Reopen this editor and retry.",
        });
        setTesting(false);
        active.current = undefined;
      }
    }
  };
  return { result, testing, invalidate, test };
}
function TestResult({
  result,
  label,
}: {
  result?: ObsTestResult;
  label: string;
}) {
  return (
    result && (
      <p
        role="status"
        className={`obs-test-result ${result.status === "success" ? "" : "muted"}`}
      >
        <strong>
          {label}:{" "}
          {result.status === "success"
            ? "Test passed"
            : "Test " + result.status.replaceAll("-", " ")}
        </strong>
        <br />
        {result.message}
      </p>
    )
  );
}
function ObsDraft({
  connection,
  done,
  busy,
}: {
  connection?: Connection;
  done: () => void;
  busy: (value: boolean) => void;
}) {
  const { snapshot, saving, request } = useApp();
  const state = snapshot!.credentialState!;
  const [name, setName] = useState(connection?.name ?? "OBS Studio");
  const [url, setUrl] = useState(connection?.url ?? "ws://127.0.0.1:4455");
  const [mode, setMode] = useState<"supplied" | "stored" | "none">(
    connection?.credentialRef ? "stored" : "supplied",
  );
  const [password, setPassword] = useState(""),
    [persist, setPersist] = useState(state.persistent);
  const [pending, setPending] = useState(false),
    [error, setError] = useState("");
  const mounted = useRef(true);
  const probe = useObsTest(state.epoch);
  const initialEpoch = useRef(state.epoch);
  useLayoutEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  useLayoutEffect(() => {
    if (connection && initialEpoch.current !== state.epoch && !pending) {
      setPassword("");
      done();
    }
  }, [state.epoch]);
  const valid =
    Boolean(name.trim()) &&
    obsUrlSchema.safeParse(url).success &&
    (mode !== "supplied" || Boolean(password));
  const credential = (): ObsTestRequest["credential"] =>
    mode === "supplied" ? { kind: mode, password } : { kind: mode };
  const save = async () => {
    if (!valid || pending || saving) return;
    probe.invalidate();
    setPending(true);
    busy(true);
    setError("");
    const secret = password;
    setPassword("");
    const result = await request({
      type: "obsSave",
      epoch: state.epoch,
      target: connection
        ? { kind: "saved", owner: ownerOf(connection) }
        : { kind: "new" },
      name,
      url,
      credential:
        mode === "supplied"
          ? {
              kind: "replace",
              password: secret,
              persist: state.persistent && persist,
            }
          : { kind: mode === "stored" ? "keep" : "none" },
    });
    busy(false);
    if (!mounted.current) return;
    setPending(false);
    if (result) done();
    else
      setError(
        "Connection was not saved. The previous connection is unchanged. Reopen the editor or re-enter your password and retry.",
      );
  };
  return (
    <div
      className="obs-draft"
      role="group"
      aria-label={connection ? `Edit ${connection.name}` : "New OBS connection"}
    >
      <h3>{connection ? `Edit ${connection.name}` : "Set up OBS"}</h3>
      <p>
        In OBS 28 or newer, open <strong>Tools → obs-websocket Settings</strong>
        , enable the WebSocket server and keep password authentication enabled.
        Copy its server address/port and password below.
      </p>
      <fieldset disabled={pending || saving}>
        <label className="field">
          <span>Connection name</span>
          <input
            aria-label="Connection name"
            maxLength={100}
            value={name}
            onChange={(e) => {
              probe.invalidate();
              setName(e.target.value);
            }}
          />
        </label>
        <label className="field">
          <span>WebSocket URL</span>
          <input
            aria-label="WebSocket URL"
            maxLength={2048}
            value={url}
            onChange={(e) => {
              probe.invalidate();
              setUrl(e.target.value);
              if (mode === "stored") {
                setMode("supplied");
                setPassword("");
              }
            }}
          />
          <small>
            Use ws://address:port (or wss:// with valid TLS). For this computer,
            start with ws://127.0.0.1:4455 and match the port shown in OBS.
          </small>
        </label>
        {!obsUrlSchema.safeParse(url).success && (
          <p className="danger-text">
            Enter a ws:// or wss:// URL without embedded credentials.
          </p>
        )}
        <label className="field">
          <span>Password choice</span>
          <select
            aria-label="Password choice"
            value={mode}
            onChange={(e) => {
              probe.invalidate();
              setPassword("");
              setMode(e.target.value as typeof mode);
            }}
          >
            <option value="supplied">
              {connection
                ? "Supply a replacement password"
                : "Enter OBS password"}
            </option>
            {connection && (
              <option value="stored">
                Use saved password for this address
              </option>
            )}
            <option value="none">
              No authentication — only if explicitly configured in OBS
            </option>
          </select>
        </label>
        {mode === "stored" && (
          <p>
            The saved owner password will be sent to this address when you test
            or save. Changing the address asks for a new choice.
          </p>
        )}
        {mode === "supplied" && (
          <fieldset className="inline-secret" aria-label="OBS draft password">
            <legend>OBS password</legend>
            <SecretEntry
              label="OBS password"
              value={password}
              onChange={(value) => {
                probe.invalidate();
                setPassword(value);
              }}
              persistent={state.persistent}
              persist={persist}
              onPersist={setPersist}
            />
          </fieldset>
        )}
        {mode === "none" && (
          <p>
            Use this only when the OBS server has authentication off. Saving
            detaches this connection's saved password.
          </p>
        )}
        <div className="row">
          <button
            disabled={!valid || probe.testing}
            onClick={() =>
              void probe.test(
                connection
                  ? {
                      kind: "saved",
                      owner: ownerOf(connection),
                      epoch: state.epoch,
                      url,
                    }
                  : { kind: "draft", url },
                credential(),
              )
            }
          >
            {probe.testing ? "Testing…" : "Test connection"}
          </button>
          <button
            className="primary"
            disabled={!valid}
            onClick={() => void save()}
          >
            {pending ? "Saving…" : "Save connection"}
          </button>
          <button onClick={done}>Cancel</button>
        </div>
      </fieldset>
      {probe.testing && <button onClick={probe.invalidate}>Cancel test</button>}
      <TestResult
        result={probe.result}
        label={`${connection ? "Edited connection" : "Draft"} ${name}`}
      />
      {error && <p role="alert">{error}</p>}
      <small>
        Testing is read-only and does not save or activate this draft.
      </small>
    </div>
  );
}
function SavedConnection({
  connection,
  edit,
}: {
  connection: Connection;
  edit: () => void;
}) {
  const { snapshot, saving, edit: editDocument } = useApp();
  const state = snapshot!.credentialState!,
    owner = ownerOf(connection);
  const probe = useObsTest(state.epoch);
  const observed = snapshot!.observed[`obs:${connection.id}`] as
    { connected?: boolean } | undefined;
  return (
    <div className="connection">
      <div className="row">
        <strong>{connection.name}</strong>
        <span className="tag">
          {observed?.connected ? "Runtime connected" : "Runtime disconnected"}
        </span>
        <button disabled={saving} onClick={edit}>
          Edit connection
        </button>
        <button
          disabled={saving || probe.testing}
          onClick={() =>
            void probe.test(
              { kind: "saved", owner, epoch: state.epoch, url: connection.url },
              { kind: connection.credentialRef ? "stored" : "none" },
            )
          }
        >
          {probe.testing ? "Testing…" : "Test connection"}
        </button>
        <button
          className="icon-button"
          disabled={saving}
          aria-label={`Delete ${connection.name}`}
          onClick={() => {
            probe.invalidate();
            editDocument((d) => {
              d.connections = d.connections.filter(
                (c) => c.id !== connection.id,
              );
            });
          }}
        >
          <Trash2 size={16} />
        </button>
      </div>
      <p className="muted">{connection.url}</p>
      <InlineSecret owner={owner} label="OBS password" />
      {probe.testing && <button onClick={probe.invalidate}>Cancel test</button>}
      <TestResult result={probe.result} label={connection.name} />
    </div>
  );
}
export function ObsSettings() {
  const { snapshot, saving } = useApp();
  const [editing, setEditing] = useState<string>();
  const [busy, setBusy] = useState(false);
  const connections = snapshot!.document.connections;
  const selected = connections.find((c) => c.id === editing);
  return (
    <section className="settings-card full-width obs-settings">
      <fieldset className="obs-settings-content" disabled={busy}>
        <div className="card-heading">
          <div>
            <h2>Connections</h2>
            <p>Connect OBS Studio through its built-in WebSocket server.</p>
          </div>
          <button
            disabled={saving || Boolean(editing)}
            onClick={() => setEditing("new")}
          >
            <Plus size={15} /> Add OBS
          </button>
        </div>
        <details>
          <summary>OBS setup help</summary>
          <p>
            WebSocket is built into OBS 28 and newer. Find the server and
            password under Tools → obs-websocket Settings. Use the server's
            configured port; 4455 is the standard starting point. Keep
            authentication enabled.
          </p>
          <a
            onClick={(event) => {
              event.preventDefault();
              void window.decker.request({ type: "obsHelp" }).catch(() => {});
            }}
            href="https://obsproject.com/kb/remote-control-guide"
            target="_blank"
            rel="noreferrer"
          >
            Official OBS remote control guide
          </a>
        </details>
        {editing && (editing === "new" || selected) && (
          <ObsDraft
            key={editing}
            connection={selected}
            done={() => setEditing(undefined)}
            busy={setBusy}
          />
        )}
        {!connections.length && !editing && (
          <p className="muted">
            No connections yet. Add OBS to set up and test a draft.
          </p>
        )}
        {connections.map((c) => (
          <SavedConnection
            key={c.id}
            connection={c}
            edit={() => setEditing(c.id)}
          />
        ))}
      </fieldset>
    </section>
  );
}
