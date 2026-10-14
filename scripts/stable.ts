import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  bundle,
  verifyBundle,
  publishArtifacts,
  githubApi,
  type Api,
  type BuildIdentity,
} from "./nightly.ts";

const execute = promisify(execFile);
const repository = "ianwijma/decker";
function compareVersions(a: string, b: string) {
  const left = a.split(".").map(BigInt),
    right = b.split(".").map(BigInt);
  for (let i = 0; i < 3; i++)
    if (left[i] !== right[i]) return left[i] > right[i] ? 1 : -1;
  return 0;
}
export function stableVersion(version: string) {
  if (!/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(version))
    throw new Error("Version must be an explicit stable X.Y.Z version");
  return version;
}
export function stableMetadata(
  env: NodeJS.ProcessEnv,
  packageVersion: string,
): BuildIdentity {
  const version = stableVersion(env.RELEASE_VERSION ?? "");
  if (version !== packageVersion)
    throw new Error(
      "Requested version must match the reviewed package version",
    );
  if (env.RELEASE_BRANCH !== "main")
    throw new Error(
      "Release branch must be main; bootstrap it after host acceptance",
    );
  if (!/^[a-f0-9]{40}$/.test(env.SOURCE_SHA ?? ""))
    throw new Error("Source must be a full immutable SHA");
  for (const key of ["GITHUB_RUN_ID", "GITHUB_RUN_NUMBER"])
    if (
      !/^[1-9]\d*$/.test(env[key] ?? "") ||
      !Number.isSafeInteger(Number(env[key]))
    )
      throw new Error(`Invalid ${key}`);
  const date = new Date(env.SOURCE_DATE ?? "");
  if (!Number.isFinite(date.getTime())) throw new Error("Invalid source date");
  return {
    repository: env.GITHUB_REPOSITORY ?? "",
    source_sha: env.SOURCE_SHA!,
    source_date: date.toISOString(),
    run_id: env.GITHUB_RUN_ID!,
    run_number: env.GITHUB_RUN_NUMBER!,
    version,
    debian_version: version,
    architecture: "x64",
    tag: `v${version}`,
  };
}
export function validateStable(identity: BuildIdentity) {
  const expected = stableMetadata(
    {
      GITHUB_REPOSITORY: identity.repository,
      SOURCE_SHA: identity.source_sha,
      SOURCE_DATE: identity.source_date,
      GITHUB_RUN_ID: identity.run_id,
      GITHUB_RUN_NUMBER: identity.run_number,
      RELEASE_VERSION: identity.version,
      RELEASE_BRANCH: "main",
    },
    identity.version,
  );
  for (const key of Object.keys(expected) as Array<keyof BuildIdentity>)
    if (identity[key] !== expected[key])
      throw new Error(`Invalid stable manifest ${key}`);
}
export function authorizeStable(
  env: NodeJS.ProcessEnv,
  identity: BuildIdentity,
) {
  validateStable(identity);
  if (
    env.GITHUB_EVENT_NAME !== "workflow_dispatch" ||
    env.GITHUB_REF !== "refs/heads/develop" ||
    env.GITHUB_REPOSITORY !== repository ||
    identity.repository !== repository ||
    env.RELEASE_BRANCH !== "main" ||
    env.HOST_ACCEPTED !== "true" ||
    env.VERIFY_RESULT !== "success" ||
    env.SOURCE_SHA !== identity.source_sha ||
    env.RELEASE_VERSION !== identity.version ||
    env.GITHUB_RUN_ID !== identity.run_id ||
    env.GITHUB_RUN_NUMBER !== identity.run_number
  )
    throw new Error(
      "Stable publication requires an accepted develop dispatch and successful verification of this exact source/run",
    );
}
export type Git = (args: string[]) => Promise<string>;
const git: Git = async (args) =>
  (await execute("git", args, { maxBuffer: 32 * 1024 * 1024 })).stdout.trim();
