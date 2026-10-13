import { safeStorage } from 'electron'
import { readFile, writeFile, rename } from 'node:fs/promises'
import { join } from 'node:path'
export class Secrets {
  private session = new Map<string, string>()
  private encrypted: Record<string, string> = {}
  constructor(private directory: string) {}
  get secure(): boolean {
    return (
      safeStorage.isEncryptionAvailable() &&
      safeStorage.getSelectedStorageBackend() !== 'basic_text'
    )
  }
  async load(): Promise<void> {
    try {
      this.encrypted = JSON.parse(await readFile(join(this.directory, 'secrets.json'), 'utf8'))
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e
    }
  }
  async set(id: string, value: string, persist: boolean): Promise<void> {
    if (persist && !this.secure)
      throw new Error('OS secret storage is unavailable. Choose session-only storage.')
    this.session.set(id, value)
    delete this.encrypted[id]
    if (persist) {
      if (!this.secure)
        throw new Error('OS secret storage is unavailable. Choose session-only storage.')
      this.encrypted[id] = safeStorage.encryptString(value).toString('base64')
    }
    const path = join(this.directory, 'secrets.json')
    await writeFile(path + '.tmp', JSON.stringify(this.encrypted), { mode: 0o600 })
    await rename(path + '.tmp', path)
  }
  get(id: string): string {
    const session = this.session.get(id)
    if (session !== undefined) return session
    if (!this.secure || !this.encrypted[id])
      throw new Error('Credential is missing; add it in Settings')
    return safeStorage.decryptString(Buffer.from(this.encrypted[id], 'base64'))
  }
}
