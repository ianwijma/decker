import { safeStorage } from "electron";
import { readFile, writeFile, rename, unlink } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import type { CredentialStatus } from "../shared/schema";

export type CredentialBackend = Pick<
  typeof safeStorage,
  | "isEncryptionAvailable"
  | "getSelectedStorageBackend"
  | "encryptString"
  | "decryptString"
>;
export const credentialFiles = { readFile, writeFile, rename, unlink };
export class Credentials {
  private values = new Map<string, string>();
  private encrypted = new Map<string, string>();
  private session = new Set<string>();
  private unreadable = false;
  private pending: Promise<unknown> = Promise.resolve();
  constructor(
    private directory: string,
    private backend: CredentialBackend = safeStorage,
    private files = credentialFiles,
  ) {}
  get secure() {
    try {
      return (
        this.backend.isEncryptionAvailable() &&
        this.backend.getSelectedStorageBackend() !== "basic_text"
      );
    } catch {
      return false;
    }
  }
  get writable() {
    return this.secure && !this.unreadable;
  }
  private serialize<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.pending.catch(() => {}).then(operation);
    this.pending = result;
    return result;
  }
  load() {
    return this.serialize(async () => {
      // Read ciphertext even with an unavailable keyring; never replace it on error.
      let raw: string;
      try {
        raw = await this.files.readFile(
          join(this.directory, "credentials.json"),
          "utf8",
        );
      } catch (error) {
        this.unreadable = (error as NodeJS.ErrnoException).code !== "ENOENT";
        return;
      }
      try {
        const parsed: unknown = JSON.parse(raw);
        if (
          !parsed ||
          typeof parsed !== "object" ||
          Array.isArray(parsed) ||
          Object.values(parsed).some((v) => typeof v !== "string")
        )
          throw new Error();
        this.encrypted = new Map(
          Object.entries(parsed as Record<string, string>),
        );
        this.unreadable = false;
      } catch {
        this.unreadable = true;
        return;
      }
      if (!this.secure) return;
      for (const [ref, value] of this.encrypted) {
        if (this.session.has(ref)) continue;
        try {
          this.values.set(
            ref,
            this.backend.decryptString(Buffer.from(value, "base64")),
          );
        } catch {
          /* This reference stays locked; its ciphertext is preserved. */
        }
      }
    });
  }
  status(ref?: string): CredentialStatus {
    if (!ref) return "missing";
    if (this.session.has(ref)) return "session-only";
    if (this.values.has(ref)) return "configured";
    if (this.unreadable || this.encrypted.has(ref)) return "locked";
    return "missing";
  }
  // Trusted main-to-runner boundary only. Never include this in UI snapshots.
  all() {
    return Object.fromEntries(this.values);
  }
  create(value: string, persist: boolean) {
    return this.serialize(async () => {
      const ref = `managed:${randomUUID()}`;
      if (persist) {
        if (!this.writable)
          throw new Error(
            "Secure storage is locked or unavailable. Unlock it and restart, or choose session-only storage.",
          );
        const next = new Map(this.encrypted);
        let temporary: string | undefined;
        try {
          next.set(ref, this.backend.encryptString(value).toString("base64"));
          const path = join(this.directory, "credentials.json");
          temporary = `${path}.${randomUUID()}.tmp`;
          await this.files.writeFile(
            temporary,
            JSON.stringify(Object.fromEntries(next)),
            { mode: 0o600, flag: "wx" },
          );
          await this.files.rename(temporary, path);
        } catch {
          if (temporary) await this.files.unlink(temporary).catch(() => {});
          throw new Error(
            "Could not save the encrypted secret. The previous secret and reference are unchanged.",
          );
        }
        this.encrypted = next;
      } else this.session.add(ref); // Session changes never touch the encrypted file.
      this.values.set(ref, value);
      return ref;
    });
  }
}
