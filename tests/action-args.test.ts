import { it, expect, vi } from "vitest";
import { EventEmitter } from "node:events";
vi.mock("node:child_process", async (original) => ({
  ...(await original<typeof import("node:child_process")>()),
  spawn: vi.fn(),
}));
import { spawn } from "node:child_process";
import { handlers } from "../src/actions/handlers";
import { defaults } from "../src/shared/defaults";
import { ObsConnections } from "../src/integrations/obs";
it("launches native and legacy argument arrays directly as argv", async () => {
  const unref = vi.fn();
  vi.mocked(spawn).mockImplementation(() => {
    const child = Object.assign(new EventEmitter(), { unref, pid: 123 });
    queueMicrotask(() => child.emit("spawn"));
    return child as unknown as ReturnType<typeof spawn>;
  });
  const execute = handlers(
    defaults,
    () => ({}),
    async () => null,
    new ObsConnections(() => {}),
  );
  const argv = ["a b", "$(echo inert)", "", "false"];
  for (const args of [argv, JSON.stringify(argv)]) {
    await expect(
      execute(
        {
          type: "app.launch",
          version: 1,
          config: { executable: "fixture", args },
        },
        {
          signal: AbortSignal.timeout(1000),
          runId: "args",
          workflowId: "args",
        },
      ),
    ).resolves.toEqual({ pid: 123 });
  }
  expect(vi.mocked(spawn).mock.calls).toEqual([
    ["fixture", argv, { detached: true, stdio: "ignore" }],
    ["fixture", argv, { detached: true, stdio: "ignore" }],
  ]);
  expect(unref).toHaveBeenCalledTimes(2);
});
