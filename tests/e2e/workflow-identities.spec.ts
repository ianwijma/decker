import {
  test,
  expect,
  _electron as electron,
  type ElectronApplication,
  type Page,
} from "@playwright/test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
let app: ElectronApplication, directory: string;
async function launch() {
  const executablePath = process.env.DECKER_EXECUTABLE;
  app = await electron.launch({
    ...(executablePath ? { executablePath } : {}),
    args: [...(executablePath ? [] : ["."]), "--no-sandbox"],
    env: { ...process.env, DECKER_DATA_DIR: directory },
  });
  const page = await app.firstWindow();
  await expect(
    page.getByRole("button", { name: "Deck: My XL", exact: true }),
  ).toBeVisible();
  return page;
}
test.beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), "decker-workflow-uuid-"));
});
test.afterEach(async () => {
  await app?.close();
  await rm(directory, { recursive: true, force: true });
});
async function saved(page: Page) {
  await expect(
    page.getByText("All changes saved", { exact: true }),
  ).toBeVisible();
}
async function select(page: Page, label: string, name = "Second duplicate") {
  await page.getByRole("button", { name: new RegExp(`^${label}:`) }).click();
  const search = page.getByRole("combobox", {
    name:
      label === "Workflow"
        ? "Search workflows"
        : `Search ${label.toLowerCase()} workflows`,
  });
  await expect(search).toBeFocused();
  await search.fill(name);
  await page.getByRole("option", { name, exact: true }).click();
  await expect(search).toHaveCount(0);
}
async function noIds(page: Page, ids: string[]) {
  const text = await page.locator("body").innerText();
  const fields = await page
    .locator("textarea, input:not([type=hidden])")
    .evaluateAll((elements) =>
      elements.map((element) => (element as HTMLInputElement).value).join("\n"),
    );
  for (const id of ids) {
    expect(text).not.toContain(id);
    expect(fields).not.toContain(id);
  }
}

