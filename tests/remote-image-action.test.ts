import { expect, it, vi } from "vitest";
import { defaults, node } from "../src/shared/defaults";
import {
  makeAction,
  actionById,
  catalogForPalette,
} from "../src/shared/catalog";
import {
  credentialOwners,
  rekeyCredentials,
} from "../src/shared/credential-owners";
import { bindingChoices } from "../src/shared/data-presentation";
import { authoredAssetReferences } from "../src/shared/asset-references";
import { handlers } from "../src/actions/handlers";
import { ObsConnections } from "../src/integrations/obs";
import type { ActionContext } from "../src/runtime/engine";

it("exposes Fetch image only in workflows with typed URL/limits and a usable asset output", () => {
  expect(
    catalogForPalette("workflow").some((a) => a.id === "image.fetch"),
  ).toBe(true);
  expect(catalogForPalette("button").some((a) => a.id === "image.fetch")).toBe(
    false,
  );
  expect(
    actionById("image.fetch")!.schema.safeParse(
      makeAction("image.fetch").config,
    ).success,
  ).toBe(true);
  const f = defaults().workflows[0],
    fetch = {
      ...node("action", "Avatar"),
      id: "image",
      action: makeAction("image.fetch"),
    },
    update = {
      ...node("action", "Update"),
      id: "update",
      action: makeAction("deck.appearance"),
    };
  f.graph = {
    entry: "image",
    nodes: [fetch, update],
    edges: [{ id: "next", source: "image", target: "update", port: "next" }],
  };
  expect(bindingChoices(f, [], "update")).toContainEqual(
    expect.objectContaining({
      path: ["outputs", "image", "asset"],
      type: "text",
      conditional: false,
    }),
  );
  expect(
    actionById("image.fetch")!.schema.safeParse({
      url: "http://localhost/avatar",
      token: "plaintext",
    }).success,
  ).toBe(false);
});

it("registers nested image credential owners and rekeys references without carrying values in bundles", () => {
  const d = defaults(),
    a = makeAction("image.fetch");
  a.config.credentialRef = "managed:existing";
  const nested = { ...node("action", "Image"), action: a },
    parallel = node("parallel", "Parallel");
  parallel.branches = [{ entry: nested.id, nodes: [nested], edges: [] }];
  d.workflows[0].graph = { entry: parallel.id, nodes: [parallel], edges: [] };
  const owner = credentialOwners(d).find(
    (o) => o.action?.type === "image.fetch",
  )!;
  expect(owner.ref).toBe("managed:existing");
  owner.set("managed:new");
  expect(a.config.credentialRef).toBe("managed:new");
  expect(
    credentialOwners(rekeyCredentials(d, () => "import:missing")).find(
      (o) => o.action?.type === "image.fetch",
    )!.ref,
  ).toBe("import:missing");
  expect(a.config.credentialRef).toBe("managed:new");
  a.config.asset = { $ref: "inputs.asset", fallback: "a".repeat(64) };
  expect(authoredAssetReferences(d)).toEqual(new Set(["a".repeat(64)]));
});

it("captures bearer lookup once for the trusted main bridge, protects errors and rejects missing tokens", async () => {
  const d = defaults(),
    values = { "managed:test": "synthetic-image-token" },
    a = makeAction("image.fetch");
  a.config.credentialRef = "managed:test";
  const ctx: ActionContext = {
    runId: "manual",
    workflowId: d.workflows[0].id,
    signal: new AbortController().signal,
    actionId: "image",
  };
  const main = vi.fn(
    async (
      _: string,
      _c: unknown,
      context: ActionContext & { imageSecret?: string },
    ) => {
      values["managed:test"] = "replacement";
      expect(context.imageSecret).toBe("synthetic-image-token");
      throw new Error(`Echo ${context.imageSecret}`);
    },
  );
  const handler = handlers(
    () => d,
    () => values,
    main,
    new ObsConnections(() => {}),
  );
  await expect(handler(a, ctx)).rejects.toThrow("Echo [redacted]");
  a.config.credentialRef = "managed:missing";
  await expect(handler(a, ctx)).rejects.toThrow(/missing or locked/);
  expect(main).toHaveBeenCalledTimes(1);
});
