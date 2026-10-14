import * as fs from "node:fs/promises";
import { constants, type Stats } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { ResourceLocks } from "../runtime/coordinator";
import {
  TEXT_READ_LIMIT,
  readTextFileSchema,
  mutateTextFileSchema,
} from "../shared/text-files";
import type { Json } from "../shared/schema";

const locks = new ResourceLocks(); // All handler instances in this process share destinations.
type FileIO = Pick<typeof fs, "mkdir" | "open" | "rename" | "unlink"> & {
  realpath(path: string): Promise<string>;
  lstat(path: string): Promise<Stats>;
};
function code(error: unknown) {
  return (error as NodeJS.ErrnoException)?.code;
}
function regular(stat: Stats) {
  if (!stat.isFile())
    throw new Error(
      "Invalid file target: use a regular file, not a symlink, directory or device",
    );
  if (stat.nlink !== 1)
    throw new Error(
      "Hard-linked file targets are unsupported; use a file with one link",
    );
}
function sameFile(a: Stats, b: Stats) {
  return a.dev === b.dev && a.ino === b.ino;
}

export class TextFileActions {
  constructor(private io: FileIO = fs) {}

  // Resolve parent aliases, including aliases above not-yet-created parents.
  // Effects use the canonical path, so retargeting an input parent symlink does
  // not move a queued operation to another destination. Final links are rejected.
  private async canonical(path: string, signal: AbortSignal): Promise<string> {
    const normalized = resolve(path),
      suffix: string[] = [basename(normalized)];
    let parent = dirname(normalized);
    while (true) {
      signal.throwIfAborted();
      try {
        return join(await this.io.realpath(parent), ...suffix);
      } catch (error) {
        if (code(error) !== "ENOENT" || parent === dirname(parent)) throw error;
        // A dangling parent link must not be mistaken for a missing directory.
        try {
          await this.io.lstat(parent);
          throw new Error("Invalid parent: dangling symlink");
        } catch (missing) {
          if (code(missing) !== "ENOENT") throw missing;
        }
        suffix.unshift(basename(parent));
        parent = dirname(parent);
      }
    }
  }

  private async target(path: string): Promise<Stats | undefined> {
    try {
      const stat = await this.io.lstat(path);
      regular(stat);
      return stat;
    } catch (error) {
      if (code(error) === "ENOENT") return undefined;
      throw error;
    }
  }

  async execute(
    type: "file.readText" | "file.writeText" | "file.appendText",
    config: Record<string, Json>,
    signal: AbortSignal,
  ): Promise<Json> {
    signal.throwIfAborted();
    const read = type === "file.readText";
    const mutation = read ? undefined : mutateTextFileSchema.parse(config);
    const c = mutation ?? readTextFileSchema.parse(config);
    try {
      const path = await this.canonical(c.path, signal);
      return await locks.run(path, signal, async () => {
        signal.throwIfAborted();
        if (mutation?.createParents) {
          await this.io.mkdir(dirname(path), { recursive: true, mode: 0o700 });
          signal.throwIfAborted();
        }
        const original = await this.target(path);
        if (!mutation) return this.read(path, original, signal);
        const content = Buffer.from(mutation.content, "utf8");
        return type === "file.writeText"
          ? this.write(path, content, original, signal)
          : this.append(path, content, original, signal);
      });
    } catch (error) {
      if (signal.aborted) throw signal.reason;
      switch (code(error)) {
        case "EACCES":
        case "EPERM":
          throw new Error("File access denied by host permissions");
        case "ENOENT":
          throw new Error(
            read
              ? "Text file or parent directory is missing"
              : "Parent directory is missing; enable Create parent directories or create it first",
          );
        case "ENOTDIR":
        case "ELOOP":
        case "ENXIO":
          throw new Error("Invalid file target or parent directory");
        default:
          throw error;
      }
    }
  }

