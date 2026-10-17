import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";
import { createMediaAdapter } from "../src/adapters/linux/media";
import { mediaActions } from "../src/shared/media";

const appRequire = createRequire(import.meta.url);
const { scenarios, createFixture, player, secondPlayer } = appRequire(
  "./fixtures/dbus-xml.cjs",
);

describe("actual dbus-next XML parser and proxy construction", () => {
  for (const [name, verify] of Object.entries(scenarios)) {
    it(name, async () => {
      await (verify as (require: NodeJS.Require) => Promise<void>)(appRequire);
    });
  }

  it.each(mediaActions)(
    "dispatches $operation through XML-generated proxies and decodes Variants",
    async ({ operation }) => {
      const fixtures: ReturnType<typeof createFixture>[] = [];
      const adapter = createMediaAdapter(() => {
        const f = createFixture(appRequire);
        fixtures.push(f);
        return f.bus;
      });
      expect(await adapter.players()).toEqual([player, secondPlayer]);
      for (const selected of ["", secondPlayer]) {
        expect(
          await adapter.media(
            operation,
            selected,
            new AbortController().signal,
          ),
        ).toEqual({ player: selected || player, status: "Paused" });
      }
      expect(await adapter.observedMedia()).toEqual({
        defaultPlayer: player,
        [player]: "Paused",
        [secondPlayer]: "Paused",
      });
      expect(fixtures.every((f) => f.disconnected === 1)).toBe(true);
      expect(fixtures.flatMap((f) => f.errors)).toEqual([]);
    },
  );

  it("propagates capability errors from a generated media proxy", async () => {
    const fixtures: ReturnType<typeof createFixture>[] = [];
    const adapter = createMediaAdapter(() => {
      const f = createFixture(appRequire, { refuse: "Next" });
      fixtures.push(f);
      return f.bus;
    });
    await expect(
      adapter.media("Next", "", new AbortController().signal),
    ).rejects.toThrow(/Next failed.*capability unavailable/);
    expect(fixtures.every((f) => f.disconnected === 1)).toBe(true);
  });
});