test("all workflow selectors hide UUIDs, disambiguate duplicates, preserve bindings across rename and reload, and show deletion", async () => {
  let page = await launch();
  const ids = await page.evaluate(async () => {
    const doc = (await window.decker.snapshot()).document,
      original = doc.workflows[0];
    original.name = "Duplicate flow";
    const second = {
      ...structuredClone(original),
      id: crypto.randomUUID(),
      name: "Duplicate flow",
    };
    doc.workflows.push(second);
    doc.workflowAliases.old = second.id;
    await window.decker.request({ type: "save", document: doc });
    return doc.workflows.map((w) => w.id);
  });
  await page.getByRole("button", { name: "Flows", exact: true }).click();
  await page.getByRole("button", { name: /^Workflow:/ }).click();
  await expect(
    page.getByRole("option", { name: /Duplicate flow/ }),
  ).toHaveCount(2);
  await expect(page.getByRole("option", { name: /Choice 1$/ })).toBeVisible();
  await expect(page.getByRole("option", { name: /Choice 2$/ })).toBeVisible();
  await noIds(page, ids);
  await page.getByRole("option", { name: /Choice 2$/ }).click();
  await page
    .getByRole("textbox", { name: "Workflow name", exact: true })
    .fill("Second duplicate");
  await saved(page);
  await page.getByRole("button", { name: "Deck: My XL", exact: true }).click();
  await page
    .getByRole("button", { name: "Key 3: Welcome flow", exact: true })
    .click();
  for (const phase of ["Press", "Release", "Hold"]) {
    await page.getByRole("button", { name: phase, exact: true }).click();
    await page
      .getByRole("combobox", { name: "Assignment", exact: true })
      .selectOption("workflow");
    await select(page, "Workflow");
    await noIds(page, ids);
  }
  await page.getByRole("button", { name: "Press", exact: true }).click();
  await page
    .getByRole("combobox", { name: "Assignment", exact: true })
    .selectOption("sequence");
  await page
    .getByRole("combobox", { name: "Action", exact: true })
    .selectOption("workflow.run");
  await select(page, "Workflow");
  await page.getByRole("button", { name: "Add step", exact: true }).click();
  const step = page.locator(".sequence-item").nth(1);
  await step
    .getByRole("combobox", { name: "Action", exact: true })
    .selectOption("workflow.cancel");
  await step.getByRole("button", { name: /^Workflow:/ }).click();
  await page
    .getByRole("combobox", { name: "Search workflows" })
    .fill("Second duplicate");
  await page
    .getByRole("option", { name: "Second duplicate", exact: true })
    .click();
  await noIds(page, ids);
  await saved(page);
  await page.getByRole("button", { name: "Release", exact: true }).click();
  await page
    .getByRole("combobox", { name: "Assignment", exact: true })
    .selectOption("action");
  await page
    .getByRole("combobox", { name: "Action", exact: true })
    .selectOption("workflow.run");
  await select(page, "Workflow");
  await page.getByRole("button", { name: "Flows", exact: true }).click();
  await select(page, "Workflow", "Duplicate flow");
  for (const [nodeName, action] of [
    ["Run", "workflow.run"],
    ["Cancel", "workflow.cancel"],
  ]) {
    await page
      .getByRole("button", {
        name: `Add ${nodeName === "Run" ? "Run workflow" : "Cancel workflow"} node`,
        exact: true,
      })
      .click();
    await page
      .getByRole("combobox", { name: "Action", exact: true })
      .selectOption(action);
    // The studio workflow selector and action selector share their label.
    await page
      .locator(".fields")
      .getByRole("button", { name: /^Workflow:/ })
      .click();
    await page
      .getByRole("combobox", { name: "Search workflows" })
      .fill("Second duplicate");
    await page
      .getByRole("option", { name: "Second duplicate", exact: true })
      .click();
    await page
      .getByRole("textbox", { name: "Node name", exact: true })
      .fill(nodeName);
  }
  await page
    .getByRole("button", { name: "Add Call subflow node", exact: true })
    .click();
  await select(page, "Subflow");
  await noIds(page, ids);
  const configuration = page.getByRole("textbox", {
    name: "Configuration",
    exact: true,
  });
  expect(JSON.parse(await configuration.inputValue()).revision).toBeGreaterThan(
    0,
  );
  await select(page, "Workflow");
  await page
    .getByRole("textbox", { name: "Workflow name", exact: true })
    .fill("Renamed bound flow");
  await saved(page);
  await page
    .getByRole("button", { name: "Create workflow", exact: true })
    .click();
  await expect(
    page.getByRole("textbox", { name: "Workflow name", exact: true }),
  ).toBeFocused();
  await page
    .getByRole("textbox", { name: "Workflow name", exact: true })
    .fill("Created UUID flow");
  await saved(page);
  await app.close();
  page = await launch();
  await page
    .getByRole("button", { name: "Key 3: Welcome flow", exact: true })
    .click();
  await expect(
    page.locator(".sequence-item").getByRole("button", { name: /^Workflow:/ }),
  ).toHaveText(["Renamed bound flow", "Renamed bound flow"]);
  await page.getByRole("button", { name: "Release", exact: true }).click();
  await expect(page.getByRole("button", { name: /^Workflow:/ })).toHaveText(
    "Renamed bound flow",
  );
  await page.getByRole("button", { name: "Hold", exact: true }).click();
  await expect(page.getByRole("button", { name: /^Workflow:/ })).toHaveText(
    "Renamed bound flow",
  );
  const doc = (await page.evaluate(() => window.decker.snapshot())).document;
  const key = doc.profiles[0].pages[0].keys[2];
  expect(key.press).toMatchObject({
    kind: "sequence",
    actions: [
      { config: { workflowId: ids[1] } },
      { config: { workflowId: ids[1] } },
    ],
  });
  expect(key.longPress).toMatchObject({ workflowId: ids[1] });
  expect(doc.workflows.find((w) => w.name === "Created UUID flow")!.id).toMatch(
    /^[a-f0-9-]{36}$/,
  );
  await page.evaluate(async (id) => {
    const doc = (await window.decker.snapshot()).document;
    doc.workflows = doc.workflows.filter((w) => w.id !== id);
    await window.decker.request({ type: "save", document: doc });
  }, ids[1]);
  await expect(page.getByRole("button", { name: /^Workflow:/ })).toHaveText(
    "Workflow unavailable — choose a replacement",
  );
  await noIds(page, ids);
  const after = (await page.evaluate(() => window.decker.snapshot())).document;
  expect(after.profiles[0].pages[0].keys[2].longPress).toEqual(key.longPress);
  expect(after.workflowAliases.old).toBe(ids[1]);
});
