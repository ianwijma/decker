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
  await page.getByRole("button", { name: "Deck: My XL", exact: true }).click();
  return page;
}
test.beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), "decker-selectors-"));
});
test.afterEach(async () => {
  await app?.close();
  await rm(directory, { recursive: true, force: true });
});
async function seed(page: Page) {
  const ids = await page.evaluate(async () => {
    const snapshot = await window.decker.snapshot(),
      doc = snapshot.document;
    const original = doc.workflows[0];
    doc.workflows = Array.from({ length: 55 }, (_, i) => ({
      ...structuredClone(original),
      id: crypto.randomUUID(),
      name: i === 51 || i === 52 ? "Duplicate flow" : `Flow ${i}`,
    }));
    doc.profiles = Array.from({ length: 55 }, (_, i) => ({
      id: `profile-${i}`,
      name: i === 51 || i === 52 ? "Duplicate profile" : `Profile ${i}`,
      pages: [{ id: `page-${i}`, name: "Home", keys: {} }],
    }));
    doc.profiles.push({
      id: "other-profile",
      name: "Other deck only",
      pages: [{ id: "other-page", name: "Home", keys: {} }],
    });
    const deck = doc.decks[0];
    deck.profileIds = doc.profiles.slice(0, 55).map((p) => p.id);
    deck.activeProfileId = "profile-0";
    deck.activePageId = "page-0";
    doc.decks.push({
      ...structuredClone(deck),
      id: "other-deck",
      name: "Other deck",
      kind: "simulator",
      hardwareId: undefined,
      profileIds: ["other-profile"],
      activeProfileId: "other-profile",
      activePageId: "other-page",
    });
    await window.decker.request({
      type: "save",
      document: doc,
      navigationEdits: [deck.id],
    });
    return doc.workflows.map((workflow) => workflow.id);
  });
  // Direct IPC saves commit before the deferred renderer snapshot arrives.
  // Observe that document in the UI before an action can edit/save its copy.
  await expect(page.getByRole("button", { name: /^Profile:/ })).toHaveText(
    "Profile 0",
  );
  return ids;
}
async function saved(page: Page) {
  await expect(
    page.getByText("All changes saved", { exact: true }),
  ).toBeVisible();
}

test("change profile searches deck-scoped names, saves IDs and navigates after relaunch", async () => {
  let page = await launch();
  await seed(page);
  await page
    .getByRole("button", { name: "Change profile", exact: true })
    .click();
  const trigger = page.getByRole("button", { name: /^Target profile:/ });
  await expect(trigger).toHaveText("Choose profile");
  await expect(page.getByRole("textbox", { name: "Profile ID" })).toHaveCount(
    0,
  );
  await trigger.click();
  const search = page.getByRole("combobox", { name: "Search profiles" });
  await expect(page.getByRole("listbox").getByRole("option")).toHaveCount(55);
  await expect(
    page.getByRole("listbox").getByRole("option", { name: /Other deck only/ }),
  ).toHaveCount(0);
  await search.fill("dUpLiCaTe profile");
  await expect(page.getByRole("listbox").getByRole("option")).toHaveCount(2);
  await search.press("ArrowDown");
  await search.press("Enter");
  await expect(trigger).toHaveText("Duplicate profile");
  await expect(trigger).toBeFocused();
  await saved(page);
  await expect
    .poll(async () => {
      const doc = (await page.evaluate(() => window.decker.snapshot()))
        .document;
      return doc.profiles[0].pages[0].keys[0].press;
    })
    .toMatchObject({
      kind: "action",
      action: { config: { profileId: "profile-52" } },
    });
  await app.close();
  page = await launch();
  await expect(
    page.getByRole("button", { name: /^Target profile:/ }),
  ).toHaveText("Duplicate profile");
  await page
    .getByRole("button", { name: "Key 1: Change profile", exact: true })
    .dblclick();
  await expect(page.getByRole("button", { name: /^Profile:/ })).toHaveText(
    "Duplicate profile",
  );
  await expect
    .poll(
      async () =>
        (await page.evaluate(() => window.decker.snapshot())).document.decks[0]
          .activeProfileId,
    )
    .toBe("profile-52");
});

