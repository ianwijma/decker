import { expect, it } from "vitest";
import { createServer } from "node:http";
import { handlers } from "../src/actions/handlers";
import { ObsConnections } from "../src/integrations/obs";
import { Engine } from "../src/runtime/engine";
import { defaults, node } from "../src/shared/defaults";
import { makeAction } from "../src/shared/catalog";

it("redacts authenticated success/errors before traces or downstream data, rejects secret redirects, and guides missing owners", async () => {
  const token = "synthetic-http-echo-token",
    authorizations: string[] = [];
  const server = createServer((req, res) => {
    authorizations.push(req.headers.authorization ?? "");
    if (req.url === "/redirect") {
      res.writeHead(302, { Location: "/echo" });
      res.end();
      return;
    }
    if (req.url === "/fail") res.writeHead(403);
    res.end(`Echo ${token}`);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as { port: number }).port;
  const handler = handlers(
    defaults,
    () => ({ ref: token }),
    async () => null,
    new ObsConnections(() => {}),
  );
  const action = makeAction("http.request");
  action.config.credentialRef = "ref";
  const context = {
    signal: AbortSignal.timeout(5000),
    runId: "test",
    workflowId: "test",
  };
  try {
    action.config.url = `http://127.0.0.1:${port}/echo`;
    expect(await handler(action, context)).toMatchObject({
      status: 200,
      body: "Echo [redacted]",
    });
    expect(authorizations).toEqual([`Bearer ${token}`]);
    const workflow = defaults().workflows[0],
      http = node("action", "Authenticated request");
    http.action = structuredClone(action);
    workflow.graph = { entry: http.id, nodes: [http], edges: [] };
    const records: unknown[] = [],
      engine = new Engine(
        handler,
        (record) => records.push(record),
        () => [token],
      );
    expect((await engine.start(workflow, [workflow]).done).status).toBe(
      "success",
    );
    http.action.config.url = `http://127.0.0.1:${port}/fail`;
    expect((await engine.start(workflow, [workflow]).done).status).toBe(
      "failure",
    );
    expect(JSON.stringify(records)).not.toContain(token);
    expect(JSON.stringify(records)).toContain("[redacted]");
    action.config.url = `http://127.0.0.1:${port}/fail`;
    await expect(handler(action, context)).rejects.toThrow(
      "HTTP 403: Echo [redacted]",
    );
    action.config.url = `http://127.0.0.1:${port}/redirect`;
    const before = authorizations.length;
    await expect(handler(action, context)).rejects.toThrow();
    expect(authorizations).toHaveLength(before + 1);
    action.config.credentialRef = "constructor";
    await expect(handler(action, context)).rejects.toThrow(
      "Open this HTTP action",
    );
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
