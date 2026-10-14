import { useLayoutEffect, useRef, useState } from "react";
import { useApp } from "./store";
import type { ActionInstance } from "../../shared/schema";

// Locate the edited action in the saved document, including its owner IDs.
// Serialize path segments separately so IDs containing '/' cannot collide.
export function actionLocation(
  root: unknown,
  action: ActionInstance,
  path: string[] = [],
): string | undefined {
  if (root === action) return JSON.stringify(path);
  if (!root || typeof root !== "object") return undefined;
  for (const [key, value] of Object.entries(root)) {
    const owner =
      value &&
      typeof value === "object" &&
      "id" in value &&
      typeof value.id === "string"
        ? [value.id]
        : [];
    const found = actionLocation(value, action, [...path, key, ...owner]);
    if (found !== undefined) return found;
  }
  return undefined;
}

export function FilePickerButton({
  scope,
  action,
  fieldKey,
  picker = "openFile",
  label,
  onSelect,
}: {
  scope: string;
  action: ActionInstance;
  fieldKey: string;
  picker?: "openFile" | "saveFile";
  label: string;
  onSelect: (path: string) => void;
}) {
  const [pending, setPending] = useState(false),
    revision = useRef(0),
    select = useRef(onSelect);
  const fingerprint = JSON.stringify(action);
  useLayoutEffect(() => {
    select.current = onSelect;
  });
  useLayoutEffect(() => {
    revision.current++;
    setPending(false);
    return () => {
      revision.current++;
    };
  }, [scope, fingerprint, fieldKey, picker]);
  return (
    <button
      type="button"
      aria-label={`Choose ${label}`}
      disabled={pending}
      onClick={async () => {
        const token = ++revision.current;
        setPending(true);
        try {
          const path = await window.decker.request({
            type: "pickFile",
            picker,
          });
          if (revision.current === token && typeof path === "string")
            select.current(path);
        } catch (error) {
          if (revision.current === token)
            useApp.getState().setError(String(error));
        } finally {
          if (revision.current === token) setPending(false);
        }
      }}
    >
      {pending
        ? "Choosing…"
        : picker === "saveFile"
          ? "Choose destination…"
          : "Choose file…"}
    </button>
  );
}
