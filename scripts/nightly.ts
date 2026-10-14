import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import {
  copyFile,
  lstat,
  mkdir,
  readFile,
  readdir,
  writeFile,
} from "node:fs/promises";
import { createRequire } from "node:module";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const execute = promisify(execFile);
const repository = "ianwijma/decker";
export interface BuildIdentity {
  repository: string;
  source_sha: string;
  source_date: string;
  run_id: string;
  run_number: string;
  version: string;
  debian_version: string;
  architecture: "x64";
  tag: string;
}
export interface Manifest extends BuildIdentity {
  files: Array<{ name: string; size: number; sha256: string }>;
}
export function metadata(
  env: NodeJS.ProcessEnv,
  baseVersion: string,
): BuildIdentity {
  const base = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[\w.-]+)?$/.exec(
    baseVersion,
  );
  if (!base || !/^[a-f0-9]{40}$/.test(env.GITHUB_SHA ?? ""))
    throw new Error("Invalid package version or source SHA");
  for (const key of ["GITHUB_RUN_ID", "GITHUB_RUN_NUMBER"])
    if (
      !/^[1-9]\d*$/.test(env[key] ?? "") ||
      !Number.isSafeInteger(Number(env[key]))
    )
      throw new Error(`Invalid ${key}`);
  const sourceDate = new Date(env.SOURCE_DATE ?? "");
  if (!Number.isFinite(sourceDate.getTime()))
    throw new Error("Invalid source date");
  const date = sourceDate.toISOString().slice(0, 10).replaceAll("-", "");
  const stable = base.slice(1, 4).join(".");
  const version = `${stable}-dev.${date}.${env.GITHUB_RUN_NUMBER}.${env.GITHUB_RUN_ID}.sha${env.GITHUB_SHA!.slice(0, 12)}`;
  return {
    repository: env.GITHUB_REPOSITORY ?? "",
    source_sha: env.GITHUB_SHA!,
    source_date: sourceDate.toISOString(),
    run_id: env.GITHUB_RUN_ID!,
    run_number: env.GITHUB_RUN_NUMBER!,
    version,
    // electron-builder's Debian target converts '-' to '~'. Unlike '-', '~'
    // sorts below the corresponding stable Debian version.
    debian_version: version.replaceAll("-", "~"),
    architecture: "x64",
    tag: `v${version}`,
  };
}
function validateIdentity(value: BuildIdentity) {
  const base = value.version.split("-dev.")[0];
  const expected = metadata(
    {
      GITHUB_REPOSITORY: value.repository,
      GITHUB_SHA: value.source_sha,
      SOURCE_DATE: value.source_date,
      GITHUB_RUN_ID: value.run_id,
      GITHUB_RUN_NUMBER: value.run_number,
    },
    base,
  );
  for (const key of Object.keys(expected) as Array<keyof BuildIdentity>)
    if (value[key] !== expected[key])
      throw new Error(`Invalid manifest ${key}`);
}
export function assertPublication(
  env: NodeJS.ProcessEnv,
  identity: BuildIdentity,
) {
  validateIdentity(identity);
  if (
    env.GITHUB_EVENT_NAME !== "push" ||
    env.GITHUB_REF !== "refs/heads/develop" ||
    env.GITHUB_REPOSITORY !== repository ||
    identity.repository !== repository ||
    env.VERIFY_RESULT !== "success" ||
    env.GITHUB_SHA !== identity.source_sha ||
    env.GITHUB_RUN_ID !== identity.run_id ||
    env.GITHUB_RUN_NUMBER !== identity.run_number
  )
    throw new Error(
      "Publication requires a successful develop push from this workflow run",
    );
}
const json = (value: unknown) => JSON.stringify(value, null, 2) + "\n";
const hash = (bytes: Uint8Array) =>
  createHash("sha256").update(bytes).digest("hex");
