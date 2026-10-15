import { bindingTargets } from "./binding-targets";
import type { ActionInstance, AppDocument, Graph } from "./schema";

export type CredentialOwner = {
  key: string;
  label: string;
  ref?: string;
  action?: ActionInstance;
  set: (ref?: string) => void;
};
// Paths are addresses within a versioned document, never permanent action IDs.
// The main-process epoch invalidates every address after an edit, including ABA.
export function credentialOwners(document: AppDocument): CredentialOwner[] {
  const owners: CredentialOwner[] = [];
  const action = (a: ActionInstance, path: string[], label: string) => {
    if (!["http.request", "image.fetch"].includes(a.type)) return;
    owners.push({
      key: JSON.stringify(path),
      label,
      action: a,
      ref:
        typeof a.config.credentialRef === "string"
          ? a.config.credentialRef || undefined
          : undefined,
      set: (ref) => {
        a.config.credentialRef = ref ?? "";
      },
    });
  };
  const graph = (g: Graph, path: string[], label: string) => {
    for (const node of g.nodes) {
      const next = [...path, node.id];
      if (node.action)
        action(node.action, [...next, "action"], `${label} / ${node.name}`);
      if (node.body)
        graph(node.body, [...next, "body"], `${label} / ${node.name}`);
      node.branches?.forEach((branch, i) =>
        graph(
          branch,
          [...next, "branches", String(i)],
          `${label} / ${node.name} / branch ${i + 1}`,
        ),
      );
    }
  };
  for (const c of document.connections)
    owners.push({
      key: JSON.stringify(["connection", c.id]),
      label: c.name,
      ref: c.credentialRef,
      set: (ref) => {
        if (ref) c.credentialRef = ref;
        else delete c.credentialRef;
      },
    });
  for (const profile of document.profiles)
    for (const page of profile.pages)
      for (const binding of Object.values(page.keys)) {
        for (const { phase, target } of bindingTargets(binding)) {
          const path = ["binding", binding.id, phase];
          const label = `${profile.name} / ${page.name} / ${binding.appearance.label || "Key"} / ${phase}`;
          if (target?.kind === "action")
            action(target.action, [...path, "action"], label);
          if (target?.kind === "sequence")
            target.actions.forEach((a, i) =>
              action(
                a,
                [...path, "sequence", String(i)],
                `${label} / step ${i + 1}`,
              ),
            );
        }
      }
  for (const workflow of document.workflows)
    graph(workflow.graph, ["workflow", workflow.id], workflow.name);
  return owners;
}

// Import/export is a credential-free namespace: retain sharing inside the bundle,
// but never accidentally bind a bundle's reference to a local secret.
export function rekeyCredentials(
  document: AppDocument,
  generate: () => string,
): AppDocument {
  const copy = structuredClone(document),
    refs = new Map<string, string>();
  for (const owner of credentialOwners(copy))
    if (owner.action && typeof owner.action.config.credentialRef !== "string") {
      // A portable data expression must not resolve to a local reference later.
      // Existing local workspaces keep expressions; bundles require re-entry.
      owner.set(generate());
    } else if (owner.ref) {
      if (!refs.has(owner.ref)) refs.set(owner.ref, generate());
      owner.set(refs.get(owner.ref)!);
    }
  return copy;
}
