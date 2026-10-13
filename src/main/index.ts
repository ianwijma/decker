import {
  app,
  BrowserWindow,
  ipcMain,
  utilityProcess,
  Tray,
  Menu,
  nativeImage,
  shell,
  clipboard,
  Notification,
  powerMonitor,
  protocol,
  type UtilityProcess
} from 'electron'
import { join } from 'node:path'
import { mkdir, writeFile, unlink, readFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import sharp from 'sharp'
import { z } from 'zod'
import {
  configSchema,
  defaultConfig,
  type State,
  type Config,
  type Json,
  type Binding
} from '../shared/schema'
import { json } from '../shared/schema'
import { exportConfig } from '../shared/export'
import { validateWorkflow } from '../runtime/validate'
import { validateAction } from '../shared/catalog'
import { redact } from '../runtime/data'
import { Storage } from './storage'
import { Secrets } from './secrets'
import { Triggers } from '../device/triggers'
let window: BrowserWindow | undefined,
  tray: Tray | undefined,
  quitting = false,
  runner: UtilityProcess | undefined,
  device: UtilityProcess | undefined
let state: State = {
  config: defaultConfig(),
  runs: [],
  devices: [],
  capabilities: [],
  observed: {},
  secretStorage: 'session only'
}
let storage: Storage, secrets: Secrets, assets: string
protocol.registerSchemesAsPrivileged([
  { scheme: 'decker-asset', privileges: { standard: true, secure: true, supportFetchAPI: true } }
])
let generation = 0
if (process.env.DECKER_DATA_DIR) app.setPath('userData', process.env.DECKER_DATA_DIR)
const runGeneration = new Map<string, number>()
const latestBindingRun = new Map<string, string>()
const requests = new Map<
  string,
  {
    resolve: (id: string) => void
    reject: (e: Error) => void
    timer: ReturnType<typeof setTimeout>
  }
>()
const triggers = new Triggers((binding, event, generation) =>
  runner?.postMessage({ type: 'binding', binding, event, generation })
)
const publish = () => {
  window?.webContents.send('state:update', state)
}
let persistTimer: ReturnType<typeof setTimeout> | undefined
const persist = () => {
  clearTimeout(persistTimer)
  persistTimer = setTimeout(() => {
    void storage.save(state.config, state.runs).catch((e) => {
      state.observed.storage = { error: String(e) }
      publish()
    })
  }, 200)
}
function sendConfig(): void {
  runner?.postMessage({ type: 'config', config: state.config })
  device?.postMessage({ type: 'config', config: state.config, assets })
}
function binding(index: number): Binding | undefined {
  return state.config.profiles
    .find((p) => p.id === state.config.activeProfile)
    ?.pages.find((p) => p.id === state.config.activePage)?.keys[String(index)]
}
function press(id: string, index: number, event: string): void {
  const b = binding(index)
  if (event === 'up') {
    triggers.up(id, index)
    return
  }
  if (!b) return
  if (event === 'test') {
    if (b.enabled)
      runner?.postMessage({
        type: 'binding',
        binding: structuredClone(b),
        event: 'press',
        generation
      })
  } else triggers.down(id, index, b, generation)
}
async function bridge(action: string, data: Record<string, Json>): Promise<Json> {
  const c = state.config
  switch (action) {
    case 'credential':
      return secrets.get(String(data.ref))
    case 'clipboard':
      clipboard.writeText(String(data.text))
      return null
    case 'notification':
      new Notification({ title: String(data.title), body: String(data.body) }).show()
      return null
    case 'open': {
      const target = String(data.target)
      if (/^https?:\/\//.test(target)) await shell.openExternal(target)
      else if (target.startsWith('/')) {
        const error = await shell.openPath(target)
        if (error) throw new Error(error)
      } else throw new Error('Use an HTTP(S) URL or absolute local path')
      return null
    }
    case 'cancel':
      runner?.postMessage({ type: 'cancelWorkflow', id: String(data.workflowId) })
      return null
    case 'profile': {
      const profile = c.profiles.find((p) => p.id === data.profileId)
      if (!profile) throw new Error('Profile not found')
      c.activeProfile = profile.id
      c.activePage = profile.pages[0].id
      break
    }
    case 'page': {
      const profile = c.profiles.find((p) => p.id === c.activeProfile)!
      if (!profile.pages.some((p) => p.id === data.pageId)) throw new Error('Page not found')
      c.activePage = String(data.pageId)
      break
    }
    case 'back': {
      const page = c.profiles
        .find((p) => p.id === c.activeProfile)
        ?.pages.find((p) => p.id === c.activePage)
      if (page?.parentId) c.activePage = page.parentId
      break
    }
    case 'brightness':
      c.settings.brightness = Number(data.value)
      break
    case 'appearance': {
      if (runGeneration.get(String(data.runId)) !== generation) return null
      const b = binding(Number(data.index))
      if (!b) throw new Error('Key is empty')
      for (const key of ['label', 'icon', 'background'] as const)
        if (data[key] !== undefined) b.appearance[key] = String(data[key])
      break
    }
    default:
      throw new Error(`Unknown bridge action: ${action}`)
  }
  state.config = configSchema.parse(c)
  if (action !== 'appearance') generation++
  sendConfig()
  persist()
  publish()
  return null
}
function spawnRunner(): void {
  runner = utilityProcess.fork(join(import.meta.dirname, 'runner.js'), [], {
    serviceName: 'Decker workflows'
  })
  runner.on('message', async (m) => {
    if (!m || typeof m.type !== 'string') return
    if (m.type === 'bridge') {
      try {
        runner?.postMessage({ type: 'reply', id: m.id, value: await bridge(m.action, m.data) })
      } catch (e) {
        runner?.postMessage({ type: 'reply', id: m.id, error: String(e) })
      }
    }
    if (m.type === 'runUpdate') {
      const record = m.record as State['runs'][number]
      if (record.status === 'running' && !runGeneration.has(record.id)) {
        runGeneration.set(record.id, record.bindingGeneration ?? generation)
        if (record.bindingId) latestBindingRun.set(record.bindingId, record.id)
      }
      state.runs = [record, ...state.runs.filter((r) => r.id !== record.id)].slice(
        0,
        state.config.settings.historyLimit
      )
      if (
        record.bindingId &&
        runGeneration.get(record.id) === generation &&
        latestBindingRun.get(record.bindingId) === record.id
      ) {
        const p = state.config.profiles
          .find((p) => p.id === state.config.activeProfile)
          ?.pages.find((p) => p.id === state.config.activePage)
        const key = Object.entries(p?.keys ?? {}).find(([, b]) => b.id === record.bindingId)
        if (key)
          device?.postMessage({ type: 'feedback', index: Number(key[0]), status: record.status })
      }
      if (record.status !== 'running') runGeneration.delete(record.id)
      persist()
      publish()
    }
    if (m.type === 'capabilities') {
      state.capabilities = m.value
      publish()
    }
    if (m.type === 'observed') {
      state.observed[m.id] = redact(m.value)
      device?.postMessage({ type: 'observed', value: state.observed })
      publish()
    }
    if (m.type === 'started' || m.type === 'error') {
      const r = requests.get(m.requestId)
      if (r) {
        clearTimeout(r.timer)
        requests.delete(m.requestId)
        if (m.type === 'error') r.reject(new Error(m.error))
        else r.resolve(m.id)
      } else if (m.type === 'error') {
        state.observed.runner = { error: String(m.error) }
        publish()
      }
    }
  })
  runner.on('exit', () => {
    runner = undefined
    for (const r of state.runs)
      if (r.status === 'running') {
        r.status = 'interrupted'
        r.endedAt = Date.now()
        r.error = 'Workflow process exited'
      }
    for (const r of requests.values()) {
      clearTimeout(r.timer)
      r.reject(new Error('Runner exited'))
    }
    requests.clear()
    persist()
    publish()
    if (!quitting)
      setTimeout(() => {
        spawnRunner()
        sendConfig()
      }, 1000)
  })
}
function spawnDevice(): void {
  device = utilityProcess.fork(join(import.meta.dirname, 'device.js'), [], {
    serviceName: 'Decker devices'
  })
  device.on('message', (m) => {
    if (m?.type === 'devices') {
      for (const old of state.devices)
        if (!m.value.some((d: State['devices'][number]) => d.id === old.id && d.connected))
          triggers.disconnect(old.id)
      state.devices = m.value
      publish()
    }
    if (m?.type === 'key') press(m.deviceId, m.index, m.event)
    if (m?.type === 'disconnected') triggers.disconnect(m.deviceId)
  })
  device.on('exit', () => {
    device = undefined
    triggers.disconnect()
    state.devices = []
    publish()
    if (!quitting)
      setTimeout(() => {
        spawnDevice()
        sendConfig()
      }, 1000)
  })
}
async function save(config: Config): Promise<void> {
  const next = configSchema.parse(config)
  for (const flow of next.workflows) {
    const errors = validateWorkflow(flow, next.workflows)
    if (errors.length) throw new Error(`${flow.name}: ${errors.join('; ')}`)
  }
  for (const profile of next.profiles)
    for (const page of profile.pages)
      for (const b of Object.values(page.keys))
        for (const a of [...b.actions, ...b.release, ...b.longPress])
          if (!JSON.stringify(a.config).includes('{{')) validateAction(a)
  await storage.save(next, state.runs)
  state.config = next
  generation++
  latestBindingRun.clear()
  sendConfig()
  publish()
  const autostart = join(app.getPath('appData'), 'autostart')
  await mkdir(autostart, { recursive: true })
  const file = join(autostart, 'decker.desktop')
  if (next.settings.launchAtLogin)
    await writeFile(
      file,
      `[Desktop Entry]\nType=Application\nName=Decker\nExec="${process.env.APPIMAGE ?? process.execPath}" --hidden\nX-GNOME-Autostart-enabled=true\n`
    )
  else
    await unlink(file).catch((e) => {
      if (e.code !== 'ENOENT') throw e
    })
}
function registerIPC(): void {
  const handle = (channel: string, fn: (...args: any[]) => unknown) =>
    ipcMain.handle(channel, (event, ...args) => {
      if (
        event.sender !== window?.webContents ||
        event.senderFrame !== window.webContents.mainFrame
      )
        throw new Error('Untrusted IPC sender')
      return fn(...args)
    })
  handle('state', () => state)
  handle('save', save)
  handle('press', (index, event) =>
    press(
      'simulator',
      z.number().int().min(0).max(127).parse(index),
      z.enum(['test', 'down', 'up']).parse(event)
    )
  )
  handle(
    'run',
    (id, input) =>
      new Promise<string>((resolve, reject) => {
        const requestId = crypto.randomUUID()
        const timer = setTimeout(() => {
          requests.delete(requestId)
          reject(new Error('Runner is unavailable'))
        }, 10000)
        requests.set(requestId, { resolve, reject, timer })
        runner?.postMessage({
          type: 'run',
          requestId,
          workflowId: z.string().parse(id),
          input: z.record(z.string(), json).parse(input)
        })
      })
  )
  handle('cancel', (id) => runner?.postMessage({ type: 'cancel', id: z.string().parse(id) }))
  handle('credential', async (id, value, persist) => {
    await secrets.set(
      z.string().min(1).max(128).parse(id),
      z.string().max(65536).parse(value),
      z.boolean().parse(persist)
    )
    sendConfig()
  })
  handle('export', async () => {
    const hashes = [
      ...new Set(
        state.config.profiles.flatMap((p) =>
          p.pages.flatMap((pg) =>
            Object.values(pg.keys).flatMap((b) => (b.appearance.asset ? [b.appearance.asset] : []))
          )
        )
      )
    ]
    const bundledAssets: Record<string, string> = {}
    for (const hash of hashes)
      bundledAssets[hash] = (await readFile(join(assets, hash + '.png'))).toString('base64')
    return JSON.stringify(
      {
        ...exportConfig(state.config),
        bundledAssets
      },
      null,
      2
    )
  })
  handle('import', async (text) => {
    const raw = JSON.parse(
      z
        .string()
        .max(16 * 1024 * 1024)
        .parse(text)
    )
    const config = configSchema.parse(raw)
    const bundled = z
      .record(z.string().regex(/^[a-f0-9]{64}$/), z.string().max(512 * 1024))
      .parse(raw.bundledAssets ?? {})
    const images: Array<[string, Buffer]> = []
    for (const [hash, data] of Object.entries(bundled)) {
      const buffer = Buffer.from(data, 'base64')
      if (createHash('sha256').update(buffer).digest('hex') !== hash)
        throw new Error('Asset content hash mismatch')
      const metadata = await sharp(buffer, { limitInputPixels: 65536 }).metadata()
      if (metadata.format !== 'png' || metadata.width !== 256 || metadata.height !== 256)
        throw new Error('Imported assets must be 256×256 PNG images')
      images.push([hash, buffer])
    }
    await mkdir(assets, { recursive: true })
    for (const [hash, buffer] of images) await writeFile(join(assets, hash + '.png'), buffer)
    for (const p of config.profiles)
      for (const page of p.pages) for (const b of Object.values(page.keys)) b.enabled = false
    return config
  })
  handle('image', async (data) => {
    const buffer = Buffer.from(
      z
        .string()
        .max(6 * 1024 * 1024)
        .parse(data),
      'base64'
    )
    const image = await sharp(buffer, { limitInputPixels: 16000000 })
      .resize(256, 256, { fit: 'cover' })
      .png()
      .toBuffer()
    const hash = createHash('sha256').update(image).digest('hex')
    await mkdir(assets, { recursive: true })
    await writeFile(join(assets, hash + '.png'), image)
    return hash
  })
  handle('quit', () => app.quit())
}
async function createWindow(): Promise<void> {
  window = new BrowserWindow({
    width: 1440,
    height: 960,
    minWidth: 1000,
    minHeight: 700,
    backgroundColor: '#313338',
    title: 'Decker',
    show: false,
    webPreferences: {
      preload: join(import.meta.dirname, '../preload/index.cjs'),
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false
    }
  })
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  window.webContents.on('will-navigate', (event) => event.preventDefault())
  window.on('close', (e) => {
    if (!quitting) {
      e.preventDefault()
      window?.hide()
    }
  })
  if (process.env.ELECTRON_RENDERER_URL) await window.loadURL(process.env.ELECTRON_RENDERER_URL)
  else await window.loadFile(join(import.meta.dirname, '../renderer/index.html'))
  if (!state.config.settings.startHidden && !process.argv.includes('--hidden')) window.show()
}
if (!app.requestSingleInstanceLock()) app.quit()
else {
  app.on('second-instance', () => {
    window?.show()
    window?.focus()
  })
  app.whenReady().then(async () => {
    storage = new Storage(app.getPath('userData'))
    assets = join(storage.directory, 'assets')
    secrets = new Secrets(storage.directory)
    protocol.handle('decker-asset', async (request) => {
      const hash = new URL(request.url).hostname
      if (!/^[a-f0-9]{64}$/.test(hash)) return new Response('Invalid asset', { status: 400 })
      try {
        return new Response(await readFile(join(assets, hash + '.png')), {
          headers: { 'Content-Type': 'image/png' }
        })
      } catch {
        return new Response('Asset missing', { status: 404 })
      }
    })
    try {
      const loaded = await storage.load()
      state.config = loaded.config
      state.runs = loaded.runs
      await secrets.load()
    } catch (e) {
      state.observed.storage = { error: String(e) }
    }
    state.secretStorage = secrets.secure
      ? 'OS encrypted'
      : 'Session only (OS encryption unavailable)'
    registerIPC()
    spawnRunner()
    spawnDevice()
    sendConfig()
    await createWindow()
    const icon = await sharp({
      create: { width: 24, height: 24, channels: 4, background: '#5865f2' }
    })
      .png()
      .toBuffer()
    tray = new Tray(nativeImage.createFromBuffer(icon))
    tray.setToolTip('Decker')
    tray.setContextMenu(
      Menu.buildFromTemplate([
        { label: 'Open Decker', click: () => window?.show() },
        { label: 'Quit', click: () => app.quit() }
      ])
    )
    tray.on('click', () => window?.show())
    powerMonitor.on('suspend', () => triggers.disconnect())
    powerMonitor.on('resume', () => sendConfig())
  })
  let stopped = false
  app.on('before-quit', (event) => {
    if (stopped) return
    event.preventDefault()
    if (quitting) return
    quitting = true
    triggers.disconnect()
    runner?.postMessage({ type: 'stop' })
    device?.postMessage({ type: 'stop' })
    clearTimeout(persistTimer)
    const waitFor = (worker: UtilityProcess | undefined) =>
      new Promise<void>((resolve) => {
        if (!worker) {
          resolve()
          return
        }
        const timer = setTimeout(() => {
          worker.kill()
          resolve()
        }, 2500)
        worker.once('exit', () => {
          clearTimeout(timer)
          resolve()
        })
      })
    void Promise.all([waitFor(runner), waitFor(device)])
      .then(async () => {
        clearTimeout(persistTimer)
        if (storage) await storage.save(state.config, state.runs)
      })
      .finally(() => {
        stopped = true
        app.quit()
      })
  })
  app.on('window-all-closed', () => {})
}