function filenames(identity: BuildIdentity) {
  // electron-builder expands ${arch} using each target's native architecture name.
  return [
    `decker-${identity.version}-amd64.deb`,
    `decker-${identity.version}-x86_64.AppImage`,
  ];
}
function checksumText(manifest: Manifest) {
  return manifest.files.map((f) => `${f.sha256}  ${f.name}\n`).join("");
}
export function validateManifest(
  manifest: Manifest,
  validate = validateIdentity,
) {
  validate(manifest);
  const expected = filenames(manifest);
  if (
    !Array.isArray(manifest.files) ||
    manifest.files.length !== expected.length
  )
    throw new Error("Expected exactly Debian and AppImage artifacts");
  manifest.files.forEach((file, i) => {
    if (
      file.name !== expected[i] ||
      !Number.isSafeInteger(file.size) ||
      file.size <= 0 ||
      !/^[a-f0-9]{64}$/.test(file.sha256)
    )
      throw new Error("Invalid artifact manifest");
  });
}
async function regularFile(path: string) {
  if (!(await lstat(path)).isFile())
    throw new Error(`Not a regular file: ${path}`);
  return readFile(path);
}
export async function bundle(
  directory: string,
  identity: BuildIdentity,
  destination: string,
  validate = validateIdentity,
) {
  validate(identity);
  const expected = filenames(identity);
  const installers = (await readdir(directory))
    .filter((name) => /\.(deb|AppImage)$/.test(name))
    .sort();
  if (json(installers) !== json([...expected].sort()))
    throw new Error("Missing, extra, or incorrectly versioned installer");
  const deb = join(directory, expected[0]);
  const field = async (name: string) =>
    (await execute("dpkg-deb", ["--field", deb, name])).stdout.trim();
  if (
    (await field("Version")) !== identity.debian_version ||
    (await field("Architecture")) !== "amd64"
  )
    throw new Error(
      "Debian package version/architecture does not match this build",
    );
  const require = createRequire(import.meta.url);
  const packaged = JSON.parse(
    require("@electron/asar")
      .extractFile(
        join(directory, "linux-unpacked/resources/app.asar"),
        "package.json",
      )
      .toString(),
  );
  if (packaged.version !== identity.version)
    throw new Error("Packaged app version does not match this build");
  const manifest: Manifest = { ...identity, files: [] };
  // Never reuse a bundle directory from another attempt.
  await mkdir(destination);
  for (const name of expected) {
    const bytes = await regularFile(join(directory, name));
    manifest.files.push({ name, size: bytes.length, sha256: hash(bytes) });
    await copyFile(join(directory, name), join(destination, name));
  }
  validateManifest(manifest, validate);
  await writeFile(join(destination, "manifest.json"), json(manifest));
  await writeFile(join(destination, "SHA256SUMS"), checksumText(manifest));
  return manifest;
}
export async function verifyBundle(
  directory: string,
  validate = validateIdentity,
): Promise<Manifest> {
  const manifest = JSON.parse(
    (await regularFile(join(directory, "manifest.json"))).toString(),
  ) as Manifest;
  validateManifest(manifest, validate);
  const expected = [
    ...filenames(manifest),
    "manifest.json",
    "SHA256SUMS",
  ].sort();
  if (json((await readdir(directory)).sort()) !== json(expected))
    throw new Error("Unexpected bundle files");
  for (const file of manifest.files) {
    const bytes = await regularFile(join(directory, file.name));
    if (bytes.length !== file.size || hash(bytes) !== file.sha256)
      throw new Error(`Checksum mismatch: ${file.name}`);
  }
  if (
    (await regularFile(join(directory, "SHA256SUMS"))).toString() !==
    checksumText(manifest)
  )
    throw new Error("Checksum list does not match manifest");
  return manifest;
}

