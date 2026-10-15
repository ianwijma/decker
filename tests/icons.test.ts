import { describe, expect, it } from "vitest";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import sharp from "sharp";
import { Images } from "../src/device/images";
import { binding, defaults } from "../src/shared/defaults";
import { observedAppearance } from "../src/shared/feedback";
import { Persistence, validateImport } from "../src/main/persistence";
import { cloneProfiles } from "../src/shared/decks";
import {
  iconSvg,
  iconToken,
  lucideIcons,
  packKeySvg,
  resolveIcon,
  searchIcons,
  selectIcon,
} from "../src/shared/icons";

describe("curated Lucide v1", () => {
  it("searches human names and keywords, with stable unique string tokens", () => {
    expect(searchIcons(" PHOTO ").map((i) => i.name)).toContain("camera");
    expect(searchIcons("microphone mute").map((i) => i.name)).toEqual([
      "mic-off",
    ]);
    expect(searchIcons("no-such-icon")).toEqual([]);
    expect(searchIcons("")).toHaveLength(48);
    expect(new Set(lucideIcons.map(iconToken)).size).toBe(48);
    for (const icon of lucideIcons) {
      expect(resolveIcon(iconToken(icon))).toMatchObject({
        kind: "pack",
        available: true,
        icon,
      });
      expect(iconToken(icon).length).toBeLessThan(100);
      expect(icon.geometry).not.toMatch(
        /script|href|url\(|image|foreignObject|on\w+=/i,
      );
    }
    expect(iconSvg("pack:lucide:v1:camera")).toContain(
      '<circle cx="12" cy="13" r="3" />',
    );
  });
  it.each([
    "pack:lucide:v2:camera",
    "pack:other:v1:camera",
    "pack:lucide:v1:missing",
    "pack:lucide:v1:constructor",
    "pack:lucide:v1:camera:extra",
    "pack:lucide:v1:",
    "pack:<script>",
  ])(
    "uses trusted question-mark geometry for unavailable token %s",
    (token) => {
      expect(resolveIcon(token)).toMatchObject({
        kind: "pack",
        available: false,
        icon: { name: "circle-help" },
      });
      expect(packKeySvg(token, "Unknown")).toBe(
        packKeySvg("pack:lucide:v1:circle-help", "Unknown"),
      );
    },
  );
  it.each([
    "",
    "📷",
    "🚀 ✨",
    "TEXT",
    "<svg onload=alert(1)>",
    "https://example.com/image.svg",
    "/tmp/image.svg",
  ])(
    "preserves custom string %s without interpreting it as SVG or a resource",
    (text) => {
      expect(resolveIcon(text)).toEqual({ kind: "custom", text });
      expect(iconSvg(text)).toBeUndefined();
      expect(packKeySvg(text, "Label")).toBeUndefined();
    },
  );
  it("escapes document labels before inserting them in trusted geometry", () => {
    const svg = packKeySvg("pack:lucide:v1:camera", '<script>&"')!;
    expect(svg).toContain("&lt;script&gt;&amp;&quot;");
    expect(svg).not.toContain("<script>");
  });
});

it("preserves tokens, text, aliases and image bytes across save/reload, copy, export/import and icon selection", async () => {
  const directory = await mkdtemp(join(tmpdir(), "decker-icons-"));
  try {
    const persistence = new Persistence(directory);
    await persistence.load();
    const doc = defaults(),
      key = doc.profiles[0].pages[0].keys[0];
    const asset = await persistence.storeAsset(
      await sharp({
        create: { width: 96, height: 96, channels: 3, background: "#ff0000" },
      })
        .png()
        .toBuffer(),
    );
    key.appearance.asset = asset;
    selectIcon(key.appearance, "pack:lucide:v1:camera");
    expect(key.appearance.asset).toBeUndefined();
    expect(
      await readFile(join(persistence.assetDirectory, asset)),
    ).toBeTruthy();
    await persistence.save(doc, []);
    expect(
      (await persistence.load()).document.profiles[0].pages[0].keys[0]
        .appearance.icon,
    ).toBe("pack:lucide:v1:camera");
    const copy = cloneProfiles([doc.profiles[0]]).profiles[0];
    expect(copy.pages[0].keys[0].appearance.icon).toBe(key.appearance.icon);
    expect(copy.pages[0].keys[0].id).not.toBe(key.id);
    key.appearance.asset = asset; // Upload covers the stored icon until explicitly removed.
    const exported = await persistence.export(doc);
    const imported = validateImport(
      JSON.parse(JSON.stringify(exported.document)),
    );
    await persistence.importAssets(exported.assets);
    expect(imported.schemaVersion).toBe(defaults().schemaVersion);
    expect(imported.workflowAliases).toEqual(doc.workflowAliases);
    expect(imported.profiles[0].pages[0].keys[0].appearance).toEqual(
      key.appearance,
    );
    selectIcon(key.appearance, "🚀 TEXT");
    expect(key.appearance.asset).toBeUndefined();
    expect(key.appearance.icon).toBe("🚀 TEXT");
    selectIcon(key.appearance, "");
    expect(key.appearance.icon).toBe("");
    expect(await persistence.listAssets()).toContain(asset);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

it.each([72, 96])(
  "renders white pack geometry and label on the shared normalized canvas at %i px",
  async (size) => {
    const images = new Images(),
      appearance = {
        ...binding("desktop.copy").appearance,
        icon: "pack:lucide:v1:camera",
        label: "",
        background: "#123456",
      };
    const frame = await images.render(appearance, size);
    expect(frame.length).toBe(size * size * 3);
    expect(await images.render(appearance, size)).toBe(frame);
    const pixel = (buffer: Buffer, x: number, y: number) => [
      ...buffer.subarray((y * size + x) * 3, (y * size + x) * 3 + 3),
    ];
    expect(pixel(frame, 0, 0)).toEqual([18, 52, 86]);
    let white = 0;
    for (let y = 0; y < size; y++)
      for (let x = 0; x < size; x++) {
        if (pixel(frame, x, y).every((v) => v > 240)) {
          white++;
          expect(x).toBeGreaterThanOrEqual(size * 0.3);
          expect(x).toBeLessThan(size * 0.7);
          expect(y).toBeGreaterThanOrEqual(size * 0.16);
          expect(y).toBeLessThan(size * 0.56);
        }
      }
    expect(white).toBeGreaterThan(40);
    const labeled = await images.render(
      { ...appearance, label: "Camera" },
      size,
    );
    expect(labeled.subarray(0, Math.floor(size * 0.65) * size * 3)).toEqual(
      frame.subarray(0, Math.floor(size * 0.65) * size * 3),
    );
    expect(labeled.equals(frame)).toBe(false);
    const reference = await sharp(
      Buffer.from(
        `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}"><rect width="100%" height="100%" fill="#123456"/>${packKeySvg(appearance.icon, "Camera")}</svg>`,
      ),
    )
      .removeAlpha()
      .raw()
      .toBuffer();
    expect(labeled).toEqual(reference);
    const unavailable = await images.render(
      { ...appearance, icon: "pack:lucide:v99:camera" },
      size,
    );
    expect(unavailable).toEqual(
      await images.render(
        { ...appearance, icon: "pack:lucide:v1:circle-help" },
        size,
      ),
    );
    expect(
      (await images.render({ ...appearance, icon: "TEXT extra" }, size)).equals(
        await images.render({ ...appearance, icon: "TEXT" }, size),
      ),
    ).toBe(true);
    await expect(
      images.render({ ...appearance, icon: "📷" }, size),
    ).resolves.toHaveLength(size * size * 3);
  },
);

it("keeps uploaded-image precedence and observed feedback when an icon changes", async () => {
  const key = binding("audio.control");
  if (key.press?.kind !== "action") throw new Error();
  key.press.action.config.target = "@DEFAULT_AUDIO_SOURCE@";
  selectIcon(key.appearance, "pack:lucide:v1:mic");
  const appearance = observedAppearance(
    key,
    { microphone: { stdout: "Volume: 1.00 [MUTED]" } },
    "#abcdef",
  );
  expect(appearance).toMatchObject({
    icon: "pack:lucide:v1:mic",
    label: "Muted",
    background: "#abcdef",
  });
  const image = await sharp({
    create: { width: 96, height: 96, channels: 3, background: "#ff0000" },
  })
    .png()
    .toBuffer();
  const images = new Images();
  expect(await images.render(appearance, 96, image)).toEqual(
    await images.render(
      { ...appearance, icon: "pack:lucide:v1:camera" },
      96,
      image,
    ),
  );
  selectIcon(key.appearance, "pack:lucide:v1:mic-off");
  expect(
    observedAppearance(
      key,
      { microphone: { stdout: "Volume: 1.00 [MUTED]" } },
      "#abcdef",
    ),
  ).toMatchObject({
    icon: "pack:lucide:v1:mic-off",
    label: "Muted",
    background: "#abcdef",
  });
});
