import { mkdir, readFile, writeFile, rename, copyFile } from 'node:fs/promises'
import { join } from 'node:path'
import { configSchema, defaultConfig, type Config, type RunRecord } from '../shared/schema'
export class Storage {
  private queue = Promise.resolve()
  constructor(readonly directory: string) {}
  private async read(name: string): Promise<unknown> {
    try {
      return JSON.parse(await readFile(join(this.directory, name), 'utf8'))
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'ENOENT') return undefined
      throw e
    }
  }
  async load(): Promise<{ config: Config; runs: RunRecord[] }> {
    await mkdir(this.directory, { recursive: true })
    let document: unknown
    try {
      document = await this.read('config.json')
    } catch (error) {
      if (error instanceof SyntaxError) {
        await copyFile(
          join(this.directory, 'config.json'),
          join(this.directory, `config-invalid-${Date.now()}.json`)
        )
        throw new Error('Configuration JSON is invalid. A backup was saved before recovery.')
      }
      throw error
    }
    let config = defaultConfig()
    if (document) {
      const parsed = configSchema.safeParse(document)
      if (!parsed.success) {
        await copyFile(
          join(this.directory, 'config.json'),
          join(this.directory, `config-invalid-${Date.now()}.json`)
        )
        throw new Error(
          'Configuration is invalid. A backup was saved; repair or import a valid document.'
        )
      }
      config = parsed.data
    }
    let history: unknown
    try {
      history = await this.read('runs.json')
    } catch (error) {
      if (!(error instanceof SyntaxError)) throw error
      await copyFile(
        join(this.directory, 'runs.json'),
        join(this.directory, `runs-invalid-${Date.now()}.json`)
      )
      // A broken history file must never discard the valid deck configuration.
      history = []
    }
    const runs = Array.isArray(history)
      ? history
          .filter((r) => r && typeof r.id === 'string' && Array.isArray(r.nodes))
          .slice(0, config.settings.historyLimit)
          .map((r: RunRecord) =>
            r.status === 'running'
              ? {
                  ...r,
                  status: 'interrupted' as const,
                  endedAt: Date.now(),
                  error: 'Application or runner stopped before completion'
                }
              : r
          )
      : []
    return { config, runs }
  }
  async save(config: Config, runs: RunRecord[]): Promise<void> {
    const snapshot = configSchema.parse(config),
      history = structuredClone(runs.slice(0, snapshot.settings.historyLimit))
    const operation = this.queue.then(async () => {
      await mkdir(this.directory, { recursive: true })
      try {
        await copyFile(
          join(this.directory, 'config.json'),
          join(this.directory, 'config.backup.json')
        )
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e
      }
      for (const [name, data] of [
        ['config.json', snapshot],
        ['runs.json', history]
      ] as const) {
        await writeFile(join(this.directory, `${name}.tmp`), JSON.stringify(data, null, 2), {
          mode: 0o600
        })
        await rename(join(this.directory, `${name}.tmp`), join(this.directory, name))
      }
    })
    this.queue = operation.catch(() => {})
    return operation
  }
}
