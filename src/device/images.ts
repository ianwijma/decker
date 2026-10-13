import sharp from 'sharp'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { Binding } from '../shared/schema'
const escape = (text: string) =>
  text.replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' })[c]!
  )
const cache = new Map<string, Buffer>()
export async function keyImage(
  binding: Binding | undefined,
  size: number,
  accent: string,
  status: string,
  assets: string
): Promise<Buffer> {
  const key = JSON.stringify([binding?.appearance, size, accent, status])
  const existing = cache.get(key)
  if (existing) return existing
  const a = binding?.appearance,
    background =
      status === 'running'
        ? accent
        : status === 'success'
          ? '#23865e'
          : status === 'error'
            ? '#da373c'
            : (a?.background ?? '#18191c')
  const svg = `<svg width="${size}" height="${size}" xmlns="http://www.w3.org/2000/svg"><rect width="100%" height="100%" rx="10" fill="${background}"/><text x="50%" y="42%" text-anchor="middle" dominant-baseline="middle" font-family="sans-serif" font-size="${size * 0.3}" fill="white">${escape(a?.icon ?? '')}</text><text x="50%" y="78%" text-anchor="middle" font-family="sans-serif" font-size="${size * 0.12}" fill="white">${escape((a?.label ?? '').slice(0, 16))}</text></svg>`
  let renderer = sharp(Buffer.from(svg))
  if (a?.asset) {
    try {
      const image = await sharp(await readFile(join(assets, `${a.asset}.png`)))
        .resize(size, size)
        .png()
        .toBuffer()
      renderer = sharp(image).composite([
        {
          input: Buffer.from(
            svg.replace(`<rect width="100%" height="100%" rx="10" fill="${background}"/>`, '')
          )
        }
      ])
    } catch {}
  }
  const buffer = await renderer.removeAlpha().raw().toBuffer()
  cache.set(key, buffer)
  if (cache.size > 512) cache.delete(cache.keys().next().value!)
  return buffer
}
export class ImageQueue {
  private pending = new Map<number, () => Promise<void>>()
  private flushing = false
  constructor(private failure: (error: unknown) => void) {}
  enqueue(index: number, write: () => Promise<void>): void {
    this.pending.set(index, write)
    void this.flush()
  }
  clear(): void {
    this.pending.clear()
  }
  get size(): number {
    return this.pending.size
  }
  private async flush(): Promise<void> {
    if (this.flushing) return
    this.flushing = true
    try {
      while (this.pending.size) {
        const [key, write] = this.pending.entries().next().value!
        this.pending.delete(key)
        try {
          await write()
        } catch (e) {
          this.pending.clear()
          this.failure(e)
          break
        }
      }
    } finally {
      this.flushing = false
    }
  }
}
