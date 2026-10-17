import sharp from "sharp";
import {
  fetchImageSchema,
  imageUrl,
  IMAGE_LIMITS,
} from "../shared/remote-image";

export class ImageFailure extends Error {}
const failure = (message: string): never => {
  throw new ImageFailure(message);
};

// libvips metadata does not identify APNG consistently. Inspect bounded container
// chunks as well, before accepting a static image. Pixel validation still decodes.
function rejectAnimation(bytes: Buffer) {
  if (
    bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
  ) {
    for (let offset = 8; offset + 12 <= bytes.length;) {
      const length = bytes.readUInt32BE(offset),
        type = bytes.toString("ascii", offset + 4, offset + 8);
      if (["acTL", "fcTL", "fdAT"].includes(type))
        failure("Animated images are unsupported");
      offset += 12 + length;
    }
  }
  if (
    bytes.toString("ascii", 0, 4) === "RIFF" &&
    bytes.toString("ascii", 8, 12) === "WEBP"
  ) {
    for (let offset = 12; offset + 8 <= bytes.length;) {
      const type = bytes.toString("ascii", offset, offset + 4),
        length = bytes.readUInt32LE(offset + 4);
      if (
        ["ANIM", "ANMF"].includes(type) ||
        (type === "VP8X" && length && bytes[offset + 8] & 2)
      )
        failure("Animated images are unsupported");
      offset += 8 + length + (length % 2);
    }
  }
}
export async function normalizeImage(
  bytes: Buffer,
  signal: AbortSignal,
  pixels = IMAGE_LIMITS.pixels,
  seconds = 15,
) {
  signal.throwIfAborted();
  rejectAnimation(bytes);
  const options = { limitInputPixels: pixels, failOn: "warning" as const };
  const metadata = await sharp(bytes, options).metadata();
  signal.throwIfAborted();
  if (
    !metadata.width ||
    !metadata.height ||
    metadata.width * metadata.height > pixels
  )
    failure("Image exceeds decoded pixel limit");
  if (!["png", "jpeg", "webp"].includes(metadata.format ?? ""))
    failure("Use a static PNG, JPEG or WebP image");
  if (
    (metadata.pages ?? 1) !== 1 ||
    metadata.pageHeight ||
    metadata.delay?.length
  )
    failure("Animated or multipage images are unsupported");
  // Full pixel decode, EXIF orientation, cover crop, deliberate alpha preservation.
  // timeout is supported by installed sharp 0.34.5. A cancelled native operation
  // retains its queue slot until it settles; its result can never be published.
  const normalized = await sharp(bytes, options)
    .timeout({ seconds })
    .rotate()
    .resize(256, 256, { fit: "cover" })
    .png()
    .toBuffer();
  signal.throwIfAborted();
  if (normalized.length > IMAGE_LIMITS.outputBytes)
    failure("Normalized image exceeds output byte limit");
  return {
    normalized,
    sourceWidth: metadata.width,
    sourceHeight: metadata.height,
    sourceFormat: metadata.format as "png" | "jpeg" | "webp",
  };
}

async function download(raw: unknown, signal: AbortSignal, secret?: string) {
  const c = fetchImageSchema.parse(raw),
    maxBytes = c.maxBytes ?? IMAGE_LIMITS.inputBytes;
  let url = imageUrl(c.url),
    authenticated = Boolean(secret);
  const seen = new Set<string>();
  for (let redirects = 0; ; redirects++) {
    signal.throwIfAborted();
    if (seen.has(url.href)) failure("Image redirect loop");
    seen.add(url.href);
    const response = await fetch(url, {
      signal,
      redirect: "manual",
      credentials: "omit",
      headers: authenticated ? { Authorization: `Bearer ${secret}` } : {},
    });
    const reader = response.body?.getReader();
    try {
      if ([301, 302, 303, 307, 308].includes(response.status)) {
        if (redirects >= IMAGE_LIMITS.redirects)
          failure("Too many image redirects");
        const location = response.headers.get("location");
        if (!location || location.length > 4096)
          failure("Invalid image redirect");
        let next: URL;
        try {
          next = imageUrl(new URL(location!, url).href);
        } catch {
          failure("Invalid image redirect");
        }
        if (url.protocol === "https:" && next!.protocol === "http:")
          failure("Image redirect downgrade rejected");
        if (next!.origin !== url.origin) authenticated = false; // permanently dropped
        url = next!;
        continue;
      }
      if (!response.ok)
        failure(`Image server returned HTTP ${response.status}`);
      const length = response.headers.get("content-length");
      if (length && Number(length) > maxBytes)
        failure("Image exceeds download byte limit");
      if (!reader) failure("Empty image response");
      const chunks: Buffer[] = [];
      let size = 0;
      while (true) {
        signal.throwIfAborted();
        const chunk = await reader!.read();
        if (chunk.done) break;
        size += chunk.value.byteLength;
        if (size > maxBytes) failure("Image exceeds download byte limit");
        chunks.push(Buffer.from(chunk.value));
      }
      return Buffer.concat(chunks, size);
    } finally {
      await reader?.cancel().catch(() => {});
      reader?.releaseLock();
    }
  }
}

/** Queue time, redirect/streaming time and decode share one absolute deadline. */
export class RemoteImages {
  private active = 0;
  private waiting: Array<() => void> = [];
  constructor(
    private limits = {
      concurrency: IMAGE_LIMITS.concurrency,
      queue: IMAGE_LIMITS.queue,
    },
  ) {}
  async fetch<T>(
    raw: unknown,
    parent: AbortSignal,
    secret: string | undefined,
    publish: (
      image: Awaited<ReturnType<typeof normalizeImage>>,
      signal: AbortSignal,
    ) => Promise<T>,
  ): Promise<T> {
    const c = fetchImageSchema.parse(raw),
      controller = new AbortController();
    const timer = setTimeout(
      () => controller.abort(),
      c.timeoutMs ?? IMAGE_LIMITS.timeoutMs,
    );
    const signal = AbortSignal.any([parent, controller.signal]);
    let acquired = false;
    const deadline = Date.now() + (c.timeoutMs ?? IMAGE_LIMITS.timeoutMs);
    try {
      signal.throwIfAborted();
      if (this.active >= this.limits.concurrency) {
        if (this.waiting.length >= this.limits.queue)
          failure("Image queue is full; try again later");
        await new Promise<void>((resolve, reject) => {
          const ready = () => {
            signal.removeEventListener("abort", abort);
            this.active++;
            acquired = true;
            resolve();
          };
          const abort = () => {
            this.waiting = this.waiting.filter((r) => r !== ready);
            reject(new ImageFailure("Image request cancelled or timed out"));
          };
          this.waiting.push(ready);
          signal.addEventListener("abort", abort, { once: true });
        });
      } else {
        this.active++;
        acquired = true;
      }
      signal.throwIfAborted();
      const bytes = await download(c, signal, secret);
      const image = await normalizeImage(
        bytes,
        signal,
        c.maxPixels ?? IMAGE_LIMITS.pixels,
        Math.max(1, Math.ceil((deadline - Date.now()) / 1000)),
      );
      signal.throwIfAborted();
      return await publish(image, signal);
    } catch (error) {
      if (signal.aborted) failure("Image request cancelled or timed out");
      if (error instanceof ImageFailure) throw error;
      // Native/fetch errors can contain a URL, headers or arbitrary source bytes.
      return failure(
        "Image fetch, decode or storage failed; check the image and available storage",
      );
    } finally {
      clearTimeout(timer);
      if (acquired) {
        this.active--;
        this.waiting.shift()?.();
      }
    }
  }
}