export type Api = (
  method: string,
  path: string,
  body?: unknown,
) => Promise<Response>;
interface Asset {
  id: number;
  name: string;
  size: number;
  state: string;
}
interface Release {
  id: number;
  tag_name: string;
  target_commitish: string;
  draft: boolean;
  prerelease: boolean;
  upload_url: string;
  assets: Asset[];
}
async function responseJson<T>(response: Response): Promise<T> {
  if (!response.ok) throw new Error(`GitHub API returned ${response.status}`);
  return response.json() as Promise<T>;
}
async function findRelease(
  api: Api,
  tag: string,
): Promise<Release | undefined> {
  const response = await api("GET", `releases/tags/${encodeURIComponent(tag)}`);
  return response.status === 404 ? undefined : responseJson<Release>(response);
}
async function assertTag(api: Api, identity: BuildIdentity, create: boolean) {
  const path = `git/ref/tags/${encodeURIComponent(identity.tag)}`;
  let response = await api("GET", path);
  if (response.status === 404 && create) {
    response = await api("POST", "git/refs", {
      ref: `refs/tags/${identity.tag}`,
      sha: identity.source_sha,
    });
    // A simultaneous retry may have just created the same immutable tag.
    if (response.status === 422) response = await api("GET", path);
  }
  const tag = await responseJson<{ object: { sha: string; type: string } }>(
    response,
  );
  if (tag.object.type !== "commit" || tag.object.sha !== identity.source_sha)
    throw new Error("Release tag does not point to the exact source commit");
}
async function assetBytes(api: Api, asset: Asset) {
  if (asset.state !== "uploaded")
    throw new Error(`Incomplete release asset: ${asset.name}`);
  const response = await api("GET", `releases/assets/${asset.id}`);
  if (!response.ok)
    throw new Error(`Asset download failed: ${response.status}`);
  const bytes = Buffer.from(await response.arrayBuffer());
  if (bytes.length !== asset.size)
    throw new Error(`Asset size mismatch: ${asset.name}`);
  return bytes;
}
export interface PublicationPolicy {
  validate: (identity: BuildIdentity) => void;
  authorize: (env: NodeJS.ProcessEnv, identity: BuildIdentity) => void;
  prerelease: boolean;
  name: (identity: BuildIdentity) => string;
  body: string;
  sameProvenance: (original: Manifest, current: Manifest) => boolean;
}
function assertRelease(
  release: Release,
  identity: BuildIdentity,
  prerelease: boolean,
) {
  if (
    release.prerelease !== prerelease ||
    release.tag_name !== identity.tag ||
    release.target_commitish !== identity.source_sha
  )
    throw new Error(
      prerelease
        ? "Existing release has conflicting provenance or is not a prerelease"
        : "Existing release has conflicting provenance or is not stable",
    );
}
export async function publish(
  directory: string,
  env: NodeJS.ProcessEnv,
  api: Api,
) {
  return publishArtifacts(directory, env, api, {
    validate: validateIdentity,
    authorize: assertPublication,
    prerelease: true,
    name: (identity) => `Decker development ${identity.version}`,
    body: `Development build of ${env.GITHUB_SHA}.\n\nSource workflow: https://github.com/${repository}/actions/runs/${env.GITHUB_RUN_ID}\n\nIncludes Linux x64 Debian/AppImage installers, manifest and SHA-256 checksums. Automated checks are not hardware certification.`,
    sameProvenance: (original, current) =>
      Object.keys(current)
        .filter((k) => k !== "files")
        .every(
          (k) =>
            original[k as keyof BuildIdentity] ===
            current[k as keyof BuildIdentity],
        ),
  });
}
export async function publishArtifacts(
  directory: string,
  env: NodeJS.ProcessEnv,
  api: Api,
  policy: PublicationPolicy,
) {
  const manifest = await verifyBundle(directory, policy.validate);
  policy.authorize(env, manifest);
  let release = await findRelease(api, manifest.tag);
  if (release) assertRelease(release, manifest, policy.prerelease);
  await assertTag(api, manifest, !release || release.draft);
  if (!release) {
    const response = await api("POST", "releases", {
      tag_name: manifest.tag,
      target_commitish: manifest.source_sha,
      name: policy.name(manifest),
      draft: true,
      prerelease: policy.prerelease,
      make_latest: "false",
      body: policy.body,
    });
    release =
      response.status === 422
        ? await findRelease(api, manifest.tag)
        : await responseJson<Release>(response);
    if (!release) throw new Error("Release creation failed");
    assertRelease(release, manifest, policy.prerelease);
  }
  const expectedNames = [...filenames(manifest), "SHA256SUMS", "manifest.json"];
  if (
    new Set(release.assets.map((a) => a.name)).size !== release.assets.length ||
    release.assets.some((a) => !expectedNames.includes(a.name))
  )
    throw new Error("Unexpected or duplicate release assets");
  if (!release.draft) {
    // A full rerun may produce different installer bytes. Preserve the originally
    // tested/published bytes and verify them against their original manifest.
    const originalAsset = release.assets.find(
      (a) => a.name === "manifest.json",
    );
    if (!originalAsset)
      throw new Error("Published release is missing its manifest");
    const original = JSON.parse(
      (await assetBytes(api, originalAsset)).toString(),
    ) as Manifest;
    validateManifest(original, policy.validate);
    if (!policy.sameProvenance(original, manifest))
      throw new Error("Published manifest provenance mismatch");
    if (release.assets.length !== expectedNames.length)
      throw new Error("Published release is incomplete");
    for (const file of original.files) {
      const asset = release.assets.find((a) => a.name === file.name)!;
      const bytes = await assetBytes(api, asset);
      if (bytes.length !== file.size || hash(bytes) !== file.sha256)
        throw new Error("Published checksum mismatch");
    }
    const checksums = release.assets.find((a) => a.name === "SHA256SUMS")!;
    if (
      (await assetBytes(api, checksums)).toString() !== checksumText(original)
    )
      throw new Error("Published checksum list mismatch");
    return "already published; original immutable assets verified";
  }
  const uploadUrl = new URL(release.upload_url.split("{")[0]);
  if (
    uploadUrl.protocol !== "https:" ||
    uploadUrl.hostname !== "uploads.github.com" ||
    uploadUrl.pathname !== `/repos/${repository}/releases/${release.id}/assets`
  )
    throw new Error("Unexpected upload URL");
  for (const name of expectedNames) {
    const bytes = await regularFile(join(directory, name));
    const existing = release.assets.find((a) => a.name === name);
    if (existing) {
      if (!(await assetBytes(api, existing)).equals(bytes))
        throw new Error(`Refusing to replace immutable asset: ${name}`);
    } else {
      uploadUrl.searchParams.set("name", name);
      const asset = await responseJson<Asset>(
        await api("POST", uploadUrl.href, bytes),
      );
      if (asset.name !== name || !(await assetBytes(api, asset)).equals(bytes))
        throw new Error(`Uploaded artifact verification failed: ${name}`);
    }
  }
  // Expose the release only after all four uploaded assets have been verified.
  await responseJson(
    await api("PATCH", `releases/${release.id}`, {
      draft: false,
      prerelease: policy.prerelease,
      make_latest: policy.prerelease ? "false" : "true",
    }),
  );
  return policy.prerelease
    ? "published verified development prerelease"
    : "published verified stable release";
}
export function githubApi(token: string): Api {
  return async (method, path, body) => {
    const url = path.startsWith("https:")
      ? path
      : `https://api.github.com/repos/${repository}/${path}`;
    const bytes = Buffer.isBuffer(body);
    return fetch(url, {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        "X-GitHub-Api-Version": "2022-11-28",
        Accept: path.startsWith("releases/assets/")
          ? "application/octet-stream"
          : "application/vnd.github+json",
        "Content-Type": bytes ? "application/octet-stream" : "application/json",
      },
      ...(body === undefined
        ? {}
        : { body: bytes ? new Uint8Array(body) : JSON.stringify(body) }),
    });
  };
}
async function main() {
  const [command, directory = "release/nightly"] = process.argv.slice(2);
  if (command === "metadata") {
    const packageJson = JSON.parse(await readFile("package.json", "utf8"));
    const identity = metadata(process.env, packageJson.version);
    if (
      (await execute("git", ["rev-parse", "HEAD"])).stdout.trim() !==
      identity.source_sha
    )
      throw new Error("Checkout SHA does not match the workflow source");
    await mkdir(directory, { recursive: true });
    await writeFile(join(directory, "metadata.json"), json(identity));
    await writeFile(
      join(directory, "builder.json"),
      json({
        ...packageJson.build,
        extraMetadata: { version: identity.version },
      }),
    );
    console.log(json(identity));
  } else if (command === "bundle") {
    const identity = JSON.parse(
      await readFile("work/nightly/metadata.json", "utf8"),
    ) as BuildIdentity;
    console.log(json(await bundle("release", identity, directory)));
  } else if (command === "verify") {
    console.log(json(await verifyBundle(directory)));
  } else if (command === "publish") {
    if (!process.env.GH_TOKEN) throw new Error("Missing publication token");
    console.log(
      await publish(directory, process.env, githubApi(process.env.GH_TOKEN)),
    );
  } else throw new Error("Use metadata, bundle, verify or publish");
}
if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
)
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