test("change page searches pages and nested folders, preserves missing targets and runs the saved selection", async () => {
  let page = await launch();
  await seed(page);
  await page.evaluate(async () => {
    const doc = (await window.decker.snapshot()).document;
    doc.profiles[0].pages.push(
      { id: "tools", name: "Tools", keys: {} },
      {
        id: "folder-a",
        name: "Duplicate folder",
        parentId: "page-0",
        keys: {},
      },
      { id: "folder-b", name: "Duplicate folder", parentId: "tools", keys: {} },
      { id: "nested", name: "Nested folder", parentId: "folder-b", keys: {} },
    );
    doc.profiles[1].pages[0].name = "Other profile page";
    await window.decker.request({ type: "save", document: doc });
  });
  await page
    .getByRole("button", { name: "Change page / folder", exact: true })
    .click();
  const trigger = page.getByRole("button", { name: /^Page \/ folder:/ });
  await expect(trigger).toHaveText("Choose page or folder");
  await expect(page.getByRole("textbox", { name: "Page ID" })).toHaveCount(0);
  await trigger.click();
  const search = page.getByRole("combobox", {
    name: "Search pages and folders",
  });
  await expect(page.getByRole("listbox").getByRole("option")).toHaveCount(5);
  await expect(
    page
      .getByRole("listbox")
      .getByRole("option", { name: /Other profile page/ }),
  ).toHaveCount(0);
  await search.fill("no match");
  await expect(page.getByRole("status")).toHaveText("No results");
  await search.press("Enter");
  await expect(search).toBeFocused();
  await search.fill("Duplicate folder");
  await expect(page.getByRole("listbox").getByRole("option")).toHaveCount(2);
  await page
    .getByRole("listbox")
    .getByRole("option", { name: /Folder in Tools.*ID: folder-b/ })
    .click();
  await expect(trigger).toHaveText("Duplicate folder");
  await expect(search).toHaveCount(0);
  await saved(page);
  await page.evaluate(async () => {
    const doc = (await window.decker.snapshot()).document;
    doc.profiles[0].pages.find((p) => p.id === "folder-b")!.name =
      "Renamed folder";
    await window.decker.request({ type: "save", document: doc });
  });
  await expect(trigger).toHaveText("Renamed folder");
  await page.evaluate(async () => {
    const doc = (await window.decker.snapshot()).document;
    doc.profiles[0].pages = doc.profiles[0].pages.filter(
      (p) => p.id !== "folder-b" && p.id !== "nested",
    );
    await window.decker.request({ type: "save", document: doc });
  });
  await expect(trigger).toHaveText(
    "Page / folder unavailable — choose a replacement",
  );
  await expect
    .poll(async () => {
      const doc = (await page.evaluate(() => window.decker.snapshot()))
        .document;
      return doc.profiles[0].pages[0].keys[0].press;
    })
    .toMatchObject({
      kind: "action",
      action: { config: { pageId: "folder-b" } },
    });
  await trigger.click();
  await search.fill("Tools");
  await search.press("Escape");
  await expect(trigger).toHaveText(
    "Page / folder unavailable — choose a replacement",
  );
  await trigger.click();
  await search.fill("Duplicate folder");
  await search.press("Enter");
  await saved(page);
  await app.close();
  page = await launch();
  await expect(
    page.getByRole("button", { name: /^Page \/ folder:/ }),
  ).toHaveText("Duplicate folder");
  await page
    .getByRole("button", { name: "Key 1: Change page / folder", exact: true })
    .dblclick();
  await expect
    .poll(
      async () =>
        (await page.evaluate(() => window.decker.snapshot())).document.decks[0]
          .activePageId,
    )
    .toBe("folder-a");
});

