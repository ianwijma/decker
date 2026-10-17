import sharp from "sharp";
import { createHash } from "node:crypto";
import type { ButtonAppearance } from "../shared/feedback";
import { escapeSvg as escape, packKeySvg } from "../shared/icons";
export class Images {
  private cache = new Map<string, Buffer>();
  async render(
    appearance: ButtonAppearance,
    size: number,
    asset?: Buffer,
  ): Promise<Buffer> {
    const key = createHash("sha256")
      .update(JSON.stringify([appearance, size]))
      .update(asset ?? Buffer.alloc(0))
      .digest("hex");
    const cached = this.cache.get(key);
    if (cached) return cached;
    const label = escape(appearance.label.slice(0, 24)),
      icon = escape(appearance.icon.slice(0, 4)),
      pack = packKeySvg(appearance.icon, appearance.label);
    const imageStatus =
      appearance.imageStatus === "stale"
        ? `<text x="50%" y="28%" text-anchor="middle" font-family="sans-serif" font-size="${size * 0.08}" fill="white">Image stale</text>`
        : "";
    const state =
      (appearance.stateLabel
        ? `<rect width="100%" height="18%" fill="#000000" opacity=".8"/><text x="50%" y="13%" text-anchor="middle" font-family="sans-serif" font-size="${size * 0.08}" fill="white">${escape(appearance.stateLabel)}</text>`
        : "") + imageStatus;
    const svg = Buffer.from(
      `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}"><rect width="100%" height="100%" fill="${appearance.background}"/>${state}${pack ?? `<text x="50%" y="43%" text-anchor="middle" font-family="sans-serif" font-size="${size * 0.3}" fill="white">${icon}</text><text x="50%" y="80%" text-anchor="middle" font-family="sans-serif" font-size="${size * 0.12}" fill="white">${label}</text>`}</svg>`,
    );
    const base = asset
      ? sharp(asset)
          .resize(size, size)
          .composite([
            {
              input: Buffer.from(
                `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}">${state}<rect y="${size * 0.7}" width="100%" height="30%" fill="#000000" opacity=".65"/><text x="50%" y="88%" text-anchor="middle" font-family="sans-serif" font-size="${size * 0.12}" fill="white">${label}</text></svg>`,
              ),
            },
          ])
      : sharp(svg);
    const buffer = await base
      .flatten({ background: appearance.background })
      .removeAlpha()
      .raw()
      .toBuffer();
    this.cache.set(key, buffer);
    if (this.cache.size > 256)
      this.cache.delete(this.cache.keys().next().value!);
    return buffer;
  }
}
export class WriteQueue {
  private pending = new Map<number, () => Promise<void>>();
  private busy = false;
  private closed = false;
  constructor(private error: (error: unknown) => void) {}
  set(key: number, write: () => Promise<void>) {
    if (this.closed) return;
    this.pending.set(key, write);
    void this.flush();
  }
  clear() {
    this.pending.clear();
  }
  close() {
    this.closed = true;
    this.clear();
  }
  get size() {
    return this.pending.size;
  }
  private async flush() {
    if (this.busy) return;
    this.busy = true;
    try {
      while (this.pending.size && !this.closed) {
        const [key, write] = this.pending.entries().next().value!;
        this.pending.delete(key);
        try {
          await write();
        } catch (error) {
          this.error(error);
          this.close();
        }
      }
    } finally {
      this.busy = false;
    }
  }
}
