import { test, expect, _electron as electron } from "@playwright/test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

test("application dependency parses D-Bus introspection with the real proxy and Builder", async () => {
  const directory = await mkdtemp(join(tmpdir(), "decker-dbus-xml-"));
  const executablePath = process.env.DECKER_EXECUTABLE;
  const app = await electron.launch({
    ...(executablePath ? { executablePath } : {}),
    args: [...(executablePath ? [] : ["."]), "--no-sandbox"],
    env: { ...process.env, DECKER_DATA_DIR: directory },
  });
  try {
    const result = await app.evaluate(async ({ app }, fixturePath) => {
      const { createRequire } = process.getBuiltinModule("node:module");
      const appRequire = createRequire(`${app.getAppPath()}/package.json`);
      const fixture = appRequire(fixturePath);
      for (const verify of Object.values(fixture.scenarios)) {
        await (verify as (require: NodeJS.Require) => Promise<void>)(
          appRequire,
        );
      }
      const { parserPath, parserVersion } = fixture.libraries(appRequire);
      return { appPath: app.getAppPath(), parserPath, parserVersion };
    }, resolve("tests/fixtures/dbus-xml.cjs"));
    expect(result.parserVersion).toBe("0.6.2");
    expect(
      result.parserPath.startsWith(`${result.appPath}/node_modules/`),
    ).toBe(true);
    if (executablePath) expect(result.appPath).toMatch(/app\.asar$/);
    console.log("D-Bus parser compatibility:", result);
  } finally {
    await app.close();
    await rm(directory, { recursive: true, force: true });
  }
});
