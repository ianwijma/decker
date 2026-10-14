import { afterEach, expect, it, vi } from "vitest";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import {
  chmod,
  mkdtemp,
  mkdir,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  assertPublication,
  bundle,
  metadata,
  publish,
  verifyBundle,
  type Api,
  type BuildIdentity,
} from "../scripts/nightly";

const execute = promisify(execFile);
const require = createRequire(import.meta.url);
const semver = require("semver");
const asar = require("@electron/asar");
const directories: string[] = [];
afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((d) => rm(d, { recursive: true, force: true })),
  );
});
const env = {
  GITHUB_REPOSITORY: "ianwijma/decker",
  GITHUB_SHA: "a".repeat(40),
  GITHUB_RUN_ID: "200",
  GITHUB_RUN_NUMBER: "10",
  GITHUB_RUN_ATTEMPT: "1",
  SOURCE_DATE: "2026-10-14T15:59:00+11:00",
  GITHUB_EVENT_NAME: "push",
  GITHUB_REF: "refs/heads/develop",
  VERIFY_RESULT: "success",
};
const identity = metadata(env, "0.1.0");
async function fixture(
  options: {
    version?: string;
    architecture?: string;
    appVersion?: string;
  } = {},
  build = identity,
) {
  const identity = build;
  const root = await mkdtemp(join(tmpdir(), "decker-nightly-"));
  directories.push(root);
  const release = join(root, "release"),
    destination = join(root, "bundle");
  const pkg = join(root, "deb"),
    app = join(root, "app");
  await mkdir(join(pkg, "DEBIAN"), { recursive: true });
  await chmod(join(pkg, "DEBIAN"), 0o755);
  await writeFile(
    join(pkg, "DEBIAN/control"),
    `Package: decker\nVersion: ${options.version ?? identity.debian_version}\nArchitecture: ${options.architecture ?? "amd64"}\nMaintainer: Decker <decker@localhost>\nDescription: Test installer\n`,
  );
  await mkdir(join(release, "linux-unpacked/resources"), { recursive: true });
  await execute("dpkg-deb", [
    "--build",
    pkg,
    join(release, `decker-${identity.version}-amd64.deb`),
  ]);
  await writeFile(
    join(release, `decker-${identity.version}-x86_64.AppImage`),
    "test AppImage bytes",
  );
  await mkdir(app);
  await writeFile(
    join(app, "package.json"),
    JSON.stringify({ version: options.appVersion ?? identity.version }),
  );
  await asar.createPackage(
    app,
    join(release, "linux-unpacked/resources/app.asar"),
  );
  return { root, release, destination };
}
function fakeGithub() {
  const state: {
    tag?: { object: { type: string; sha: string } };
    release?: {
      id: number;
      tag_name: string;
      target_commitish: string;
      draft: boolean;
      prerelease: boolean;
      upload_url: string;
      assets: Array<{ id: number; name: string; size: number; state: string }>;
    };
    bytes: Map<number, Buffer>;
    failUpload?: string;
    unavailable?: boolean;
  } = { bytes: new Map() };
  const response = (value: unknown, status = 200) =>
    new Response(JSON.stringify(value), { status });
  const api = vi.fn<Api>(async (method, path, body) => {
    if (state.unavailable) return response({}, 503);
    if (method === "GET" && path.startsWith("releases/tags/"))
      return state.release ? response(state.release) : response({}, 404);
    if (method === "GET" && path.startsWith("git/ref/tags/"))
      return state.tag ? response(state.tag) : response({}, 404);
    if (method === "POST" && path === "git/refs") {
      state.tag = {
        object: { type: "commit", sha: (body as { sha: string }).sha },
      };
      return response(state.tag, 201);
    }
    if (method === "POST" && path === "releases") {
      state.release = {
        ...(body as Omit<
          NonNullable<typeof state.release>,
          "id" | "assets" | "upload_url"
        >),
        id: 42,
        assets: [],
        upload_url:
          "https://uploads.github.com/repos/ianwijma/decker/releases/42/assets{?name,label}",
      };
      return response(state.release, 201);
    }
    if (method === "POST" && path.startsWith("https://uploads.github.com/")) {
      const name = new URL(path).searchParams.get("name")!;
      if (state.failUpload === name) return response({}, 500);
      const bytes = body as Buffer,
        id = state.bytes.size + 1;
      const asset = { id, name, size: bytes.length, state: "uploaded" };
      state.bytes.set(id, Buffer.from(bytes));
      state.release!.assets.push(asset);
      return response(asset, 201);
    }
    if (method === "GET" && path.startsWith("releases/assets/"))
      return new Response(
        new Uint8Array(state.bytes.get(Number(path.split("/").at(-1)))!),
      );
    if (method === "PATCH" && path === "releases/42") {
      Object.assign(state.release!, body);
      return response(state.release);
    }
    throw new Error(`Unexpected request ${method} ${path}`);
  });
  return { api, state };
}