  private async read(
    path: string,
    original: Stats | undefined,
    signal: AbortSignal,
  ): Promise<Json> {
    if (!original) throw new Error("Text file is missing");
    // NONBLOCK prevents a replacement FIFO from hanging open; NOFOLLOW rejects
    // final symlink races. fstat checks the opened object before any read/write.
    const handle = await this.io.open(
      path,
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
    );
    try {
      const stat = await handle.stat();
      regular(stat);
      if (!sameFile(original, stat))
        throw new Error("File target changed before read");
      if (stat.size > TEXT_READ_LIMIT)
        throw new Error(
          `Text file exceeds the ${TEXT_READ_LIMIT}-byte read limit; no partial text returned`,
        );
      const buffer = Buffer.alloc(TEXT_READ_LIMIT + 1);
      let count = 0;
      while (count < buffer.length) {
        signal.throwIfAborted();
        const { bytesRead } = await handle.read(
          buffer,
          count,
          Math.min(16_384, buffer.length - count),
          count,
        );
        if (!bytesRead) break;
        count += bytesRead;
      }
      signal.throwIfAborted();
      if (count > TEXT_READ_LIMIT)
        throw new Error(
          `Text file exceeds the ${TEXT_READ_LIMIT}-byte read limit; no partial text returned`,
        );
      let text: string;
      try {
        text = new TextDecoder("utf-8", {
          fatal: true,
          ignoreBOM: true,
        }).decode(buffer.subarray(0, count));
      } catch {
        throw new Error("Text file is not valid UTF-8");
      }
      return { text, bytes: count, truncated: false };
    } finally {
      await handle.close();
    }
  }

  private async write(
    path: string,
    content: Buffer,
    original: Stats | undefined,
    signal: AbortSignal,
  ): Promise<Json> {
    const temporary = join(dirname(path), `.decker-text-${randomUUID()}.tmp`);
    let handle: Awaited<ReturnType<typeof fs.open>> | undefined;
    let committed = false;
    let createdTemporary = false;
    try {
      signal.throwIfAborted();
      handle = await this.io.open(
        temporary,
        constants.O_WRONLY |
          constants.O_CREAT |
          constants.O_EXCL |
          constants.O_NOFOLLOW,
        0o600,
      );
      createdTemporary = true;
      await this.writeChunks(handle, content, signal);
      if (original) await handle.chmod(original.mode & 0o777);
      await handle.sync();
      await handle.close();
      handle = undefined;
      const current = await this.target(path);
      if (
        original
          ? !current ||
            !sameFile(original, current) ||
            original.mtimeMs !== current.mtimeMs ||
            original.size !== current.size
          : current
      )
        throw new Error(
          "File target changed before overwrite; destination preserved",
        );
      signal.throwIfAborted(); // Last cancellable point; rename commits an external effect.
      await this.io.rename(temporary, path);
      committed = true;
      return {
        bytesWritten: content.length,
        created: !original,
        operation: "overwrite",
      };
    } finally {
      try {
        await handle?.close();
      } finally {
        if (!committed && createdTemporary)
          await this.io.unlink(temporary).catch((error) => {
            if (code(error) !== "ENOENT") throw error;
          });
      }
    }
  }

  private async writeChunks(
    handle: Awaited<ReturnType<typeof fs.open>>,
    content: Buffer,
    signal: AbortSignal,
  ) {
    let written = 0;
    while (written < content.length) {
      signal.throwIfAborted();
      const result = await handle.write(
        content,
        written,
        Math.min(16_384, content.length - written),
      );
      if (!result.bytesWritten) throw new Error("File write made no progress");
      written += result.bytesWritten;
    }
    signal.throwIfAborted();
  }

  private async append(
    path: string,
    content: Buffer,
    original: Stats | undefined,
    signal: AbortSignal,
  ): Promise<Json> {
    signal.throwIfAborted();
    const handle = await this.io.open(
      path,
      constants.O_WRONLY |
        constants.O_APPEND |
        constants.O_NOFOLLOW |
        constants.O_NONBLOCK |
        (original ? 0 : constants.O_CREAT | constants.O_EXCL),
      0o600,
    );
    try {
      const stat = await handle.stat();
      regular(stat);
      if (original && !sameFile(original, stat))
        throw new Error("File target changed before append");
      await this.writeChunks(handle, content, signal);
      return {
        bytesWritten: content.length,
        created: !original,
        operation: "append",
      };
    } catch (error) {
      if (signal.aborted) throw signal.reason;
      throw new Error(
        `Append failed; the file may contain a partial append or have been created. Do not retry automatically. ${code(error) === "EACCES" || code(error) === "EPERM" ? "File access denied" : "Check the destination before retrying"}`,
      );
    } finally {
      await handle.close();
    }
  }
}

export const textFileActions = new TextFileActions();
