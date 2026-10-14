import { afterEach, beforeEach, expect, it, vi } from "vitest";
import * as fs from "node:fs/promises";
import {
  mkdtemp,
  readFile,
  writeFile,
  rm,
  readdir,
  stat,
  symlink,
  link,
  mkdir,
  chmod,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { TextFileActions } from "../src/actions/text-files";
import {
  TEXT_READ_LIMIT,
  TEXT_CONTENT_LIMIT,
  fileContentSchema,
} from "../src/shared/text-files";
import {
  actionById,
  catalogForPalette,
  makeAction,
} from "../src/shared/catalog";
import { handlers } from "../src/actions/handlers";
import { defaults, node } from "../src/shared/defaults";
import { ObsConnections } from "../src/integrations/obs";
import { Engine } from "../src/runtime/engine";
import { validateWorkflow } from "../src/runtime/validate";
import { boundedJson } from "../src/shared/data-contract";
import { bindingChoices } from "../src/shared/data-presentation";
import { pickDesktopDestination } from "../src/main/desktop-file-picker";
import { requestSchema } from "../src/shared/schema";

let directory: string;
const actions = new TextFileActions();
const signal = () => new AbortController().signal;
const write = (path: string, content: string, createParents = false) =>
  actions.execute("file.writeText", { path, content, createParents }, signal());
const append = (path: string, content: string) =>
  actions.execute("file.appendText", { path, content }, signal());
const read = (path: string) =>
  actions.execute("file.readText", { path }, signal());
const gate = () => {
  let release!: () => void;
  const promise = new Promise<void>((r) => {
    release = r;
  });
  return { promise, release };
};
beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), "decker-text-"));
});
afterEach(async () => {
  await rm(directory, { recursive: true, force: true });
});

it("writes, reads and appends exact empty/Unicode/spaced UTF-8 content with bounded typed metadata", async () => {
  const path = join(directory, "你好 file.txt");
  expect(await write(path, "")).toEqual({
    bytesWritten: 0,
    created: true,
    operation: "overwrite",
  });
  expect((await stat(path)).mode & 0o777).toBe(0o600);
  expect(await read(path)).toEqual({ text: "", bytes: 0, truncated: false });
  expect(await write(path, "\ufeffHello 🌏\n")).toEqual({
    bytesWritten: 14,
    created: false,
    operation: "overwrite",
  });
  expect(await append(path, "é\n")).toEqual({
    bytesWritten: 3,
    created: false,
    operation: "append",
  });
  expect(await read(path)).toEqual({
    text: "\ufeffHello 🌏\né\n",
    bytes: 17,
    truncated: false,
  });
  expect(await append(join(directory, "new.txt"), "new")).toMatchObject({
    created: true,
  });
  expect(await readdir(directory)).toEqual(["new.txt", "你好 file.txt"]);
});

it("bounds reads by source bytes, preserves complete multibyte boundaries and rejects invalid UTF-8", async () => {
  const path = join(directory, "bytes");
  await writeFile(path, "é".repeat(TEXT_READ_LIMIT / 2));
  expect(await read(path)).toMatchObject({
    bytes: TEXT_READ_LIMIT,
    truncated: false,
  });
  await writeFile(path, "é".repeat(TEXT_READ_LIMIT / 2) + "x");
  await expect(read(path)).rejects.toThrow(/read limit.*no partial/);
  await writeFile(path, Buffer.from([0xf0, 0x9f, 0x8c]));
  await expect(read(path)).rejects.toThrow("not valid UTF-8");
  await writeFile(path, "\0".repeat(TEXT_READ_LIMIT));
  const result = await read(path);
  expect(Buffer.byteLength(JSON.stringify(result))).toBeLessThan(1_000_000);
  expect(() => boundedJson(result)).not.toThrow();
});

