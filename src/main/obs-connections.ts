import { randomUUID } from "node:crypto";
import { credentialOwners } from "../shared/credential-owners";
import { lookupSecret } from "../shared/secret-redaction";
import type { AppDocument } from "../shared/schema";
import type { ObsSaveRequest, ObsTestRequest } from "../shared/obs-contract";
import { obsOutcome, type ObsTests } from "../integrations/obs-test";
import type { Credentials } from "./credentials";

export function savedObsOwner(document: AppDocument, owner: string) {
  const connection = document.connections.find(
    (c) => JSON.stringify(["connection", c.id]) === owner,
  );
  if (!connection)
    throw new Error("This OBS connection no longer exists. Reopen its editor.");
  return connection;
}
export async function testObsRequest(
  request: ObsTestRequest,
  current: () => { document: AppDocument; epoch: string },
  credentials: Credentials,
  tests: ObsTests,
) {
  const before = current();
  let password: string | undefined;
  try {
    if (request.target.kind === "saved") {
      if (request.target.epoch !== before.epoch)
        return obsOutcome(request.id, "cancelled");
      const connection = savedObsOwner(before.document, request.target.owner);
      if (request.credential.kind === "stored") {
        const status = credentials.status(connection.credentialRef);
        if (status === "locked")
          return obsOutcome(request.id, "locked-credential");
        if (status === "missing")
          return obsOutcome(request.id, "missing-credential");
        password = lookupSecret(credentials.all(), connection.credentialRef!);
      }
    } else if (request.credential.kind === "stored")
      return obsOutcome(request.id, "invalid-input");
    if (request.credential.kind === "supplied") {
      password = request.credential.password;
      request.credential.password = "";
    }
    const result = await tests.test(request.id, request.target.url, password);
    if (request.target.kind === "saved" && current().epoch !== before.epoch)
      return obsOutcome(request.id, "cancelled");
    return result;
  } catch {
    return obsOutcome(request.id, "invalid-input");
  }
}

// Caller uses the existing main document mutation queue; ciphertext commits first.
export async function saveObsDraft(
  document: AppDocument,
  epoch: string,
  request: ObsSaveRequest,
  credentials: Credentials,
  save: (next: AppDocument) => Promise<unknown>,
) {
  if (request.epoch !== epoch)
    throw new Error("This OBS editor is out of date. Reopen it and retry.");
  const next = structuredClone(document);
  const connection =
    request.target.kind === "saved"
      ? savedObsOwner(next, request.target.owner)
      : ({
          id: randomUUID(),
          name: request.name,
          url: request.url,
        } as AppDocument["connections"][number]);
  if (request.target.kind === "new") {
    if (next.connections.length >= 30)
      throw new Error("Maximum OBS connections reached (30).");
    next.connections.push(connection);
  }
  connection.name = request.name;
  connection.url = request.url;
  if (request.credential.kind === "replace") {
    const password = request.credential.password;
    request.credential.password = "";
    connection.credentialRef = await credentials.create(
      password,
      request.credential.persist,
    );
  } else if (request.credential.kind === "none") {
    credentialOwners(next)
      .find((o) => o.key === JSON.stringify(["connection", connection.id]))!
      .set(undefined);
  }
  try {
    await save(next);
  } catch {
    throw new Error(
      "Could not save the OBS connection. The previous connection and password are unchanged. Retry when workspace storage is available.",
    );
  }
  return next;
}