test("55 flows stay compact, support keyboard search and duplicates, and create/rename/switch/relaunch", async () => {
  let page = await launch();
  const ids = await seed(page);
  await page.getByRole("button", { name: "Flows", exact: true }).click();
  const trigger = page.getByRole("button", { name: /^Workflow:/ });
  await expect(trigger).toHaveText("Flow 0");
  await expect(
    page.getByRole("combobox", { name: "Search workflows" }),
  ).toHaveCount(0);
  const libraryTop = (await page
    .getByText("NODE LIBRARY", { exact: true })
    .boundingBox())!.y;
  await trigger.focus();
  await page.keyboard.press("ArrowDown");
  const search = page.getByRole("combobox", { name: "Search workflows" });
  await expect(search).toBeFocused();
  await expect(page.getByRole("option")).toHaveCount(55);
  expect(
    (await page.getByText("NODE LIBRARY", { exact: true }).boundingBox())!.y,
  ).toBe(libraryTop);
  const list = page.getByRole("listbox", { name: "Workflow", exact: true });
  expect(
    await list.evaluate(
      (element) => element.scrollHeight > element.clientHeight,
    ),
  ).toBe(true);
  await search.fill("fLoW 54");
  await expect(page.getByRole("option")).toHaveCount(1);
  await page.keyboard.press("Enter");
  await expect(trigger).toBeFocused();
  await expect(trigger).toHaveText("Flow 54");
  await trigger.click();
  await search.fill("not found");
  await expect(page.getByRole("status")).toHaveText("No results");
  await expect(search).not.toHaveAttribute("aria-activedescendant");
  await page.keyboard.press("Enter");
  await expect(search).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(trigger).toBeFocused();
  await expect(trigger).toHaveText("Flow 54");
  await trigger.click();
  await expect(search).toHaveValue("");
  await search.fill("Duplicate flow");
  await expect(page.getByRole("option")).toHaveCount(2);
  await page.keyboard.press("ArrowDown");
  await page.keyboard.press("ArrowUp");
  await page.keyboard.press("ArrowDown");
  await page.keyboard.press("Enter");
  await expect(trigger).toHaveText("Duplicate flow");
  await page
    .getByRole("textbox", { name: "Workflow name", exact: true })
    .fill("Second duplicate");
  await saved(page);
  await expect
    .poll(
      async () =>
        (
          await page.evaluate(() => window.decker.snapshot())
        ).document.workflows.find((workflow) => workflow.id === ids[52])!.name,
    )
    .toBe("Second duplicate");
  await page
    .getByRole("button", { name: "Create workflow", exact: true })
    .click();
  const name = page.getByRole("textbox", {
    name: "Workflow name",
    exact: true,
  });
  await expect(name).toBeFocused();
  await expect(name).toHaveCount(1);
  expect(
    await name.evaluate(
      (input: HTMLInputElement) => input.selectionEnd! - input.selectionStart!,
    ),
  ).toBe((await name.inputValue()).length);
  await expect(page.locator(".react-flow__node.selected")).toHaveCount(0);
  await expect(page.locator(".react-flow__node")).toHaveCount(1);
  await expect(page.locator(".react-flow__node")).toContainText("Deck press");
  await name.fill("My new workflow");
  await expect(trigger).toHaveText("My new workflow");
  await saved(page);
  await page.locator(".react-flow__node").click();
  await expect(name).toBeVisible();
  await name.fill("Renamed with node selected");
  await saved(page);
  await trigger.click();
  await search.fill("Flow 54");
  await page.getByRole("option", { name: "Flow 54", exact: true }).click();
  await expect(name).toHaveValue("Flow 54");
  await app.close();
  page = await launch();
  await page.getByRole("button", { name: "Flows", exact: true }).click();
  await page.getByRole("button", { name: /^Workflow:/ }).click();
  await page
    .getByRole("combobox", { name: "Search workflows" })
    .fill("Renamed with node selected");
  await page.keyboard.press("Enter");
  await expect(
    page.getByRole("textbox", { name: "Workflow name", exact: true }),
  ).toHaveValue("Renamed with node selected");
});

