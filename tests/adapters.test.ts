import { it, expect } from "vitest";
import { createServer } from "node:http";
import { setTimeout as sleep } from "node:timers/promises";
import { command } from "../src/adapters/linux/system";
import { handlers } from "../src/actions/handlers";
import { ObsConnections } from "../src/integrations/obs";
import { defaults } from "../src/shared/defaults";
import { makeAction } from "../src/shared/catalog";
it("passes literal command arguments without shell expansion and bounds output", async () => {
  const result = await command(
    process.execPath,
    ["-e", "process.stdout.write(process.argv[1])", "$(touch /tmp/never)"],
    AbortSignal.timeout(2000),
  );
  expect(result).toMatchObject({ stdout: "$(touch /tmp/never)", exitCode: 0 });
  const large = await command(
    process.execPath,
    ["-e", 'process.stdout.write("x".repeat(100000))'],
    AbortSignal.timeout(2000),
  );
  expect((large as { stdout: string }).stdout.length).toBe(16384);
});
it("cancels a subprocess group including descendants", async () => {
  const controller = new AbortController();
  let pid = 0;
  const server = createServer((_req, res) => {
    res.end("ok");
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const port = (server.address() as { port: number }).port;
  server.on("request", (req) => {
    pid = Number(req.url?.slice(1));
    controller.abort();
  });
  try {
    await expect(
      command(
        "/bin/sh",
        [
          "-c",
          `node -e 'require("http").get("http://127.0.0.1:${port}/"+process.pid);setInterval(()=>{},100)' & wait`,
        ],
        controller.signal,
      ),
    ).rejects.toThrow();
    await sleep(100);
    expect(pid).toBeGreaterThan(0);
    let alive = false;
    try {
      const { readFile } = await import("node:fs/promises");
      const stat = await readFile(`/proc/${pid}/stat`, "utf8");
      alive = stat.split(" ")[2] !== "Z";
    } catch {}
    expect(alive).toBe(false);
  } finally {
    server.closeAllConnections();
    server.close();
  }
});
it("handles HTTP status, bearer references, response limits and cancellation", async () => {
  let authorization = "";
  const server = createServer((req, res) => {
    authorization = String(req.headers.authorization);
    if (req.url === "/slow") return;
    if (req.url === "/fail") {
      res.writeHead(503);
      res.end("unavailable");
      return;
    }
    res.end("x".repeat(20000));
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const port = (server.address() as { port: number }).port,
    handler = handlers(
      defaults,
      () => ({ test: "sensitive" }),
      async () => null,
      new ObsConnections(() => {}),
    ),
    action = makeAction("http.request");
  action.config.url = `http://127.0.0.1:${port}`;
  action.config.credentialRef = "test";
  const context = {
    signal: AbortSignal.timeout(1000),
    runId: "test",
    workflowId: "test",
  };
  try {
    const result = (await handler(action, context)) as {
      body: string;
      truncated: boolean;
    };
    expect(authorization).toBe("Bearer sensitive");
    expect(result.body.length).toBe(16384);
    expect(result.truncated).toBe(true);
    action.config.url += "/fail";
    await expect(handler(action, context)).rejects.toThrow("503");
    action.config.url = `http://127.0.0.1:${port}/slow`;
    await expect(
      handler(action, { ...context, signal: AbortSignal.timeout(20) }),
    ).rejects.toThrow();
  } finally {
    server.closeAllConnections();
    server.close();
  }
});
