import { safeStorage } from "electron";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
export class Credentials {
  private values: Record<string, string> = {};
  private encrypted: Record<string, string> = {};
  constructor(private directory: string) {}
  get secure() {
    return (
      safeStorage.isEncryptionAvailable() &&
      safeStorage.getSelectedStorageBackend() !== "basic_text"
    );
  }
  async load() {
    if (!this.secure) return;
    try {
      this.encrypted = JSON.parse(
        await readFile(join(this.directory, "credentials.json"), "utf8"),
      );
      for (const [key, value] of Object.entries(this.encrypted))
        this.values[key] = safeStorage.decryptString(
          Buffer.from(value, "base64"),
        );
    } catch {
      this.encrypted = {};
    }
  }
  all() {
    return { ...this.values };
  }
  async set(ref: string, value: string, persist: boolean) {
    if (persist && !this.secure)
      throw new Error(
        "Secure storage is unavailable. Use session-only credentials.",
      );
    this.values[ref] = value;
    if (persist)
      this.encrypted[ref] = safeStorage.encryptString(value).toString("base64");
    else delete this.encrypted[ref];
    await writeFile(
      join(this.directory, "credentials.json"),
      JSON.stringify(this.encrypted),
      { mode: 0o600 },
    );
  }
}
