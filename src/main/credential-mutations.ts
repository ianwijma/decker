import { credentialOwners } from "../shared/credential-owners";
import type { AppDocument, Request } from "../shared/schema";
import type { Credentials } from "./credentials";

// Store first, document second, publish last. Always allocate a fresh reference.
// If the document write fails, retain the orphan for recovery; never overwrite or
// delete the old secret. Unlinking owners never garbage-collects pinned/copy refs.
export async function mutateCredential(
  document: AppDocument,
  epoch: string,
  request: Extract<Request, { type: "credential" }>,
  credentials: Credentials,
  save: (next: AppDocument) => Promise<unknown>,
): Promise<AppDocument> {
  if (request.epoch !== epoch)
    throw new Error(
      "This secret editor is out of date. Reopen the owner and try again.",
    );
  const next = structuredClone(document);
  const owner = credentialOwners(next).find(
    (owner) => owner.key === request.owner,
  );
  if (!owner)
    throw new Error("The secret owner no longer exists. Reopen its editor.");
  const ref =
    request.operation === "set"
      ? await credentials.create(request.value, request.persist)
      : undefined;
  owner.set(ref);
  if (request.operation === "set") request.value = "";
  // Reuse the normal generation/revision contract when changing action configs.
  for (const profile of next.profiles)
    for (const page of profile.pages)
      for (const binding of Object.values(page.keys)) {
        const old = document.profiles
          .flatMap((p) => p.pages)
          .flatMap((p) => Object.values(p.keys))
          .find((b) => b.id === binding.id);
        if (old && JSON.stringify(old) !== JSON.stringify(binding))
          binding.generation = old.generation + 1;
      }
  for (const workflow of next.workflows) {
    const old = document.workflows.find((w) => w.id === workflow.id);
    if (old && JSON.stringify(old.graph) !== JSON.stringify(workflow.graph))
      workflow.revision = old.revision + 1;
  }
  try {
    await save(next);
  } catch {
    throw new Error(
      "Could not save the secret's owner. Its previous reference is unchanged. Retry after workspace storage is available.",
    );
  }
  return next;
}