async function ancestor(git: Git, old: string, head: string) {
  const resolved = await git(["rev-parse", `${old}^{commit}`]);
  try {
    return (await git(["merge-base", old, head])) === resolved;
  } catch (error) {
    if ((error as { code?: number }).code === 1) return false;
    throw error;
  }
}
export async function validateSource(
  env: NodeJS.ProcessEnv,
  identity: BuildIdentity,
  runGit: Git = git,
) {
  validateStable(identity);
  if (env.RELEASE_BRANCH !== "main")
    throw new Error("Release branch must be main");
  if ((await runGit(["rev-parse", "HEAD"])) !== identity.source_sha)
    throw new Error("Checkout does not match source SHA");
  const branch = await runGit([
    "rev-parse",
    "refs/remotes/origin/main^{commit}",
  ]).catch(() => {
    throw new Error(
      "Release branch main is missing; bootstrap after host acceptance",
    );
  });
  if (!(await ancestor(runGit, identity.source_sha, branch)))
    throw new Error("Source SHA is not on release branch main");
}
export async function previousStable(
  version: string,
  sha: string,
  runGit: Git = git,
) {
  stableVersion(version);
  const tags = (await runGit(["tag", "--list", "v*"]))
    .split("\n")
    .filter(
      (t) =>
        /^v(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(t) &&
        t !== `v${version}`,
    )
    .sort((a, b) => compareVersions(b.slice(1), a.slice(1)));
  for (const tag of tags) {
    if (await ancestor(runGit, tag, sha)) {
      if (compareVersions(version, tag.slice(1)) <= 0)
        throw new Error("Version must be newer than the previous stable tag");
      return tag;
    }
  }
  return undefined;
}
async function responseJson<T>(response: Response): Promise<T> {
  if (!response.ok) throw new Error(`GitHub API returned ${response.status}`);
  return response.json() as Promise<T>;
}
interface PullRequest {
  number: number;
  title: string;
  merged_at: string | null;
  merge_commit_sha: string | null;
  base: { ref: string };
  head: { ref: string };
}
async function allPages<T>(api: Api, path: string): Promise<T[]> {
  const values: T[] = [];
  for (let page = 1; ; page++) {
    const batch = await responseJson<T[]>(
      await api("GET", `${path}?per_page=100&page=${page}`),
    );
    values.push(...batch);
    if (batch.length < 100) return values;
  }
}
export function safeTitle(title: string) {
  return title
    .replace(/[\u0000-\u001f\u007f]/g, " ")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/[\\`*_{}\[\]()!#|]/g, "\\$&");
}
export async function releaseNotes(
  identity: BuildIdentity,
  api: Api,
  runGit: Git = git,
) {
  validateStable(identity);
  const previous = await previousStable(
    identity.version,
    identity.source_sha,
    runGit,
  );
  const range = previous
    ? `${previous}..${identity.source_sha}`
    : identity.source_sha;
  const commits = (await runGit(["rev-list", "--reverse", range]))
    .split("\n")
    .filter(Boolean);
  const prs = new Map<number, PullRequest>();
  const direct: string[] = [];
  for (const sha of commits) {
    const associated = await allPages<PullRequest>(api, `commits/${sha}/pulls`);
    let represented = false;
    for (const pr of associated) {
      if (
        !pr.merged_at ||
        !pr.merge_commit_sha ||
        !(await ancestor(runGit, pr.merge_commit_sha, identity.source_sha)) ||
        (previous && (await ancestor(runGit, pr.merge_commit_sha, previous)))
      )
        continue;
      represented = true;
      // Promotion merges duplicate the underlying develop history collected above.
      if (pr.base.ref === "main" && pr.head.ref === "develop") continue;
      if (!Number.isSafeInteger(pr.number) || pr.number <= 0)
        throw new Error("Invalid associated PR number");
      prs.set(pr.number, pr);
    }
    if (!represented) {
      const title = await runGit(["show", "-s", "--format=%s", sha]);
      direct.push(
        `- ${safeTitle(title)} ([${sha.slice(0, 7)}](https://github.com/${repository}/commit/${sha}))`,
      );
    }
  }
  const lines = [
    `Decker ${identity.version}`,
    "",
    `Source: [${identity.source_sha}](https://github.com/${repository}/commit/${identity.source_sha})`,
    "",
    previous ? `Changes since ${previous}:` : "First stable release:",
    "",
    ...[...prs.values()]
      .sort((a, b) => a.number - b.number)
      .map(
        (pr) =>
          `- ${safeTitle(pr.title)} ([#${pr.number}](https://github.com/${repository}/pull/${pr.number}))`,
      ),
    ...direct,
  ];
  if (previous)
    lines.push(
      "",
      `Full changelog: https://github.com/${repository}/compare/${previous}...${identity.tag}`,
    );
  return lines.join("\n") + "\n";
}
export async function publishStable(
  directory: string,
  env: NodeJS.ProcessEnv,
  api: Api,
  notes: string,
) {
  return publishArtifacts(directory, env, api, {
    validate: validateStable,
    authorize: authorizeStable,
    prerelease: false,
    name: (identity) => `Decker ${identity.version}`,
    body: notes,
    sameProvenance: (a, b) =>
      [
        "repository",
        "source_sha",
        "source_date",
        "version",
        "debian_version",
        "architecture",
        "tag",
      ].every(
        (k) => a[k as keyof BuildIdentity] === b[k as keyof BuildIdentity],
      ),
  });
}
async function main() {
  const [command, directory = "release/stable"] = process.argv.slice(2);
  const env = process.env;
  if (command === "metadata") {
    const pkg = JSON.parse(await readFile("package.json", "utf8"));
    env.SOURCE_DATE = await git(["show", "-s", "--format=%cI", "HEAD"]);
    const identity = stableMetadata(env, pkg.version);
    await validateSource(env, identity);
    await previousStable(identity.version, identity.source_sha);
    await mkdir("work/stable", { recursive: true });
    await writeFile(
      "work/stable/metadata.json",
      JSON.stringify(identity, null, 2) + "\n",
    );
    await writeFile(
      "work/stable/builder.json",
      JSON.stringify(
        { ...pkg.build, extraMetadata: { version: identity.version } },
        null,
        2,
      ) + "\n",
    );
  } else if (command === "bundle") {
    const identity = JSON.parse(
      await readFile("work/stable/metadata.json", "utf8"),
    );
    await validateSource(env, identity);
    await bundle("release", identity, directory, validateStable);
    await verifyBundle(directory, validateStable);
  } else if (command === "notes" || command === "publish") {
    if (!env.GH_TOKEN) throw new Error("Missing GitHub token");
    const identity = await verifyBundle(directory, validateStable);
    await validateSource(env, identity);
    const api = githubApi(env.GH_TOKEN);
    if (command === "notes")
      await writeFile(
        "work/stable/notes.md",
        await releaseNotes(identity, api),
      );
    else {
      // Generate notes from associated PRs as data; never interpolate titles into a shell.
      const notes = await releaseNotes(identity, api);
      console.log(await publishStable(directory, env, api, notes));
    }
  } else throw new Error("Use metadata, bundle, notes or publish");
}
if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
)
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
