import {
  test,
  expect,
  _electron as electron,
  type ElectronApplication,
  type Page
} from '@playwright/test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
let desktop: ElectronApplication, page: Page, directory: string
const rendererErrors: string[] = []
test.beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'decker-e2e-'))
  desktop = await electron.launch({
    ...(process.env.DECKER_EXECUTABLE ? { executablePath: process.env.DECKER_EXECUTABLE } : {}),
    args: [
      ...(process.env.DECKER_EXECUTABLE ? [] : [resolve('out/main/index.js')]),
      '--no-sandbox'
    ],
    env: {
      ...process.env,
      DECKER_DATA_DIR: directory,
      XDG_CONFIG_HOME: directory,
      XDG_CACHE_HOME: directory
    }
  })
  page = await desktop.firstWindow()
  rendererErrors.length = 0
  page.on('pageerror', (e) => rendererErrors.push(String(e)))
  await expect(page.getByRole('heading', { name: 'Make every key yours.' })).toBeVisible()
})
test.afterEach(async () => {
  await desktop?.close()
  await rm(directory, { recursive: true, force: true })
  expect(rendererErrors).toEqual([])
})
test('edits a key, persists accent, executes background runtime and shows traces', async () => {
  await expect(page.getByRole('button', { name: /^Key \d/ })).toHaveCount(32)
  await page.getByRole('button', { name: 'Key 3: Copy greeting', exact: true }).click()
  await page.getByLabel('Key label').fill('Saved clipboard')
  await page.getByRole('button', { name: 'Save changes', exact: true }).click()
  await expect(page.getByText('All changes saved')).toBeVisible()
  await page.getByRole('button', { name: 'Test key', exact: true }).click()
  await expect
    .poll(() => desktop.evaluate(({ clipboard }) => clipboard.readText()))
    .toBe('Hello from Decker')
  await page.getByRole('button', { name: 'Settings navigation', exact: true }).click()
  await page.getByRole('button', { name: 'Accent #eb459e', exact: true }).click()
  await expect
    .poll(() =>
      page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue('--accent'))
    )
    .toBe('#eb459e')
  await page.getByRole('button', { name: 'Save changes', exact: true }).click()
  await page.reload()
  await expect(
    page.getByRole('button', { name: 'Key 3: Saved clipboard', exact: true })
  ).toBeVisible()
  await expect
    .poll(() =>
      page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue('--accent'))
    )
    .toBe('#eb459e')
  await page.getByRole('button', { name: 'Runs navigation', exact: true }).click()
  await expect(page.getByRole('heading', { name: 'Run history', exact: true })).toBeVisible()
  await expect(page.getByText('SUCCESS', { exact: true })).toBeVisible()
  await page.screenshot({ path: 'test-results/runs.png', fullPage: true })
})
test('visual workflow execution continues with the editor hidden and cancellation works', async () => {
  await page.getByRole('button', { name: 'Flows navigation', exact: true }).click()
  await expect(page.locator('.react-flow__node')).toHaveCount(4)
  const id = await page.evaluate(async () => {
    const state = await window.decker.state()
    const flow = state.config.workflows[0]
    flow.nodes[2].config.ms = 500
    await window.decker.save(state.config)
    return window.decker.run(flow.id)
  })
  await desktop.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].hide())
  await expect
    .poll(() =>
      page.evaluate(
        async (id) => (await window.decker.state()).runs.find((r) => r.id === id)?.status,
        id
      )
    )
    .toBe('success')
  await desktop.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].show())
  const second = await page.evaluate(async () => {
    const state = await window.decker.state()
    state.config.workflows[0].nodes[2].config.ms = 10000
    await window.decker.save(state.config)
    return window.decker.run(state.config.workflows[0].id)
  })
  await page.evaluate((id) => window.decker.cancel(id), second)
  await expect
    .poll(() =>
      page.evaluate(
        async (id) => (await window.decker.state()).runs.find((r) => r.id === id)?.status,
        second
      )
    )
    .toBe('cancelled')
  await page.screenshot({ path: 'test-results/flows.png', fullPage: true })
})
test('sandbox exposes only preload API and imports are disabled for command review', async () => {
  expect(
    await page.evaluate(() => ({
      node: typeof (window as unknown as { require?: unknown }).require,
      api: typeof window.decker.press
    }))
  ).toEqual({ node: 'undefined', api: 'function' })
  const result = await page.evaluate(async () => {
    const exported = await window.decker.export()
    const config = await window.decker.import(exported)
    return {
      enabled: config.profiles.flatMap((p) =>
        p.pages.flatMap((pg) => Object.values(pg.keys).map((b) => b.enabled))
      ),
      hasSecret: exported.includes('secrets.json')
    }
  })
  expect(result.enabled.every((b) => b === false)).toBe(true)
  expect(result.hasSecret).toBe(false)
  await page.getByRole('button', { name: 'Settings navigation', exact: true }).click()
  await expect(page.getByRole('heading', { name: 'Linux capabilities', exact: true })).toBeVisible()
  await page.screenshot({ path: 'test-results/settings.png', fullPage: true })
})
test('deck software down/up captures bindings and folders navigate', async () => {
  await page.getByRole('button', { name: 'Key 9: Tools', exact: true }).dblclick()
  await expect(page.getByRole('button', { name: 'Key 1: Back', exact: true })).toBeVisible()
  await page.getByRole('button', { name: 'Key 1: Back', exact: true }).dblclick()
  await expect(
    page.getByRole('button', { name: 'Key 1: Focus session', exact: true })
  ).toBeVisible()
  await page.screenshot({ path: 'test-results/deck.png', fullPage: true })
})
