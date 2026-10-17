import { createServer } from "node:http";
import sharp from "sharp";
let revision = 1,
  failing = false;
const base = "http://127.0.0.1:8743";
createServer(async (request, response) => {
  try {
    if (request.url === "/next") revision++;
    if (request.url === "/fail") failing = true;
    if (request.url === "/reset") failing = false;
    if (request.url === "/avatar") {
      const image = await sharp({
        create: {
          width: 256,
          height: 256,
          channels: 4,
          background: revision % 2 ? "#285aaf" : "#b95c38",
        },
      })
        .png()
        .toBuffer();
      response.writeHead(200, { "Content-Type": "image/png" });
      response.end(image);
    } else if (request.url === "/api" && failing) {
      response.writeHead(429, { "Retry-After": "120" });
      response.end();
    } else {
      response.writeHead(200, { "Content-Type": "application/json" });
      response.end(
        JSON.stringify({
          name: `Local avatar ${revision}`,
          avatar: base + "/avatar",
          failing,
        }),
      );
    }
  } catch {
    response.writeHead(500);
    response.end();
  }
}).listen(8743, "127.0.0.1", () =>
  console.log(`Avatar fixture: ${base}/api; controls: /next, /fail, /reset`),
);