test("55 profiles use normal navigation, activate creation and stay deck scoped through reload", async () => {
  let page = await launch();
  await seed(page);
  const trigger = page.getByRole("button", { name: /^Profile:/ });
  await expect(trigger).toHaveText("Profile 0");
  await expect(
    page.getByRole("combobox", { name: "Search profiles" }),
  ).toHaveCount(0);
  await trigger.click();
  const search = page.getByRole("combobox", { name: "Search profiles" });
  await expect(search).toBeFocused();
  await expect(page.getByRole("option")).toHaveCount(55);
  await expect(
    page.getByRole("option", { name: /Other deck only/ }),
  ).toHaveCount(0);
  await search.fill("Profile 54");
  await page.keyboard.press("Enter");
  await expect(trigger).toBeFocused();
  await expect(trigger).toHaveText("Profile 54");
  await trigger.click();
  await search.fill("Duplicate profile");
  await expect(page.getByRole("option")).toHaveCount(2);
  await page.getByRole("option", { name: /ID: profile-52$/ }).click();
  // Navigation publishes a snapshot asynchronously. Wait for it to render
  // before fill selects the input text; a value update can reset that selection.
  await expect(trigger).toHaveText("Duplicate profile");
  await page.getByText("Manage profile & page", { exact: true }).click();
  const profileName = page.getByRole("textbox", {
    name: "Profile name",
    exact: true,
  });
  await expect(profileName).toHaveValue("Duplicate profile");
  await profileName.fill("Second profile duplicate");
  await expect(trigger).toHaveText("Second profile duplicate");
  await saved(page);
  await expect
    .poll(
      async () =>
        (await page.evaluate(() => window.decker.snapshot())).document.decks[0]
          .activeProfileId,
    )
    .toBe("profile-52");
  // Commands from actions and other surfaces must update the closed selector.
  await page.evaluate(async () => {
    const doc = (await window.decker.snapshot()).document;
    await window.decker.request({
      type: "navigate",
      deckId: doc.decks[0].id,
      profileId: "profile-3",
      pageId: "page-3",
    });
  });
  await expect(trigger).toHaveText("Profile 3");
  await page.getByRole("button", { name: "Add profile", exact: true }).click();
  await expect(trigger).toHaveText("Profile 57");
  await page
    .getByRole("textbox", { name: "Profile name", exact: true })
    .fill("Created and active");
  await saved(page);
  await trigger.click();
  await search.fill("old search");
  await page
    .getByRole("button", { name: "Deck: Other deck", exact: true })
    .click();
  await expect(trigger).toHaveText("Other deck only");
  await expect(search).toHaveCount(0);
  await trigger.click();
  await expect(search).toHaveValue("");
  await expect(page.getByRole("option")).toHaveCount(1);
  await search.fill("Created and active");
  await expect(page.getByRole("status")).toHaveText("No results");
  await page.keyboard.press("Escape");
  await expect(trigger).toBeFocused();
  await page.getByRole("button", { name: "Deck: My XL", exact: true }).click();
  await expect(trigger).toHaveText("Created and active");
  await trigger.click();
  await search.press("Tab");
  await expect(search).toHaveCount(0);
  await expect(
    page.getByRole("textbox", { name: "Search actions", exact: true }),
  ).toBeFocused();
  await trigger.click();
  await search.press("Shift+Tab");
  await expect(search).toHaveCount(0);
  await expect(trigger).toBeFocused();
  await page.reload();
  await page.getByRole("button", { name: "Deck: My XL", exact: true }).click();
  await expect(trigger).toHaveText("Created and active");
  await app.close();
  page = await launch();
  await expect(page.getByRole("button", { name: /^Profile:/ })).toHaveText(
    "Created and active",
  );
  await page
    .getByRole("button", { name: "Deck: Other deck", exact: true })
    .click();
  await expect(page.getByRole("button", { name: /^Profile:/ })).toHaveText(
    "Other deck only",
  );
});
