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
import { bundle, verifyBundle, type Api } from "../scripts/nightly";
import {
  stableMetadata,
  validateStable,
  authorizeStable,
  validateSource,
  previousStable,
  releaseNotes,
  safeTitle,
  publishStable,
  type Git,
} from "../scripts/stable";

const execute = promisify(execFile);
const require = createRequire(import.meta.url);
const asar = require("@electron/asar");
const directories: string[] = [];
afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((d) => rm(d, { recursive: true, force: true })),
  );
});
const env = {
  GITHUB_REPOSITORY: "ianwijma/decker",
  SOURCE_SHA: "a".repeat(40),
  RELEASE_VERSION: "0.1.0",
  RELEASE_BRANCH: "main",
  HOST_ACCEPTED: "true",
  GITHUB_RUN_ID: "200",
  GITHUB_RUN_NUMBER: "10",
  GITHUB_RUN_ATTEMPT: "1",
  SOURCE_DATE: "2026-10-14T15:59:00+11:00",
  GITHUB_EVENT_NAME: "workflow_dispatch",
  GITHUB_REF: "refs/heads/develop",
  VERIFY_RESULT: "success",
};
const identity = stableMetadata(env, "0.1.0");
async function fixture(
  options: {
    version?: string;
    architecture?: string;
    appVersion?: string;
  } = {},
  build = identity,
) {
  const identity = build;
  const root = await mkdtemp(join(tmpdir(), "decker-stable-"));
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

it("requires an explicit reviewed stable version, main and full source/run provenance", () => {
  expect(identity).toMatchObject({
    version: "0.1.0",
    debian_version: "0.1.0",
    tag: "v0.1.0",
  });
  for (const RELEASE_VERSION of [
    "",
    "latest",
    "v0.1.0",
    "01.1.0",
    "0.1.0-dev.1",
    "0.1.0+build",
    "$(touch pwned)",
    "1.0.0\n",
  ])
    expect(() =>
      stableMetadata({ ...env, RELEASE_VERSION }, "0.1.0"),
    ).toThrow();
  for (const patch of [
    { SOURCE_SHA: "develop" },
    { RELEASE_BRANCH: "develop" },
    { GITHUB_RUN_ID: "0" },
    { GITHUB_RUN_NUMBER: "01" },
    { SOURCE_DATE: "" },
  ])
    expect(() => stableMetadata({ ...env, ...patch }, "0.1.0")).toThrow();
  expect(() => stableMetadata(env, "0.2.0")).toThrow(
    "reviewed package version",
  );
  expect(() => validateStable({ ...identity, tag: "nightly" })).toThrow();
});
it("keeps all publication writes behind accepted dispatch and exact verification gates", async () => {
  const f = await fixture();
  await bundle(f.release, identity, f.destination, validateStable);
  const { api } = fakeGithub();
  for (const patch of [
    { GITHUB_EVENT_NAME: "push" },
    { GITHUB_EVENT_NAME: "pull_request" },
    { GITHUB_REF: "refs/heads/main" },
    { GITHUB_REPOSITORY: "fork/decker" },
    { RELEASE_BRANCH: "develop" },
    { HOST_ACCEPTED: "false" },
    { VERIFY_RESULT: "failure" },
    { VERIFY_RESULT: "skipped" },
    { VERIFY_RESULT: "cancelled" },
    { SOURCE_SHA: "b".repeat(40) },
    { RELEASE_VERSION: "0.2.0" },
    { GITHUB_RUN_ID: "201" },
    { GITHUB_RUN_NUMBER: "11" },
  ])
    await expect(
      publishStable(f.destination, { ...env, ...patch }, api, "notes"),
    ).rejects.toThrow("accepted develop dispatch");
  expect(api).not.toHaveBeenCalled();
  expect(() => authorizeStable(env, identity)).not.toThrow();
});
it("checks stable package and embedded app versions before bundling", async () => {
  for (const options of [
    { version: "0.1.0~dev.1" },
    { appVersion: "0.1.0-dev.1" },
    { architecture: "arm64" },
  ]) {
    const f = await fixture(options);
    await expect(
      bundle(f.release, identity, f.destination, validateStable),
    ).rejects.toThrow(/version|architecture/);
  }
  const f = await fixture();
  expect(
    await bundle(f.release, identity, f.destination, validateStable),
  ).toMatchObject(identity);
  await expect(
    verifyBundle(f.destination, validateStable),
  ).resolves.toMatchObject(identity);
  await expect(verifyBundle(f.destination)).rejects.toThrow();
});
it("publishes only after every stable asset is uploaded and downloaded intact", async () => {
  const f = await fixture();
  await bundle(f.release, identity, f.destination, validateStable);
  const { api, state } = fakeGithub();
  await expect(
    publishStable(f.destination, env, api, "Linked notes"),
  ).resolves.toContain("stable release");
  expect(state.tag!.object.sha).toBe(env.SOURCE_SHA);
  expect(state.release).toMatchObject({
    draft: false,
    prerelease: false,
    tag_name: "v0.1.0",
    target_commitish: env.SOURCE_SHA,
  });
  expect(state.release!.assets).toHaveLength(4);
  expect(
    api.mock.calls.find((c) => c[0] === "POST" && c[1] === "releases")![2],
  ).toMatchObject({
    draft: true,
    prerelease: false,
    body: "Linked notes",
    make_latest: "false",
  });
  expect(api.mock.calls.at(-1)).toEqual([
    "PATCH",
    "releases/42",
    { draft: false, prerelease: false, make_latest: "true" },
  ]);
  expect(
    api.mock.calls.filter(
      (c) => c[0] === "GET" && c[1].startsWith("releases/assets/"),
    ),
  ).toHaveLength(4);
});
it("keeps failed uploads as drafts, resumes identical bytes and refuses replacement", async () => {
  const f = await fixture();
  await bundle(f.release, identity, f.destination, validateStable);
  const { api, state } = fakeGithub();
  state.failUpload = "decker-0.1.0-x86_64.AppImage";
  await expect(publishStable(f.destination, env, api, "notes")).rejects.toThrow(
    "500",
  );
  expect(state.release!.draft).toBe(true);
  expect(state.release!.assets).toHaveLength(1);
  state.failUpload = undefined;
  const original = Buffer.from(state.bytes.get(1)!);
  state.bytes.get(1)![0] ^= 1;
  await expect(publishStable(f.destination, env, api, "notes")).rejects.toThrow(
    "immutable asset",
  );
  state.bytes.set(1, original);
  api.mockClear();
  await publishStable(f.destination, env, api, "notes");
  expect(
    api.mock.calls.filter((c) => c[0] === "POST" && c[1].startsWith("https:")),
  ).toHaveLength(3);
  expect(api.mock.calls.some((c) => c[0] === "DELETE")).toBe(false);
});
it("makes published stable reruns read-only across workflow runs and rebuilt bytes", async () => {
  const f = await fixture();
  await bundle(f.release, identity, f.destination, validateStable);
  const { api, state } = fakeGithub();
  await publishStable(f.destination, env, api, "notes");
  const before = Buffer.from(state.bytes.get(2)!);
  const nextEnv = { ...env, GITHUB_RUN_ID: "201", GITHUB_RUN_NUMBER: "11" };
  const nextIdentity = stableMetadata(nextEnv, "0.1.0");
  const rebuilt = join(f.root, "rebuilt");
  await writeFile(
    join(f.release, "decker-0.1.0-x86_64.AppImage"),
    "different rebuilt bytes",
  );
  await bundle(f.release, nextIdentity, rebuilt, validateStable);
  api.mockClear();
  await expect(
    publishStable(rebuilt, nextEnv, api, "new notes"),
  ).resolves.toContain("already published");
  expect(api.mock.calls.every((c) => c[0] === "GET")).toBe(true);
  expect(state.bytes.get(2)).toEqual(before);
  state.bytes.get(2)![0] ^= 1;
  await expect(publishStable(rebuilt, nextEnv, api, "notes")).rejects.toThrow(
    "Published checksum",
  );
});
it("fails closed on conflicting tags, prereleases, corrupt bundles and unavailable API", async () => {
  const f = await fixture();
  await bundle(f.release, identity, f.destination, validateStable);
  const { api, state } = fakeGithub();
  state.tag = { object: { sha: "b".repeat(40), type: "commit" } };
  await expect(publishStable(f.destination, env, api, "notes")).rejects.toThrow(
    "exact source",
  );
  expect(state.release).toBeUndefined();
  state.tag = undefined;
  state.unavailable = true;
  await expect(publishStable(f.destination, env, api, "notes")).rejects.toThrow(
    "503",
  );
  state.unavailable = false;
  await publishStable(f.destination, env, api, "notes");
  state.release!.prerelease = true;
  await expect(publishStable(f.destination, env, api, "notes")).rejects.toThrow(
    "conflicting provenance",
  );
  await writeFile(
    join(f.destination, "decker-0.1.0-x86_64.AppImage"),
    "tampered",
  );
  api.mockClear();
  await expect(publishStable(f.destination, env, api, "notes")).rejects.toThrow(
    "Checksum mismatch",
  );
  expect(api).not.toHaveBeenCalled();
});
async function history() {
  const root = await mkdtemp(join(tmpdir(), "decker-stable-history-"));
  directories.push(root);
  const runGit: Git = async (args) =>
    (await execute("git", ["-C", root, ...args])).stdout.trim();
  await runGit(["init", "-b", "main"]);
  await runGit(["config", "user.name", "Fixture"]);
  await runGit(["config", "user.email", "fixture@example.invalid"]);
  const commit = async (name: string) => {
    await runGit(["commit", "--allow-empty", "-m", name]);
    return runGit(["rev-parse", "HEAD"]);
  };
  const first = await commit("First direct commit");
  await runGit(["branch", "develop"]);
  return { root, runGit, commit, first };
}
it("validates main ancestry and exact checkout without falling back to develop", async () => {
  const h = await history();
  await h.runGit(["update-ref", "refs/remotes/origin/main", h.first]);
  const i = { ...identity, source_sha: h.first };
  await expect(validateSource(env, i, h.runGit)).resolves.toBeUndefined();
  await expect(
    validateSource(env, { ...i, source_sha: "a".repeat(40) }, h.runGit),
  ).rejects.toThrow("Checkout");
  await h.runGit(["switch", "develop"]);
  const next = await h.commit("Unpromoted develop");
  await expect(
    validateSource(env, { ...i, source_sha: next }, h.runGit),
  ).rejects.toThrow("not on release branch");
  await h.runGit(["update-ref", "-d", "refs/remotes/origin/main"]);
  await expect(
    validateSource(env, { ...i, source_sha: next }, h.runGit),
  ).rejects.toThrow("missing");
});
it.each(["merge", "squash", "rebase"])(
  "collects underlying %s PRs once through promotion and escapes titles",
  async (mode) => {
    const h = await history();
    await h.runGit(["tag", "v0.0.1"]);
    await h.runGit(["switch", "develop"]);
    await h.runGit(["switch", "-c", "feature"]);
    // A file change gives squash and rebase real history to operate on.
    await writeFile(join(h.root, "feature"), mode);
    await h.runGit(["add", "feature"]);
    const feature = await h.commit("Feature commit");
    await h.runGit(["switch", "develop"]);
    if (mode === "merge")
      await h.runGit(["merge", "--no-ff", "feature", "-m", "Merge feature"]);
    if (mode === "squash") {
      await h.runGit(["merge", "--squash", "feature"]);
      await h.commit("Squashed feature");
    }
    if (mode === "rebase") {
      await h.commit("Develop advanced before rebase");
      await h.runGit(["switch", "feature"]);
      await h.runGit(["rebase", "develop"]);
      await h.runGit(["switch", "develop"]);
      await h.runGit(["merge", "--ff-only", "feature"]);
    }
    const merged = await h.runGit(["rev-parse", "HEAD"]);
    const direct = await h.commit("Direct <fix> $(touch pwned) `title`");
    await h.runGit(["tag", "v99.0.0-dev.20261014.1"]);
    await h.runGit(["switch", "main"]);
    await h.runGit(["merge", "--no-ff", "develop", "-m", "Promote develop"]);
    const promoted = await h.runGit(["rev-parse", "HEAD"]);
    const pr = {
      number: 25,
      title: "Fix [link](evil) <script> & `$(touch pwned)`\nnext",
      merged_at: "2026-10-14",
      merge_commit_sha: merged,
      base: { ref: "develop" },
      head: { ref: "feature" },
    };
    const promotion = {
      ...pr,
      number: 26,
      title: "Promote develop",
      merge_commit_sha: promoted,
      base: { ref: "main" },
      head: { ref: "develop" },
    };
    const api = vi.fn<Api>(async (method, path) => {
      expect(method).toBe("GET");
      const sha = path.split("/")[1];
      return new Response(
        JSON.stringify(
          sha === direct
            ? []
            : sha === promoted
              ? [promotion]
              : [feature, merged].includes(sha)
                ? [pr, promotion, { ...pr, number: 99, merged_at: null }]
                : [],
        ),
      );
    });
    const notes = await releaseNotes(
      { ...identity, source_sha: promoted },
      api,
      h.runGit,
    );
    expect(notes.match(/\/pull\/25/g)).toHaveLength(1);
    expect(notes).not.toContain("/pull/26");
    expect(notes).not.toContain("/pull/99");
    expect(notes).toContain("Changes since v0.0.1");
    expect(notes).not.toContain("<script>");
    expect(notes).toContain("&lt;script&gt;");
    expect(notes).toContain("\\`$\\(touch pwned\\)\\`");
    expect(notes).toContain(direct);
    expect(notes).not.toContain("dev.20261014");
    expect(await previousStable("0.1.0", promoted, h.runGit)).toBe("v0.0.1");
  },
);
it("handles first releases, annotated stable tags, unrelated tags and non-increasing versions", async () => {
  const h = await history();
  await h.runGit(["tag", "v1.0.0-dev.1"]);
  const api = vi.fn<Api>(async () => new Response("[]"));
  const notes = await releaseNotes(
    { ...identity, source_sha: h.first },
    api,
    h.runGit,
  );
  expect(notes).toContain("First stable release");
  expect(notes).toContain("First direct commit");
  await h.runGit(["tag", "-a", "v0.0.2", "-m", "Annotated stable"]);
  expect(await previousStable("0.1.0", h.first, h.runGit)).toBe("v0.0.2");
  await expect(previousStable("0.0.1", h.first, h.runGit)).rejects.toThrow(
    "newer",
  );
  await h.runGit(["switch", "--orphan", "unrelated"]);
  const unrelated = await h.commit("Unrelated");
  await h.runGit(["tag", "v9.0.0", unrelated]);
  await h.runGit(["switch", "main"]);
  // Disconnected tag histories should be ignored, but actual git failures must fail closed.
  await expect(previousStable("0.1.0", h.first, h.runGit)).resolves.toBe(
    "v0.0.2",
  );
  expect(safeTitle("a\n<script> [x] & b")).toBe(
    "a &lt;script&gt; \\[x\\] &amp; b",
  );
});
it("preserves read-only exact-source gates, artifact ID selection and no rebuild in publication", async () => {
  const load = require("js-yaml").load;
  const driver = load(
    await readFile(".github/workflows/stable-release.yml", "utf8"),
  );
  const verifier = load(
    await readFile(".github/workflows/verify-stable.yml", "utf8"),
  );
  expect(driver.on.workflow_dispatch.inputs.host_accepted.default).toBe(false);
  expect(driver.permissions).toEqual({ contents: "read" });
  expect(verifier.permissions).toEqual({ contents: "read" });
  expect(driver.jobs.verify.uses).toBe("./.github/workflows/verify-stable.yml");
  for (const guard of [
    "github.event_name == 'workflow_dispatch'",
    "github.ref == 'refs/heads/develop'",
    "github.repository == 'ianwijma/decker'",
    "inputs.host_accepted",
  ]) {
    expect(driver.jobs.verify.if).toContain(guard);
    expect(driver.jobs.publish.if).toContain(guard);
  }
  expect(driver.jobs.publish.if).toContain("needs.verify.result == 'success'");
  expect(driver.jobs.publish.permissions).toEqual({ contents: "write" });
  const steps = verifier.jobs.verify.steps,
    commands = steps.map((s: { run?: string }) => s.run).filter(Boolean);
  for (const command of [
    "npm ci",
    "npm run format:check",
    "npm run typecheck",
    "npm test",
    "npm run build",
    "xvfb-run --auto-servernum npm run test:e2e",
  ])
    expect(commands).toContain(command);
  expect(steps[0].with.ref).toBe("${{ inputs.source_sha }}");
  expect(steps[0].with["fetch-depth"]).toBe(0);
  const smoke = steps.findIndex(
    (s: { env?: { DECKER_EXECUTABLE?: string } }) => s.env?.DECKER_EXECUTABLE,
  );
  const bundleIndex = steps.findIndex((s: { run?: string }) =>
    s.run?.includes("stable.ts bundle"),
  );
  expect(bundleIndex).toBeGreaterThan(smoke);
  const uploadIndex = steps.findIndex(
    (s: { id?: string }) => s.id === "packages",
  );
  expect(uploadIndex).toBeGreaterThan(bundleIndex);
  expect(steps[uploadIndex].with["if-no-files-found"]).toBe("error");
  const pub = driver.jobs.publish.steps;
  expect(
    pub.find((s: { uses?: string }) =>
      s.uses?.startsWith("actions/download-artifact"),
    ).with["artifact-ids"],
  ).toBe("${{ needs.verify.outputs.artifact_id }}");
  expect(
    pub.some((s: { run?: string }) =>
      /npm (ci|run (build|package))/.test(s.run ?? ""),
    ),
  ).toBe(false);
  expect(driver.concurrency["cancel-in-progress"]).toBe(false);
});
it("reads every associated-PR page and excludes PRs already in the previous stable baseline", async () => {
  const h = await history();
  await h.runGit(["tag", "v0.0.1"]);
  const next = await h.commit("After stable");
  const old = {
    number: 1,
    title: "Already released",
    merged_at: "2026-10-14",
    merge_commit_sha: h.first,
    base: { ref: "develop" },
    head: { ref: "old" },
  };
  const current = {
    ...old,
    number: 25,
    title: "New PR",
    merge_commit_sha: next,
  };
  const api = vi.fn<Api>(
    async (_method, path) =>
      new Response(
        JSON.stringify(
          path.endsWith("page=1") ? Array(100).fill(old) : [current],
        ),
      ),
  );
  const notes = await releaseNotes(
    { ...identity, source_sha: next },
    api,
    h.runGit,
  );
  expect(api).toHaveBeenCalledTimes(2);
  expect(notes).toContain("/pull/25");
  expect(notes).not.toContain("/pull/1)");
  expect(notes).not.toContain("Already released");
});
it("does not finalize a release when uploaded bytes fail verification", async () => {
  const f = await fixture();
  await bundle(f.release, identity, f.destination, validateStable);
  const fake = fakeGithub();
  const api: Api = async (method, path, body) => {
    const result = await fake.api(method, path, body);
    if (method === "POST" && path.startsWith("https:"))
      fake.state.bytes.get(fake.state.bytes.size)![0] ^= 1;
    return result;
  };
  await expect(publishStable(f.destination, env, api, "notes")).rejects.toThrow(
    "Uploaded artifact verification",
  );
  expect(fake.state.release!.draft).toBe(true);
  expect(fake.api.mock.calls.some((c) => c[0] === "PATCH")).toBe(false);
});
it("dry-runs stable metadata from main fixtures without changing source versions or making API calls", async () => {
  const h = await history();
  await h.runGit(["update-ref", "refs/remotes/origin/main", h.first]);
  const pkg = {
    version: "0.1.0",
    build: { appId: "fixture", linux: { target: ["deb", "AppImage"] } },
  };
  const before = JSON.stringify(pkg);
  await writeFile(join(h.root, "package.json"), before);
  const script = join(process.cwd(), "scripts/stable.ts");
  await execute(process.execPath, [script, "metadata"], {
    cwd: h.root,
    env: { ...process.env, ...env, SOURCE_SHA: h.first },
  });
  expect(
    JSON.parse(
      await readFile(join(h.root, "work/stable/builder.json"), "utf8"),
    ),
  ).toEqual({ ...pkg.build, extraMetadata: { version: "0.1.0" } });
  expect(
    JSON.parse(
      await readFile(join(h.root, "work/stable/metadata.json"), "utf8"),
    ),
  ).toMatchObject({ source_sha: h.first, version: "0.1.0", tag: "v0.1.0" });
  expect(await readFile(join(h.root, "package.json"), "utf8")).toBe(before);
});
