import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { createServer, type Server, type ServerResponse } from "node:http";
import { gzipSync, deflateSync, crc32 } from "node:zlib";
import sharp from "sharp";
import { createHash } from "node:crypto";
import { RemoteImages, normalizeImage } from "../src/main/remote-images";
import { fetchImageSchema, IMAGE_LIMITS } from "../src/shared/remote-image";
import { MainRpc } from "../src/main/main-rpc";

const servers: Server[] = [];
const controllers: AbortController[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  controllers.splice(0).forEach((c) => c.abort());
  await Promise.all(
    servers.splice(0).map(
      (server) =>
        new Promise<void>((resolve) => {
          server.closeAllConnections();
          server.close(() => resolve());
        }),
    ),
  );
});
const signal = () => {
  const c = new AbortController();
  controllers.push(c);
  return c;
};
async function fixture(
  handler: (path: string, response: ServerResponse, auth?: string) => void,
) {
  const server = createServer((req, res) =>
    handler(req.url!, res, req.headers.authorization),
  );
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return `http://127.0.0.1:${(server.address() as { port: number }).port}`;
}
let png: Buffer, jpeg: Buffer, webp: Buffer;
beforeAll(async () => {
  const image = () =>
    sharp({
      create: {
        width: 8,
        height: 6,
        channels: 4,
        background: { r: 200, g: 40, b: 70, alpha: 0.5 },
      },
    });
  png = await image().png().toBuffer();
  jpeg = await image().jpeg().toBuffer();
  webp = await image().webp().toBuffer();
});
function apngFixture() {
  const chunk = (type: string, data: Buffer) => {
    const head = Buffer.alloc(4),
      crc = Buffer.alloc(4),
      tagged = Buffer.concat([Buffer.from(type), data]);
    head.writeUInt32BE(data.length);
    crc.writeUInt32BE(crc32(tagged));
    return Buffer.concat([head, tagged, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(1, 0);
  ihdr.writeUInt32BE(1, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  const animation = Buffer.alloc(8);
  animation.writeUInt32BE(2);
  const frame = (sequence: number) => {
    const b = Buffer.alloc(26);
    b.writeUInt32BE(sequence);
    b.writeUInt32BE(1, 4);
    b.writeUInt32BE(1, 8);
    b.writeUInt16BE(1, 20);
    b.writeUInt16BE(10, 22);
    return b;
  };
  const sequence = Buffer.alloc(4);
  sequence.writeUInt32BE(2);
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk("IHDR", ihdr),
    chunk("acTL", animation),
    chunk("fcTL", frame(0)),
    chunk("IDAT", deflateSync(Buffer.from([0, 255, 0, 0, 255]))),
    chunk("fcTL", frame(1)),
    chunk(
      "fdAT",
      Buffer.concat([sequence, deflateSync(Buffer.from([0, 0, 0, 255, 255]))]),
    ),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}
async function animatedWebpFixture() {
  const raw = Buffer.alloc(4 * 8 * 3);
  raw.fill(255, 0, 4 * 4 * 3);
  return sharp(raw, {
    raw: { width: 4, height: 8, channels: 3, pageHeight: 4 },
  })
    .webp({ loop: 0, delay: [100, 100] })
    .toBuffer();
}
const fetchImage = (
  url: string,
  config = {},
  service = new RemoteImages(),
  parent = signal().signal,
  secret?: string,
) =>
  service.fetch({ url, ...config }, parent, secret, async (image) => ({
    ...image,
    hash: createHash("sha256").update(image.normalized).digest("hex"),
  }));

describe("bounded remote raster ingestion", () => {
  it.each(["png", "jpeg", "webp"])(
    "fully decodes %s despite wrong MIME/extension, normalizes and preserves alpha",
    async (format) => {
      const bytes = { png, jpeg, webp }[format]!;
      const base = await fixture((_, res) => {
        res.setHeader("Content-Type", "text/html");
        res.end(bytes);
      });
      const result = await fetchImage(`${base}/avatar.txt?signature=private`),
        metadata = await sharp(result.normalized).metadata();
      expect(result.sourceFormat).toBe(format);
      expect(result.sourceWidth).toBe(8);
      expect(result.hash).toMatch(/^[a-f0-9]{64}$/);
      expect(metadata).toMatchObject({
        width: 256,
        height: 256,
        format: "png",
      });
      expect(metadata.exif).toBeUndefined();
      if (format !== "jpeg")
        expect(
          (
            await sharp(result.normalized)
              .raw()
              .toBuffer({ resolveWithObject: true })
          ).info.channels,
        ).toBe(4);
      expect((await fetchImage(`${base}/again`)).hash).toBe(result.hash);
    },
  );
  it("applies EXIF orientation before its cover crop and strips source metadata", async () => {
    const oriented = await sharp({
      create: { width: 10, height: 6, channels: 3, background: "red" },
    })
      .withMetadata({ orientation: 6 })
      .jpeg()
      .toBuffer();
    const result = await normalizeImage(oriented, signal().signal);
    const expected = await sharp(oriented)
      .rotate()
      .resize(256, 256, { fit: "cover" })
      .png()
      .toBuffer();
    expect(result.normalized).toEqual(expected);
    expect(
      (await sharp(result.normalized).metadata()).orientation,
    ).toBeUndefined();
  });
  it.each([
    "html",
    "svg",
    "gif",
    "malformed",
    "truncated",
    "apng",
    "animated-webp",
  ])("rejects %s without leaking source data", async (kind) => {
    const bytes: Record<string, Buffer> = {
      html: Buffer.from("<html>signed-private-token</html>"),
      svg: Buffer.from(
        '<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"/>',
      ),
      gif: await sharp(png).gif().toBuffer(),
      malformed: Buffer.from("not an image signed-private-token"),
      truncated: png.subarray(0, 45),
      apng: apngFixture(),
      "animated-webp": await animatedWebpFixture(),
    };
    const base = await fixture((_, res) => res.end(bytes[kind]));
    await expect(
      fetchImage(`${base}/private?token=signed-private-token`),
    ).rejects.toThrow(/image/i);
    try {
      await fetchImage(`${base}/private?token=signed-private-token`);
    } catch (error) {
      expect(String(error)).not.toMatch(
        /signed-private|127\.0\.0\.1|<svg|<html/,
      );
    }
  });
  it("rejects corrupt compressed pixel data after a successful header read", async () => {
    const bad = Buffer.from(png);
    const idat = bad.indexOf(Buffer.from("IDAT"));
    bad.fill(0, idat + 4, bad.length - 12);
    expect((await sharp(bad).metadata()).width).toBe(8);
    const base = await fixture((_, res) => res.end(bad));
    await expect(fetchImage(base)).rejects.toThrow(/decode/);
  });
  it("counts chunked and decompressed bytes and rejects advertised oversized bodies", async () => {
    const base = await fixture((path, res) => {
      if (path === "/compressed") {
        res.setHeader("Content-Encoding", "gzip");
        res.end(gzipSync(Buffer.alloc(20_000)));
      } else if (path === "/length") {
        res.setHeader("Content-Length", "1000000");
        res.flushHeaders();
        res.write(png);
      } else {
        res.write(Buffer.alloc(40));
        res.end(Buffer.alloc(100));
      }
    });
    for (const path of ["/compressed", "/length", "/chunked"])
      await expect(fetchImage(base + path, { maxBytes: 100 })).rejects.toThrow(
        /byte limit/,
      );
  });
  it("rejects excessive dimensions and enforces positive finite safety settings", async () => {
    const base = await fixture((_, res) => res.end(png));
    await expect(fetchImage(base, { maxPixels: 10 })).rejects.toThrow(
      /decode|pixel/,
    );
    for (const key of ["maxBytes", "maxPixels", "timeoutMs"])
      for (const value of [0, false, -1, Infinity, Number.MAX_SAFE_INTEGER])
        expect(
          fetchImageSchema.safeParse({ url: base, [key]: value }).success,
        ).toBe(false);
    for (const url of [
      "file:///tmp/x",
      "data:image/png,x",
      "blob:abc",
      "/tmp/x",
      "http://user:pass@example.com/",
    ])
      expect(fetchImageSchema.safeParse({ url }).success).toBe(false);
    expect(IMAGE_LIMITS.outputBytes).toBe(1024 * 1024);
  });
  it("bounds redirects and never retains HTTP error bodies or location URLs", async () => {
    const base = await fixture((path, res) => {
      if (path === "/error") {
        res.statusCode = 403;
        res.end("private-signed-body");
      } else {
        res.statusCode = 302;
        res.setHeader("Location", path === "/loop" ? "/loop" : path + "a");
        res.end();
      }
    });
    await expect(fetchImage(base + "/error")).rejects.toThrow(
      /^Image server returned HTTP 403$/,
    );
    await expect(fetchImage(base + "/loop")).rejects.toThrow(/loop/);
    await expect(fetchImage(base + "/chain")).rejects.toThrow(/Too many/);
  });
  it("drops bearer credentials permanently at a different origin and does not use cookies", async () => {
    const auth: (string | undefined)[] = [];
    let first = "";
    const second = await fixture((_, res, token) => {
      auth.push(token);
      res.statusCode = 302;
      res.setHeader("Location", first + "/final");
      res.end();
    });
    first = await fixture((path, res, token) => {
      auth.push(token);
      if (path === "/final") res.end(png);
      else {
        res.statusCode = 302;
        res.setHeader("Location", path === "/same" ? "/cross" : second);
        res.setHeader("Set-Cookie", "private=1");
        res.end();
      }
    });
    await fetchImage(first + "/same", {}, undefined, undefined, "test-secret");
    expect(auth).toEqual([
      "Bearer test-secret",
      "Bearer test-secret",
      undefined,
      undefined,
    ]);
  });
  it.each(["http://user:password@host/x", "file:///tmp/x", "http://host/x"])(
    "rejects unsafe redirect %s",
    async (location) => {
      vi.spyOn(globalThis, "fetch").mockResolvedValue(
        new Response(null, { status: 302, headers: { Location: location } }),
      );
      await expect(fetchImage("https://example.com/start")).rejects.toThrow(
        /redirect/i,
      );
    },
  );
  it("aborts slow/stalled response, queue wait and post-download publication", async () => {
    const base = await fixture((_, res) => {
      res.writeHead(200);
      res.write(png.subarray(0, 10));
    });
    await expect(fetchImage(base, { timeoutMs: 100 })).rejects.toThrow(
      /timed out/,
    );
    const service = new RemoteImages({ concurrency: 1, queue: 1 }),
      parent = signal();
    const first = fetchImage(base, {}, service, parent.signal),
      queued = fetchImage(base, { timeoutMs: 100 }, service);
    const queuedCheck = expect(queued).rejects.toThrow(/timed out/);
    await expect(fetchImage(base, {}, service)).rejects.toThrow(
      /queue is full/,
    );
    await queuedCheck;
    parent.abort();
    await expect(first).rejects.toThrow(/cancelled/);
    const good = await fixture((_, res) => res.end(png)),
      cancelled = signal();
    await expect(
      service.fetch(
        { url: good },
        cancelled.signal,
        undefined,
        async (_, active) => {
          cancelled.abort();
          active.throwIfAborted();
          return "published";
        },
      ),
    ).rejects.toThrow(/cancelled/);
    expect((await fetchImage(good, {}, service)).hash).toMatch(
      /^[a-f0-9]{64}$/,
    );
  });
});

it("binds RPC abort to worker, run and action identities, including unbound calls", () => {
  const rpc = new MainRpc(),
    worker = {},
    other = {};
  const first = rpc.begin(worker, "r1", "run", "action"),
    second = rpc.begin(other, "r2", "unbound", "a2");
  rpc.cancel(other, "r1", "run", "action");
  rpc.cancel(worker, "r1", "wrong-run", "action");
  expect(first.aborted).toBe(false);
  rpc.cancel(worker, "r1", "run", "action");
  expect(first.aborted).toBe(true);
  expect(second.aborted).toBe(false);
  rpc.invalidate(other);
  expect(second.aborted).toBe(true);
  rpc.finish(worker, "r1");
  const replacement = rpc.begin(worker, "r1", "new-run", "new-action");
  rpc.invalidate();
  expect(replacement.aborted).toBe(true);
});
