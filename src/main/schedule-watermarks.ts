import { readFile, open, rename } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
const schema = z
  .object({
    version: z.literal(1),
    entries: z
      .array(
        z
          .object({ id: z.uuid(), at: z.number().finite().nonnegative() })
          .strict(),
      )
      .max(200)
      .refine(
        (entries) => new Set(entries.map((e) => e.id)).size === entries.length,
        "Duplicate watermark IDs",
      ),
  })
  .strict();
/** Local occurrence high-water marks, never exported or authored by the renderer. */
export class ScheduleWatermarks {
  private entries = new Map<string, number>();
  private pending = Promise.resolve();
  private blocked = false;
  constructor(private directory: string) {}
  get(id: string) {
    return this.entries.get(id) ?? 0;
  }
  async load() {
    try {
      const raw = await readFile(
        join(this.directory, "schedule-watermarks.json"),
        "utf8",
      );
      if (raw.length > 50000) throw new Error("Oversized schedule watermarks");
      this.entries = new Map(
        schema.parse(JSON.parse(raw)).entries.map((e) => [e.id, e.at]),
      );
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT")
        this.blocked = true;
    }
  }
  claim(id: string, at: number, liveIds: string[]) {
    const operation = this.pending
      .catch(() => {})
      .then(async () => {
        if (this.blocked)
          throw new Error(
            "Schedule occurrence storage requires repair and restart",
          );
        const next = new Map(
          [...this.entries].filter(([key]) => liveIds.includes(key)),
        );
        next.set(id, Math.max(at, this.get(id)));
        const path = join(this.directory, "schedule-watermarks.json"),
          temporary = `${path}.tmp`;
        try {
          const file = await open(temporary, "w", 0o600);
          try {
            await file.writeFile(
              JSON.stringify(
                schema.parse({
                  version: 1,
                  entries: [...next].map(([id, at]) => ({ id, at })),
                }),
              ),
            );
            await file.sync();
          } finally {
            await file.close();
          }
          await rename(temporary, path);
          const directory = await open(this.directory, "r");
          try {
            await directory.sync();
          } finally {
            await directory.close();
          }
          this.entries = next;
        } catch (error) {
          this.blocked = true;
          throw error;
        }
      });
    this.pending = operation;
    return operation;
  }
}