it("uses bounded lookahead even if the file grows after stat; never calls readFile", async () => {
  const path = join(directory, "grow");
  await writeFile(path, "a");
  let total = 0;
  const io = {
    ...fs,
    open: vi.fn(async (...args: Parameters<typeof fs.open>) => {
      const handle = await fs.open(...args);
      const original = handle.read.bind(handle);
      handle.read = vi.fn(
        async (...readArgs: Parameters<typeof handle.read>) => {
          const result = await original(...readArgs);
          total += result.bytesRead;
          return result;
        },
      ) as typeof handle.read;
      const originalStat = handle.stat.bind(handle);
      handle.stat = vi.fn(async () => {
        const initial = await originalStat();
        await writeFile(path, "é".repeat(TEXT_READ_LIMIT));
        return initial;
      }) as unknown as typeof handle.stat;
      return handle;
    }),
  };
  await expect(
    new TextFileActions(io).execute("file.readText", { path }, signal()),
  ).rejects.toThrow("read limit");
  expect(total).toBe(TEXT_READ_LIMIT + 1);
});

it.each(["relative", "~/file", "file:///tmp/file", "$HOME/file", "/tmp/\0bad"])(
  "rejects malformed or non-absolute path %s before effects",
  async (path) => {
    await expect(write(path, "x")).rejects.toThrow();
    expect(await readdir(directory)).toEqual([]);
  },
);
it("rejects non-text references, excess content bytes and unpaired surrogates before touching the file", async () => {
  const path = join(directory, "safe");
  await writeFile(path, "original");
  for (const content of [
    false,
    {},
    [],
    "é".repeat(TEXT_CONTENT_LIMIT / 2 + 1),
    "\ud800",
  ]) {
    await expect(
      actions.execute("file.writeText", { path, content }, signal()),
    ).rejects.toThrow();
    expect(await readFile(path, "utf8")).toBe("original");
  }
  expect(
    fileContentSchema.safeParse("x".repeat(TEXT_CONTENT_LIMIT)).success,
  ).toBe(true);
});
it("requires explicit parent creation, defaults off and preserves overwrite permissions", async () => {
  const path = join(directory, "nested", "more", "file");
  await expect(write(path, "x")).rejects.toThrow("Parent directory is missing");
  await write(path, "x", true);
  expect((await stat(join(directory, "nested"))).mode & 0o777).toBe(0o700);
  await chmod(path, 0o640);
  await write(path, "replace");
  expect((await stat(path)).mode & 0o777).toBe(0o640);
  await expect(read(join(directory, "absent"))).rejects.toThrow("missing");
  await expect(
    actions.execute(
      "file.appendText",
      {
        path: join(directory, "another", "file"),
        content: "a",
        createParents: true,
      },
      signal(),
    ),
  ).resolves.toMatchObject({ created: true });
});
it("rejects directories, symlinks, hard links and FIFOs without hanging", async () => {
  const path = join(directory, "original");
  await writeFile(path, "safe");
  await symlink(path, join(directory, "symbolic"));
  await symlink(join(directory, "missing"), join(directory, "dangling"));
  await link(path, join(directory, "hard"));
  const fifo = join(directory, "fifo");
  execFileSync("mkfifo", [fifo]);
  for (const target of [
    directory,
    path,
    join(directory, "symbolic"),
    join(directory, "dangling"),
    fifo,
  ])
    for (const type of [
      "file.readText",
      "file.writeText",
      "file.appendText",
    ] as const)
      await expect(
        actions.execute(
          type,
          { path: target, content: "bad" },
          AbortSignal.timeout(1000),
        ),
      ).rejects.toThrow(/regular file|Hard-linked/);
  expect(await readFile(path, "utf8")).toBe("safe");
});
it("also checks the opened object when a regular file is replaced by a FIFO", async () => {
  const path = join(directory, "race");
  await writeFile(path, "safe");
  const io = {
    ...fs,
    open: vi.fn(async (...args: Parameters<typeof fs.open>) => {
      await fs.unlink(path);
      execFileSync("mkfifo", [path]);
      return fs.open(...args);
    }),
  };
  await expect(
    new TextFileActions(io).execute(
      "file.readText",
      { path },
      AbortSignal.timeout(1000),
    ),
  ).rejects.toThrow("regular file");
});
it("reports controlled access denied under root-capable runners and leaves no temporary file", async () => {
  const path = join(directory, "file");
  await writeFile(path, "safe");
  const io = {
    ...fs,
    open: vi.fn(async () => {
      throw Object.assign(new Error("controlled"), { code: "EACCES" });
    }),
  };
  for (const type of [
    "file.readText",
    "file.writeText",
    "file.appendText",
  ] as const)
    await expect(
      new TextFileActions(io).execute(type, { path, content: "new" }, signal()),
    ).rejects.toThrow("access denied");
  expect(await readFile(path, "utf8")).toBe("safe");
  expect(await readdir(directory)).toEqual(["file"]);
});
it("preserves the destination and cleans temporary data on write/rename failures", async () => {
  const path = join(directory, "file");
  await writeFile(path, "safe");
  const renameFailure = new TextFileActions({
    ...fs,
    rename: vi.fn(async () => {
      throw Object.assign(new Error("controlled"), { code: "EACCES" });
    }),
  });
  await expect(
    renameFailure.execute("file.writeText", { path, content: "new" }, signal()),
  ).rejects.toThrow("access denied");
  const writeFailure = new TextFileActions({
    ...fs,
    open: async (...args) => {
      const h = await fs.open(...args);
      h.write = vi.fn(async () => {
        throw new Error("disk full");
      }) as typeof h.write;
      return h;
    },
  });
  await expect(
    writeFailure.execute("file.writeText", { path, content: "new" }, signal()),
  ).rejects.toThrow("disk full");
  expect(await readFile(path, "utf8")).toBe("safe");
  expect(await readdir(directory)).toEqual(["file"]);
});
it("cancels during bounded writes and immediately before rename, preserving the original", async () => {
  const path = join(directory, "file");
  await writeFile(path, "safe");
  for (const stage of ["write", "beforeRename"] as const) {
    const controller = new AbortController();
    let targets = 0;
    const io = {
      ...fs,
      lstat: (async (...args: Parameters<typeof fs.lstat>) => {
        const s = await fs.lstat(...args);
        if (++targets === 2 && stage === "beforeRename")
          controller.abort(new Error("cancelled"));
        return s;
      }) as typeof fs.lstat,
      open: async (...args: Parameters<typeof fs.open>) => {
        const h = await fs.open(...args);
        if (stage === "write") {
          const original = h.write.bind(h);
          h.write = (async (...args: Parameters<typeof h.write>) => {
            const result = await original(...args);
            controller.abort(new Error("cancelled"));
            return result;
          }) as typeof h.write;
        }
        return h;
      },
      rename: vi.fn(fs.rename),
    };
    await expect(
      new TextFileActions(io).execute(
        "file.writeText",
        { path, content: "x".repeat(50_000) },
        controller.signal,
      ),
    ).rejects.toThrow("cancelled");
    expect(io.rename).not.toHaveBeenCalled();
    expect(await readFile(path, "utf8")).toBe("safe");
    expect(await readdir(directory)).toEqual(["file"]);
  }
});
it("serializes same destination across handler instances/parent aliases, cancels queued work and allows unrelated files", async () => {
  const parent = join(directory, "real"),
    alias = join(directory, "alias");
  await mkdir(parent);
  await symlink(parent, alias);
  const path = join(parent, "file");
  const entered = gate(),
    release = gate();
  const first = new TextFileActions({
    ...fs,
    rename: async (...args) => {
      entered.release();
      await release.promise;
      await fs.rename(...args);
    },
  });
  const running = first.execute(
    "file.writeText",
    { path, content: "first" },
    signal(),
  );
  await entered.promise;
  const controller = new AbortController();
  const queued = actions.execute(
    "file.appendText",
    { path: join(alias, ".", "file"), content: "cancelled" },
    controller.signal,
  );
  const rejected = expect(queued).rejects.toThrow("queued cancelled");
  controller.abort(new Error("queued cancelled"));
  await rejected;
  let completed = false;
  const next = append(join(alias, "file"), "+second").then(() => {
    completed = true;
  });
  await write(join(directory, "independent"), "concurrent");
  expect(completed).toBe(false);
  release.release();
  await running;
  await next;
  expect(await readFile(path, "utf8")).toBe("first+second");
});
it("serializes concurrent appends without interleaving chunks", async () => {
  const path = join(directory, "append");
  const a = "a".repeat(50_000),
    b = "b".repeat(50_000);
  await Promise.all([append(path, a), append(path, b)]);
  expect([a + b, b + a]).toContain(await readFile(path, "utf8"));
});
it("reports ambiguous append failure and retains partial effects after cancellation", async () => {
  const path = join(directory, "file");
  await writeFile(path, "original");
  for (const cancelled of [false, true]) {
    const controller = new AbortController();
    const io = {
      ...fs,
      open: async (...args: Parameters<typeof fs.open>) => {
        const h = await fs.open(...args),
          original = h.write.bind(h);
        let calls = 0;
        h.write = (async (...args: Parameters<typeof h.write>) => {
          if (calls++) throw new Error("disk full");
          const result = await original(...args);
          if (cancelled) controller.abort(new Error("cancelled"));
          return result;
        }) as typeof h.write;
        return h;
      },
    };
    await expect(
      new TextFileActions(io).execute(
        "file.appendText",
        { path, content: "x".repeat(50_000) },
        controller.signal,
      ),
    ).rejects.toThrow(cancelled ? "cancelled" : "partial append");
  }
  expect(await readFile(path, "utf8")).toBe("original" + "x".repeat(32_768));
});
it("does not overwrite a link introduced just before commit", async () => {
  const path = join(directory, "file"),
    other = join(directory, "other");
  await writeFile(path, "safe");
  await writeFile(other, "other");
  const io = {
    ...fs,
    open: async (...args: Parameters<typeof fs.open>) => {
      const h = await fs.open(...args),
        original = h.close.bind(h);
      h.close = async () => {
        await original();
        await fs.unlink(path);
        await symlink(other, path);
      };
      return h;
    },
  };
  await expect(
    new TextFileActions(io).execute(
      "file.writeText",
      { path, content: "bad" },
      signal(),
    ),
  ).rejects.toThrow("regular file");
  expect(await readFile(other, "utf8")).toBe("other");
  expect((await readdir(directory)).filter((n) => n.endsWith(".tmp"))).toEqual(
    [],
  );
});
it("offers both palettes, typed picker outputs and rejects append retries unless explicitly confirmed", () => {
  for (const context of ["button", "workflow"] as const)
    for (const id of ["file.readText", "file.writeText", "file.appendText"])
      expect(catalogForPalette(context).map((d) => d.id)).toContain(id);
  expect(actionById("file.appendText")!.idempotent).toBe(false);
  const workflow = defaults().workflows[0];
  workflow.graph = {
    entry: "append",
    edges: [{ id: "e", source: "append", target: "read", port: "next" }],
    nodes: [
      {
        ...node("action", "append"),
        id: "append",
        retries: 1,
        action: {
          ...makeAction("file.appendText"),
          config: { path: "/tmp/test", content: "" },
        },
      },
      {
        ...node("action", "read"),
        id: "read",
        action: {
          ...makeAction("file.readText"),
          config: { path: "/tmp/test" },
        },
      },
    ],
  };
  expect(
    validateWorkflow(workflow, [workflow]).some((e) => e.includes("retries")),
  ).toBe(true);
  workflow.graph.nodes[0].retrySafe = true;
  expect(validateWorkflow(workflow, [workflow])).toEqual([]);
  expect(
    bindingChoices(workflow, [], "read")
      .filter((c) => c.path[1] === "append")
      .map((c) => [c.path[2], c.type]),
  ).toContainEqual(["bytesWritten", "number"]);
  expect(node("action", "new").retries).toBe(0);
});
it("validates destination chooser replies and cancellation with no path or filesystem command arguments", async () => {
  const dialog = vi.fn(async () => ({
    canceled: false,
    filePath: join(directory, "new.txt"),
  }));
  expect(await pickDesktopDestination(dialog)).toBe(join(directory, "new.txt"));
  expect(dialog).toHaveBeenCalledWith({
    title: "Choose text file destination",
  });
  dialog.mockResolvedValue({ canceled: true, filePath: "" });
  expect(await pickDesktopDestination(dialog)).toBeNull();
  for (const path of ["", "relative", "file:///tmp/a", "/tmp/\0bad"]) {
    dialog.mockResolvedValue({ canceled: false, filePath: path });
    await expect(pickDesktopDestination(dialog)).rejects.toThrow();
  }
  expect(
    requestSchema.safeParse({ type: "pickFile", picker: "saveFile" }).success,
  ).toBe(true);
  expect(
    requestSchema.safeParse({
      type: "pickFile",
      picker: "saveFile",
      path: "/etc/passwd",
    }).success,
  ).toBe(false);
});
it("validates resolved fields before effects and does not automatically retry ambiguous appends", async () => {
  const path = join(directory, "engine");
  const handler = handlers(
    defaults,
    () => ({}),
    async () => {
      throw new Error("unexpected IPC");
    },
    new ObsConnections(() => {}),
  );
  const workflow = defaults().workflows[0];
  workflow.graph = {
    entry: "append",
    edges: [],
    nodes: [
      {
        ...node("action", "append"),
        id: "append",
        action: {
          ...makeAction("file.appendText"),
          config: { path, content: { $ref: "inputs.content" } },
        },
      },
    ],
  };
  workflow.inputs = ["content"];
  const engine = new Engine(handler, () => {});
  expect(
    (await engine.start(workflow, [workflow], { content: false }).done).status,
  ).toBe("failure");
  await expect(stat(path)).rejects.toMatchObject({ code: "ENOENT" });
  expect(
    (await engine.start(workflow, [workflow], { content: "valid" }).done)
      .status,
  ).toBe("success");
  expect(await readFile(path, "utf8")).toBe("valid");
  const failing = vi.fn(async () => {
    throw new Error("Append failed; partial append");
  });
  const run = await new Engine(failing, () => {}).start(workflow, [workflow], {
    content: "x",
  }).done;
  expect(run.status).toBe("failure");
  expect(failing).toHaveBeenCalledTimes(1);
});
it("checks cancellation during bounded reads and before any filesystem effect", async () => {
  const path = join(directory, "read-cancel");
  await writeFile(path, "x".repeat(TEXT_READ_LIMIT));
  const controller = new AbortController();
  let reads = 0;
  const io = {
    ...fs,
    open: async (...args: Parameters<typeof fs.open>) => {
      const h = await fs.open(...args),
        original = h.read.bind(h);
      h.read = (async (...args: Parameters<typeof h.read>) => {
        const result = await original(...args);
        reads++;
        controller.abort(new Error("read cancelled"));
        return result;
      }) as typeof h.read;
      return h;
    },
  };
  await expect(
    new TextFileActions(io).execute(
      "file.readText",
      { path },
      controller.signal,
    ),
  ).rejects.toThrow("read cancelled");
  expect(reads).toBe(1);
  const never = {
    ...fs,
    realpath: vi.fn((path: string) => fs.realpath(path)),
    open: vi.fn(fs.open),
  };
  await expect(
    new TextFileActions(never).execute(
      "file.writeText",
      { path, content: "bad" },
      controller.signal,
    ),
  ).rejects.toThrow("read cancelled");
  expect(never.realpath).not.toHaveBeenCalled();
  expect(never.open).not.toHaveBeenCalled();
  expect(await readFile(path, "utf8")).toBe("x".repeat(TEXT_READ_LIMIT));
});
it("cannot undo a rename that has already committed when cancellation arrives", async () => {
  const path = join(directory, "committed");
  await writeFile(path, "old");
  const controller = new AbortController();
  const io = {
    ...fs,
    rename: async (...args: Parameters<typeof fs.rename>) => {
      await fs.rename(...args);
      controller.abort(new Error("late cancellation"));
    },
  };
  await new TextFileActions(io).execute(
    "file.writeText",
    { path, content: "committed" },
    controller.signal,
  );
  expect(await readFile(path, "utf8")).toBe("committed");
  expect(await readdir(directory)).toEqual(["committed"]);
});
