import { afterEach, describe, expect, it, vi } from "vitest";
import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
vi.mock("electron", () => ({ safeStorage: {} }));
import {
  Credentials,
  credentialFiles,
  type CredentialBackend,
} from "../src/main/credentials";
import { mutateCredential } from "../src/main/credential-mutations";
import {
  credentialOwners,
  rekeyCredentials,
} from "../src/shared/credential-owners";
import { binding, defaults, node, uid } from "../src/shared/defaults";
import { makeAction } from "../src/shared/catalog";
import { requestSchema, type Request } from "../src/shared/schema";
import { Persistence } from "../src/main/persistence";
const directories: string[] = [];
afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((p) => rm(p, { recursive: true, force: true })),
  );
});
async function directory() {
  const p = await mkdtemp(join(tmpdir(), "decker-secrets-"));
  directories.push(p);
  return p;
}
function backend() {
  const key = randomBytes(32);
  return {
    isEncryptionAvailable: vi.fn(() => true),
    getSelectedStorageBackend: vi.fn<
      CredentialBackend["getSelectedStorageBackend"]
    >(() => "gnome_libsecret"),
    encryptString: vi.fn((s: string) => {
      const iv = randomBytes(16),
        c = createCipheriv("aes-256-cbc", key, iv);
      return Buffer.concat([iv, c.update(s), c.final()]);
    }),
    decryptString: vi.fn((b: Buffer) => {
      const c = createDecipheriv("aes-256-cbc", key, b.subarray(0, 16));
      return Buffer.concat([c.update(b.subarray(16)), c.final()]).toString();
    }),
  } satisfies CredentialBackend;
}
function request(
  owner: string,
  value = "synthetic-new-token",
): Extract<Request, { type: "credential" }> {
  return {
    type: "credential",
    owner,
    epoch: "epoch",
    operation: "set",
    value,
    persist: true,
  };
}
function ownersFixture() {
  const doc = defaults();
  doc.connections = ["one", "two"].map((id) => ({
    id,
    name: id,
    url: "ws://localhost:4455",
    credentialRef: "legacy-shared",
  }));
  const b = binding("http.request");
  b.press = {
    kind: "sequence",
    actions: [makeAction("http.request"), makeAction("http.request")],
  };
  b.release = { kind: "action", action: makeAction("http.request") };
  b.longPress = { kind: "action", action: makeAction("http.request") };
  doc.profiles[0].pages[0].keys[0] = b;
  const nested = node("action", "Nested HTTP");
  nested.action = makeAction("http.request");
  const repeat = node("repeat", "Repeat");
  repeat.body = { entry: nested.id, nodes: [nested], edges: [] };
  const parallel = node("parallel", "Parallel");
  parallel.branches = [{ entry: repeat.id, nodes: [repeat], edges: [] }];
  doc.workflows[0].graph = { entry: parallel.id, nodes: [parallel], edges: [] };
  for (const owner of credentialOwners(doc)) owner.set("legacy-shared");
  return doc;
}
describe("encrypted and session storage", () => {
  it("restarts encrypted values, uses opaque refs and restrictive atomic files, and loses session values on restart", async () => {
    const path = await directory(),
      os = backend(),
      c = new Credentials(path, os);
    await c.load();
    const ref = await c.create("synthetic-durable-token", true),
      session = await c.create("synthetic-session-token", false);
    expect(ref).toMatch(/^managed:[a-f0-9-]{36}$/);
    expect(c.status(ref)).toBe("configured");
    expect(c.status(session)).toBe("session-only");
    expect((await stat(join(path, "credentials.json"))).mode & 0o777).toBe(
      0o600,
    );
    const file = await readFile(join(path, "credentials.json"), "utf8");
    expect(file).not.toContain("synthetic");
    expect(file).not.toContain(session);
    const restarted = new Credentials(path, os);
    await restarted.load();
    expect(restarted.all()[ref]).toBe("synthetic-durable-token");
    expect(restarted.status(session)).toBe("missing");
  });
  it.each(["basic_text", "unavailable"])(
    "preserves ciphertext with %s storage and session-only changes",
    async (mode) => {
      const path = await directory(),
        os = backend(),
        c = new Credentials(path, os);
      await c.load();
      const ref = await c.create("synthetic-durable", true);
      const before = await readFile(join(path, "credentials.json"), "utf8");
      if (mode === "basic_text")
        os.getSelectedStorageBackend.mockReturnValue("basic_text");
      else os.isEncryptionAvailable.mockReturnValue(false);
      const locked = new Credentials(path, os);
      await locked.load();
      expect(locked.secure).toBe(false);
      expect(locked.status(ref)).toBe("locked");
      expect(locked.all()).toEqual({});
      await expect(locked.create("synthetic-persist", true)).rejects.toThrow(
        "unavailable",
      );
      const session = await locked.create("synthetic-session", false);
      expect(locked.status(session)).toBe("session-only");
      expect(await readFile(join(path, "credentials.json"), "utf8")).toBe(
        before,
      );
      os.getSelectedStorageBackend.mockReturnValue("gnome_libsecret");
      os.isEncryptionAvailable.mockReturnValue(true);
      const recovered = new Credentials(path, os);
      await recovered.load();
      expect(recovered.all()[ref]).toBe("synthetic-durable");
    },
  );
  it("preserves individual decrypt failures and unknown refs when adding a new encrypted secret", async () => {
    const path = await directory(),
      os = backend();
    await writeFile(
      join(path, "credentials.json"),
      JSON.stringify({
        damaged: "AA==",
        good: os.encryptString("synthetic-old").toString("base64"),
      }),
    );
    const c = new Credentials(path, os);
    await c.load();
    expect(c.status("damaged")).toBe("locked");
    expect(c.status("good")).toBe("configured");
    await c.create("synthetic-new", true);
    const saved = JSON.parse(
      await readFile(join(path, "credentials.json"), "utf8"),
    );
    expect(saved.damaged).toBe("AA==");
    expect(saved.good).toBeDefined();
  });
  it("blocks encrypted writes after corrupt or unreadable loads; sessions never overwrite recovery data", async () => {
    const path = await directory(),
      os = backend();
    await writeFile(join(path, "credentials.json"), "broken json");
    const c = new Credentials(path, os);
    await c.load();
    expect(c.writable).toBe(false);
    expect(c.status("unknown")).toBe("locked");
    await expect(c.create("synthetic", true)).rejects.toThrow();
    await c.create("synthetic", false);
    expect(await readFile(join(path, "credentials.json"), "utf8")).toBe(
      "broken json",
    );
    const files = {
      ...credentialFiles,
      readFile: vi.fn(async () => {
        throw Object.assign(new Error(), { code: "EACCES" });
      }),
    };
    const unreadable = new Credentials(path, os, files);
    await unreadable.load();
    expect(unreadable.writable).toBe(false);
    await unreadable.create("synthetic", false);
    expect(files.readFile).toHaveBeenCalledOnce();
  });
  it.each(["writeFile", "rename"] as const)(
    "keeps the previous map/value after %s failure and recovers",
    async (method) => {
      const path = await directory(),
        os = backend(),
        original = new Credentials(path, os);
      await original.load();
      const old = await original.create("synthetic-old", true);
      const before = await readFile(join(path, "credentials.json"), "utf8");
      const files = {
        ...credentialFiles,
        [method]: vi.fn(credentialFiles[method]),
      };
      const c = new Credentials(path, os, files);
      await c.load();
      vi.mocked(files[method]).mockRejectedValueOnce(
        new Error("synthetic-new-token should never appear in errors"),
      );
      await expect(c.create("synthetic-new-token", true)).rejects.toThrow(
        "previous secret",
      );
      expect(await readFile(join(path, "credentials.json"), "utf8")).toBe(
        before,
      );
      expect(c.all()).toEqual({ [old]: "synthetic-old" });
      const ref = await c.create("synthetic-recovered", true);
      expect(c.status(ref)).toBe("configured");
      const restart = new Credentials(path, os);
      await restart.load();
      expect(restart.all()).toEqual(c.all());
    },
  );
  it("serializes rapid competing encrypted and session updates without losing entries", async () => {
    const path = await directory(),
      os = backend(),
      c = new Credentials(path, os);
    await c.load();
    const refs = await Promise.all(
      Array.from({ length: 20 }, (_, i) =>
        c.create(`synthetic-${i}`, i % 2 === 0),
      ),
    );
    const restart = new Credentials(path, os);
    await restart.load();
    expect(Object.keys(restart.all())).toHaveLength(10);
    refs.forEach((ref, i) => expect(c.all()[ref]).toBe(`synthetic-${i}`));
  });
});
describe("owner mutation and safe portability", () => {
  it("keeps the committed owner when history storage fails, then recovers without losing the prior secret", async () => {
    const path = await directory(),
      os = backend(),
      c = new Credentials(path, os),
      store = new Persistence(path);
    await store.load();
    await c.load();
    const doc = ownersFixture();
    doc.connections[0].credentialRef = await c.create(
      "synthetic-before-failure",
      true,
    );
    await store.save(doc, []);
    await mkdir(join(path, "history.json.tmp"));
    const owner = credentialOwners(doc)[0];
    await expect(
      mutateCredential(doc, "epoch", request(owner.key), c, (next) =>
        store.save(next, []),
      ),
    ).rejects.toThrow("previous reference");
    expect(
      JSON.parse(await readFile(join(path, "config.json"), "utf8"))
        .connections[0].credentialRef,
    ).toBe(doc.connections[0].credentialRef);
    expect(c.all()[doc.connections[0].credentialRef!]).toBe(
      "synthetic-before-failure",
    );
    await rm(join(path, "history.json.tmp"), { recursive: true });
    const next = await mutateCredential(
      doc,
      "epoch",
      request(owner.key),
      c,
      (next) => store.save(next, []),
    );
    expect(next.connections[0].credentialRef).not.toBe(
      doc.connections[0].credentialRef,
    );
    expect((await store.load()).document).toEqual(next);
  });
  it("requires re-entry for portable dynamic credential references without changing local expressions", () => {
    const doc = ownersFixture(),
      owner = credentialOwners(doc).find((o) => o.action)!;
    owner.action!.config.credentialRef = { $ref: "vars.localRef" };
    const copy = rekeyCredentials(doc, () => `managed:${uid()}`);
    expect(
      credentialOwners(copy).find((o) => o.key === owner.key)!.ref,
    ).toMatch(/^managed:/);
    expect(owner.action!.config.credentialRef).toEqual({
      $ref: "vars.localRef",
    });
  });
  it("enumerates connections, sequences, every phase and nested workflow graphs", () => {
    const doc = ownersFixture(),
      owners = credentialOwners(doc);
    expect(owners).toHaveLength(7);
    expect(new Set(owners.map((o) => o.key)).size).toBe(7);
    expect(owners.at(-1)?.label).toContain("Nested HTTP");
  });
  it("replaces only one shared legacy owner, preserves copies and immutable revisions, then unlinks removal", async () => {
    const path = await directory(),
      os = backend();
    await writeFile(
      join(path, "credentials.json"),
      JSON.stringify({
        "legacy-shared": os.encryptString("synthetic-old").toString("base64"),
      }),
    );
    const c = new Credentials(path, os);
    await c.load();
    const doc = ownersFixture(),
      pinned = structuredClone(doc),
      owner = credentialOwners(doc)[0];
    const saved = vi.fn(async () => {}),
      next = await mutateCredential(doc, "epoch", request(owner.key), c, saved);
    expect(next.connections[0].credentialRef).toMatch(/^managed:/);
    expect(next.connections[1].credentialRef).toBe("legacy-shared");
    expect(pinned).toEqual(doc);
    expect(c.all()["legacy-shared"]).toBe("synthetic-old");
    const removed = await mutateCredential(
      next,
      "epoch",
      { ...request(owner.key), operation: "remove", value: "", persist: false },
      c,
      saved,
    );
    expect(removed.connections[0].credentialRef).toBeUndefined();
    expect(c.all()["legacy-shared"]).toBe("synthetic-old");
    removed.connections.shift();
    expect(c.status(removed.connections[0].credentialRef)).toBe("configured");
    expect(JSON.stringify(next)).not.toContain("synthetic");
  });
  it("increments binding generations and workflow revisions without moving canvas layout or aliases", async () => {
    const doc = ownersFixture(),
      c = new Credentials(await directory(), backend());
    await c.load();
    const owner = credentialOwners(doc).find((o) => o.key.includes("binding"))!;
    const next = await mutateCredential(
      doc,
      "epoch",
      { ...request(owner.key), persist: false },
      c,
      async () => {},
    );
    expect(next.profiles[0].pages[0].keys[0].generation).toBe(
      doc.profiles[0].pages[0].keys[0].generation + 1,
    );
    const workflowOwner = credentialOwners(next).find((o) =>
      o.key.includes("workflow"),
    )!;
    const changed = await mutateCredential(
      next,
      "epoch",
      { ...request(workflowOwner.key), persist: false },
      c,
      async () => {},
    );
    expect(changed.workflows[0].revision).toBe(next.workflows[0].revision + 1);
    expect(changed.workflows[0].layout).toEqual(doc.workflows[0].layout);
    expect(changed.workflowAliases).toEqual(doc.workflowAliases);
  });
  it("rejects stale, deleted and malformed owners before storing a value", async () => {
    const c = new Credentials(await directory(), backend()),
      doc = ownersFixture();
    const create = vi.spyOn(c, "create");
    await expect(
      mutateCredential(
        doc,
        "new-epoch",
        request(credentialOwners(doc)[0].key),
        c,
        async () => {},
      ),
    ).rejects.toThrow("out of date");
    await expect(
      mutateCredential(
        doc,
        "epoch",
        request('["connection","deleted"]'),
        c,
        async () => {},
      ),
    ).rejects.toThrow("no longer exists");
    expect(create).not.toHaveBeenCalled();
    for (const patch of [
      { ref: "other-secret" },
      { operation: "get" },
      { operation: "remove", value: "unexpected" },
      { epoch: "" },
      { owner: [] },
    ])
      expect(
        requestSchema.safeParse({ ...request("owner"), ...patch }).success,
      ).toBe(false);
  });
  it("does not publish or change the previous owner on document failure; restart keeps both encrypted values for recovery", async () => {
    const path = await directory(),
      os = backend(),
      c = new Credentials(path, os);
    await c.load();
    const doc = ownersFixture(),
      before = structuredClone(doc);
    await expect(
      mutateCredential(
        doc,
        "epoch",
        request(credentialOwners(doc)[0].key),
        c,
        async () => {
          throw new Error("disk full");
        },
      ),
    ).rejects.toThrow("previous reference");
    expect(doc).toEqual(before);
    const restart = new Credentials(path, os);
    await restart.load();
    expect(Object.values(restart.all())).toContain("synthetic-new-token"); // An orphan is safe; no visible owner points to it.
  });
  it("exports/imports consistently without local rebinding, preserving internal sharing and v3 workspace refs", async () => {
    const doc = ownersFixture(),
      persistence = new Persistence(await directory());
    await persistence.load();
    await persistence.save(doc, []);
    expect((await persistence.load()).document).toEqual(doc);
    const exported = await persistence.export(doc);
    const refs = credentialOwners(exported.document).map((o) => o.ref);
    expect(new Set(refs).size).toBe(1);
    expect(refs[0]).toMatch(/^import:/);
    expect(JSON.stringify(exported)).not.toContain("legacy-shared");
    const imported = rekeyCredentials(
      exported.document,
      () => `managed:${uid()}`,
    );
    const importedRefs = credentialOwners(imported).map((o) => o.ref);
    expect(new Set(importedRefs).size).toBe(1);
    expect(importedRefs[0]).not.toBe(refs[0]);
    expect(doc.connections[0].credentialRef).toBe("legacy-shared");
  });
});