it("generates npm-valid versions that order before stable in both SemVer and Debian", async () => {
  expect(semver.valid(identity.version)).toBe(identity.version);
  expect(semver.lt(identity.version, "0.1.0")).toBe(true);
  await execute("dpkg", ["--validate-version", identity.debian_version]);
  await execute("dpkg", [
    "--compare-versions",
    identity.debian_version,
    "lt",
    "0.1.0",
  ]);
  const {
    LinuxTargetHelper,
  } = require("app-builder-lib/out/targets/LinuxTargetHelper.js");
  expect(
    LinuxTargetHelper.prototype.getSanitizedVersion.call(
      { packager: { appInfo: { version: identity.version } } },
      "deb",
    ),
  ).toBe(identity.debian_version);
  expect(identity.tag).toContain("20261014.10.200.shaaaaaaaaaaaaa");
  const { Arch, getArtifactArchName } = require("builder-util");
  expect(getArtifactArchName(Arch.x64, "deb")).toBe("amd64");
  expect(getArtifactArchName(Arch.x64, "AppImage")).toBe("x86_64");
  for (const next of [
    metadata(
      {
        ...env,
        GITHUB_RUN_ID: "201",
        GITHUB_RUN_NUMBER: "11",
        GITHUB_SHA: "b".repeat(40),
      },
      "0.1.0",
    ),
    metadata(
      {
        ...env,
        SOURCE_DATE: "2026-10-15T00:00:00Z",
        GITHUB_RUN_NUMBER: "12",
        GITHUB_RUN_ID: "202",
      },
      "0.1.0",
    ),
  ]) {
    expect(next.tag).not.toBe(identity.tag);
    expect(semver.gt(next.version, identity.version)).toBe(true);
    await execute("dpkg", [
      "--compare-versions",
      next.debian_version,
      "gt",
      identity.debian_version,
    ]);
  }
  expect(metadata({ ...env, GITHUB_RUN_ATTEMPT: "2" }, "0.1.0")).toEqual(
    identity,
  );
});
it("rejects missing or malformed build provenance", () => {
  for (const patch of [
    { GITHUB_SHA: "develop" },
    { SOURCE_DATE: "" },
    { GITHUB_RUN_ID: "0" },
    { GITHUB_RUN_NUMBER: "01" },
  ])
    expect(() => metadata({ ...env, ...patch }, "0.1.0")).toThrow();
  expect(() => metadata(env, "latest")).toThrow();
});
it("dry-runs metadata injection with the complete existing builder config and leaves repository versions intact", async () => {
  const before = await readFile("package.json", "utf8");
  const packageJson = JSON.parse(before);
  const f = await fixture();
  const head = (await execute("git", ["rev-parse", "HEAD"])).stdout.trim();
  const destination = join(f.root, "metadata");
  await execute(
    process.execPath,
    ["scripts/nightly.ts", "metadata", destination],
    {
      env: { ...process.env, ...env, GITHUB_SHA: head },
    },
  );
  const builder = JSON.parse(
    await readFile(join(destination, "builder.json"), "utf8"),
  );
  const generated = JSON.parse(
    await readFile(join(destination, "metadata.json"), "utf8"),
  );
  expect(builder).toEqual({
    ...packageJson.build,
    extraMetadata: { version: generated.version },
  });
  expect(await readFile("package.json", "utf8")).toBe(before);
  await expect(
    execute(process.execPath, ["scripts/nightly.ts", "metadata", destination], {
      env: { ...process.env, ...env, GITHUB_SHA: "0".repeat(40) },
    }),
  ).rejects.toMatchObject({ code: 1 });
  expect(
    JSON.parse(await readFile(join(destination, "metadata.json"), "utf8")),
  ).toEqual(generated);
  expect(await readFile("package.json", "utf8")).toBe(before);
});
it("bundles only the tested, versioned installers and verifies their checksums", async () => {
  const f = await fixture();
  const manifest = await bundle(f.release, identity, f.destination);
  expect(await verifyBundle(f.destination)).toEqual(manifest);
  expect(manifest).toMatchObject({
    source_sha: env.GITHUB_SHA,
    architecture: "x64",
    version: identity.version,
  });
  expect(manifest.files.map((a) => a.name)).toEqual([
    `decker-${identity.version}-amd64.deb`,
    `decker-${identity.version}-x86_64.AppImage`,
  ]);
  await writeFile(join(f.destination, manifest.files[1].name), "tampered");
  await expect(verifyBundle(f.destination)).rejects.toThrow(
    "Checksum mismatch",
  );
  const { api } = fakeGithub();
  await expect(publish(f.destination, env, api)).rejects.toThrow(
    "Checksum mismatch",
  );
  expect(api).not.toHaveBeenCalled();
});
it("rejects wrong Debian version/architecture and wrong embedded app version", async () => {
  for (const options of [
    { version: "0.1.0" },
    { architecture: "arm64" },
    { appVersion: "0.1.0" },
  ]) {
    const f = await fixture(options);
    await expect(bundle(f.release, identity, f.destination)).rejects.toThrow(
      /version|architecture/,
    );
  }
});
it("rejects stale installers, unexpected downloads, traversal and symlinks", async () => {
  const f = await fixture();
  await writeFile(join(f.release, "stale.deb"), "old");
  await expect(bundle(f.release, identity, f.destination)).rejects.toThrow(
    "installer",
  );
  await rm(join(f.release, "stale.deb"));
  const manifest = await bundle(f.release, identity, f.destination);
  await writeFile(join(f.destination, "other.txt"), "extra");
  await expect(verifyBundle(f.destination)).rejects.toThrow(
    "Unexpected bundle files",
  );
  await rm(join(f.destination, "other.txt"));
  const originalName = manifest.files[0].name;
  manifest.files[0].name = "../outside.deb";
  await writeFile(
    join(f.destination, "manifest.json"),
    JSON.stringify(manifest),
  );
  await expect(verifyBundle(f.destination)).rejects.toThrow("Invalid artifact");
  manifest.files[0].name = originalName;
  await writeFile(
    join(f.destination, "manifest.json"),
    JSON.stringify(manifest),
  );
  await rm(join(f.destination, originalName));
  await symlink(
    join(f.release, originalName),
    join(f.destination, originalName),
  );
  await expect(verifyBundle(f.destination)).rejects.toThrow("regular file");
});
it("guards PRs, other branches/events/repos, failed checks and foreign workflow artifacts before API calls", async () => {
  const f = await fixture();
  await bundle(f.release, identity, f.destination);
  const { api } = fakeGithub();
  for (const patch of [
    { GITHUB_EVENT_NAME: "pull_request" },
    { GITHUB_EVENT_NAME: "workflow_dispatch" },
    { GITHUB_REF: "refs/heads/main" },
    { GITHUB_REPOSITORY: "fork/decker" },
    { VERIFY_RESULT: "failure" },
    { VERIFY_RESULT: "cancelled" },
    { VERIFY_RESULT: "skipped" },
    { GITHUB_SHA: "b".repeat(40) },
    { GITHUB_RUN_ID: "201" },
    { GITHUB_RUN_NUMBER: "11" },
  ])
    await expect(
      publish(f.destination, { ...env, ...patch }, api),
    ).rejects.toThrow("successful develop push");
  expect(api).not.toHaveBeenCalled();
  expect(() =>
    assertPublication(env, { ...identity, tag: "stable" } as BuildIdentity),
  ).toThrow();
});
it("publishes a draft only after all immutable assets are uploaded and verified; never marks latest", async () => {
  const f = await fixture();
  await bundle(f.release, identity, f.destination);
  const { api, state } = fakeGithub();
  await expect(publish(f.destination, env, api)).resolves.toContain(
    "published verified",
  );
  expect(state.tag?.object.sha).toBe(env.GITHUB_SHA);
  expect(state.release).toMatchObject({
    tag_name: identity.tag,
    target_commitish: env.GITHUB_SHA,
    draft: false,
    prerelease: true,
  });
  expect(state.release!.assets).toHaveLength(4);
  const writes = api.mock.calls.filter((c) => c[0] !== "GET");
  expect(writes.find((c) => c[1] === "releases")?.[2]).toMatchObject({
    draft: true,
    prerelease: true,
    make_latest: "false",
  });
  expect(writes.at(-1)).toEqual([
    "PATCH",
    "releases/42",
    { draft: false, prerelease: true, make_latest: "false" },
  ]);
  expect(
    api.mock.calls.filter(
      (c) => c[0] === "GET" && c[1].startsWith("releases/assets/"),
    ),
  ).toHaveLength(4);
});
it("resumes an interrupted draft without replacing any assets", async () => {
  const f = await fixture();
  await bundle(f.release, identity, f.destination);
  const { api, state } = fakeGithub();
  state.failUpload = `decker-${identity.version}-x86_64.AppImage`;
  await expect(publish(f.destination, env, api)).rejects.toThrow("500");
  expect(state.release!.draft).toBe(true);
  expect(state.release!.assets).toHaveLength(1);
  api.mockClear();
  state.failUpload = undefined;
  await expect(publish(f.destination, env, api)).resolves.toContain(
    "published verified",
  );
  expect(
    api.mock.calls.filter((c) => c[0] === "POST" && c[1].startsWith("https:")),
  ).toHaveLength(3);
  expect(api.mock.calls.some((c) => c[0] === "DELETE")).toBe(false);
});
it("makes full reruns read-only for published releases, preserving original tested bytes", async () => {
  const f = await fixture();
  await bundle(f.release, identity, f.destination);
  const { api, state } = fakeGithub();
  await publish(f.destination, env, api);
  const original = Buffer.from(state.bytes.get(2)!);
  // Rebuilt archives need not be reproducible. A full rerun retains the first release.
  await writeFile(
    join(f.release, `decker-${identity.version}-x86_64.AppImage`),
    "rebuilt bytes",
  );
  const rebuilt = join(f.root, "rebuilt");
  await bundle(f.release, identity, rebuilt);
  api.mockClear();
  await expect(
    publish(rebuilt, { ...env, GITHUB_RUN_ATTEMPT: "2" }, api),
  ).resolves.toContain("already published");
  expect(state.bytes.get(2)).toEqual(original);
  expect(api.mock.calls.every((c) => c[0] === "GET")).toBe(true);
});
it("publishes distinct immutable results for two close develop pushes", async () => {
  const nextEnv = {
    ...env,
    GITHUB_SHA: "b".repeat(40),
    GITHUB_RUN_ID: "201",
    GITHUB_RUN_NUMBER: "11",
  };
  const next = metadata(nextEnv, "0.1.0");
  const first = await fixture(),
    second = await fixture({}, next);
  await bundle(first.release, identity, first.destination);
  await bundle(second.release, next, second.destination);
  const a = fakeGithub(),
    b = fakeGithub();
  await publish(first.destination, env, a.api);
  await publish(second.destination, nextEnv, b.api);
  expect(a.state.release!.tag_name).not.toBe(b.state.release!.tag_name);
  expect(a.state.tag!.object.sha).toBe(env.GITHUB_SHA);
  expect(b.state.tag!.object.sha).toBe(nextEnv.GITHUB_SHA);
  expect(
    a.state
      .release!.assets.filter(
        (f) => f.name.endsWith(".deb") || f.name.endsWith(".AppImage"),
      )
      .map((f) => f.name),
  ).not.toEqual(
    b.state
      .release!.assets.filter(
        (f) => f.name.endsWith(".deb") || f.name.endsWith(".AppImage"),
      )
      .map((f) => f.name),
  );
});
it("fails closed on API errors, conflicting tags, stable releases and corrupted published assets", async () => {
  const f = await fixture();
  await bundle(f.release, identity, f.destination);
  const { api, state } = fakeGithub();
  state.unavailable = true;
  await expect(publish(f.destination, env, api)).rejects.toThrow("503");
  expect(state.release).toBeUndefined();
  state.unavailable = false;
  state.tag = { object: { type: "commit", sha: "b".repeat(40) } };
  await expect(publish(f.destination, env, api)).rejects.toThrow(
    "exact source",
  );
  state.tag = undefined;
  await publish(f.destination, env, api);
  state.release!.prerelease = false;
  await expect(publish(f.destination, env, api)).rejects.toThrow(
    "not a prerelease",
  );
  state.release!.prerelease = true;
  const bytes = state.bytes.get(2)!;
  bytes[0] ^= 1;
  await expect(publish(f.destination, env, api)).rejects.toThrow(
    "Published checksum mismatch",
  );
});
it("keeps verification read-only, preserves smoke gates and selects an artifact ID from the same run", async () => {
  const workflow = require("js-yaml").load(
    await readFile(".github/workflows/ci.yml", "utf8"),
  );
  expect(workflow.on.push.branches).toContain("develop");
  expect(workflow.on.pull_request).toBeNull();
  expect(workflow.permissions).toEqual({ contents: "read" });
  expect(workflow.concurrency).toBeUndefined();
  expect(workflow.jobs.verify.permissions).toBeUndefined();
  const verify = workflow.jobs.verify.steps;
  const commands = verify
    .filter((s: { run?: string }) => s.run)
    .map((s: { run: string }) => s.run);
  for (const command of [
    "npm ci",
    "npm run format:check",
    "npm run typecheck",
    "npm test",
    "npm run build",
  ])
    expect(commands).toContain(command);
  const smoke = verify.findIndex(
    (s: { env?: { DECKER_EXECUTABLE?: string } }) => s.env?.DECKER_EXECUTABLE,
  );
  expect(verify[smoke].run).toBe("xvfb-run --auto-servernum npm run test:e2e");
  const checksum = verify.findIndex((s: { run?: string }) =>
    s.run?.includes("nightly.ts bundle"),
  );
  const upload = verify.findIndex((s: { id?: string }) => s.id === "packages");
  expect(checksum).toBeGreaterThan(smoke);
  expect(upload).toBeGreaterThan(checksum);
  expect(verify[upload].if).toBeUndefined();
  expect(verify[upload].with["if-no-files-found"]).toBe("error");
  expect(verify[upload].with.name).toContain(
    "${{ github.run_id }}-${{ github.run_attempt }}",
  );
  const publisher = workflow.jobs.publish;
  expect(publisher.needs).toBe("verify");
  for (const guard of [
    "github.event_name == 'push'",
    "github.ref == 'refs/heads/develop'",
    "github.repository == 'ianwijma/decker'",
    "needs.verify.result == 'success'",
  ])
    expect(publisher.if).toContain(guard);
  expect(publisher.permissions).toEqual({ contents: "write" });
  const download = publisher.steps.find((s: { uses?: string }) =>
    s.uses?.startsWith("actions/download-artifact"),
  );
  expect(download.with["artifact-ids"]).toBe(
    "${{ needs.verify.outputs.artifact_id }}",
  );
  expect(download.with["run-id"]).toBeUndefined();
  expect(
    publisher.steps.some((s: { run?: string }) =>
      /npm (ci|run (build|package))/.test(s.run ?? ""),
    ),
  ).toBe(false);
});
