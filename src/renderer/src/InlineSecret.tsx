import { useLayoutEffect, useRef, useState } from "react";
import { credentialOwners } from "../../shared/credential-owners";
import type { ActionInstance } from "../../shared/schema";
import { useApp } from "./store";
import "./inline-secret.css";

export function ActionSecret({
  action,
  scope,
}: {
  action: ActionInstance;
  scope: string;
}) {
  const owner = useApp(
    (state) =>
      state.snapshot &&
      credentialOwners(state.snapshot.document).find((o) => o.action === action)
        ?.key,
  );
  return owner ? (
    <InlineSecret
      key={`${scope}:${owner}`}
      owner={owner}
      label="Bearer token"
    />
  ) : (
    <p className="muted">Save this HTTP action to enter its bearer token.</p>
  );
}

export function InlineSecret({
  owner,
  label,
}: {
  owner: string;
  label: string;
}) {
  const { snapshot, saving, request } = useApp();
  const state = snapshot?.credentialState;
  const status = state?.owners[owner] ?? "missing";
  const [value, setValue] = useState("");
  const [persist, setPersist] = useState(Boolean(state?.persistent));
  const [pending, setPending] = useState(false);
  const [message, setMessage] = useState("");
  const revision = useRef(0);
  useLayoutEffect(() => {
    revision.current++;
    setValue("");
    setMessage("");
    setPending(false);
    return () => {
      revision.current++;
    };
  }, [owner, state?.epoch]);
  const submit = async (operation: "set" | "remove") => {
    if (!state) return;
    const current = ++revision.current;
    const secret = value;
    setValue("");
    setPending(true);
    setMessage("");
    const result = await request({
      type: "credential",
      owner,
      epoch: state.epoch,
      operation,
      value: operation === "set" ? secret : "",
      persist: operation === "set" && Boolean(state.persistent) && persist,
    });
    if (revision.current === current) {
      setPending(false);
      setMessage(
        result
          ? "Saved"
          : "Secret was not saved. Reopen this owner and try again.",
      );
    }
  };
  return (
    <fieldset
      className="inline-secret"
      aria-label={label}
      disabled={!state || saving || pending}
    >
      <legend>{label}</legend>
      <p role="status">
        {status === "locked"
          ? "Locked / unavailable · unlock the keyring and restart, or replace for this session."
          : status === "session-only"
            ? "Session-only · enter again after restart"
            : status === "configured"
              ? "Configured · stored with OS encryption"
              : "Missing · enter a password or token"}
      </p>
      <SecretEntry
        label={label}
        value={value}
        onChange={setValue}
        persistent={Boolean(state?.persistent)}
        persist={persist}
        onPersist={setPersist}
      />
      <div className="row">
        <button
          type="button"
          disabled={!value}
          onClick={() => void submit("set")}
        >
          {pending
            ? "Saving…"
            : status === "missing"
              ? "Save secret"
              : "Replace secret"}
        </button>
        <button
          type="button"
          disabled={
            !credentialOwners(snapshot!.document).find((o) => o.key === owner)
              ?.ref
          }
          onClick={() => void submit("remove")}
        >
          Remove secret
        </button>
      </div>
      <small>
        Changes apply to this owner. Copies and shared references keep their
        secret. Removal disconnects this owner; retained secrets protect
        existing revisions.
      </small>
      {message && <p role="status">{message}</p>}
    </fieldset>
  );
}

// Every supported HTTP owner (including nested graphs) remains reachable here.
export function ActionSecretOwners() {
  const owners = useApp((state) => state.snapshot?.document);
  return (
    owners && (
      <details>
        <summary>HTTP action secrets</summary>
        {credentialOwners(owners)
          .filter((o) => o.action)
          .map((o) => (
            <InlineSecret key={o.key} owner={o.key} label={o.label} />
          ))}
      </details>
    )
  );
}

// Shared presentation only; committed owners retain their owner+epoch submit path.
export function SecretEntry({
  label,
  value,
  onChange,
  persistent,
  persist,
  onPersist,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  persistent: boolean;
  persist: boolean;
  onPersist: (value: boolean) => void;
}) {
  return (
    <>
      <label className="field">
        <span>{label} entry</span>
        <input
          aria-label={`${label} entry`}
          type="password"
          autoComplete="new-password"
          maxLength={16000}
          value={value}
          onChange={(e) => onChange(e.target.value)}
        />
      </label>
      <label className="checkbox-row">
        <input
          type="checkbox"
          checked={persistent && persist}
          disabled={!persistent}
          onChange={(e) => onPersist(e.target.checked)}
        />{" "}
        Store with OS encryption
      </label>
      <small>
        {persistent
          ? "Uncheck for session-only storage."
          : "Secure storage is unavailable. Saving explicitly uses session-only storage."}
      </small>
    </>
  );
}
