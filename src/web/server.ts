import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { networkInterfaces } from "node:os";
import { join, basename } from "node:path";
import { WebSocketServer, WebSocket } from "ws";
import { z } from "zod";
import type {
  WebDeckView,
  WebStatus,
  WebClient,
  PairingRequest,
} from "../shared/schema";
export type StoredClient = Omit<WebClient, "online"> & { tokenHash: string };
const hash = (text: string) => createHash("sha256").update(text).digest("hex"),
  token = () => randomBytes(32).toString("base64url");
export const isLocalAddress = (address: string) => {
  const ip = address.replace(/^::ffff:/, "");
  return (
    ip === "::1" ||
    /^127\./.test(ip) ||
    /^10\./.test(ip) ||
    /^192\.168\./.test(ip) ||
    /^172\.(1[6-9]|2\d|3[01])\./.test(ip) ||
    /^169\.254\./.test(ip) ||
    /^(fc|fd|fe80:)/i.test(ip)
  );
};
const inputSchema = z.discriminatedUnion("type", [
  z
    .object({
      type: z.literal("view"),
      version: z.string().max(200),
      visible: z.boolean(),
      sequence: z.number().int().positive(),
    })
    .strict(),
  z.object({
    type: z.literal("down"),
    key: z.number().int().min(0).max(255),
    version: z.string().max(200),
    sequence: z.number().int().positive(),
  }),
  z.object({
    type: z.literal("up"),
    key: z.number().int().min(0).max(255),
    sequence: z.number().int().positive(),
  }),
  z.object({ type: z.literal("reset"), sequence: z.number().int().positive() }),
  z.object({
    type: z.literal("heartbeat"),
    sequence: z.number().int().positive(),
  }),
]);
export class WebDeckServer {
  private server?: ReturnType<typeof createServer>;
  private sockets = new Map<
    WebSocket,
    {
      version?: string;
      viewAt?: number;
      clientId: string;
      source: string;
      alive: boolean;
      sequence: number;
      held: Set<number>;
      rate: number;
      rateAt: number;
    }
  >();
  private wss?: WebSocketServer;
  private interval?: ReturnType<typeof setInterval>;
  private views = new Map<string, WebDeckView>();
  private invitations = new Map<
    string,
    { deckId: string; expiresAt: number }
  >();
  private pending = new Map<
    string,
    PairingRequest & {
      pollHash: string;
      sessionToken?: string;
      approved?: boolean;
    }
  >();
  private clients = new Map<string, StoredClient>();
  private rates = new Map<string, { at: number; count: number }>();
  private boundPort = 0;
  private allowedHosts = new Set<string>();
  constructor(
    private options: {
      rendererDirectory: string;
      assetDirectory: string;
      loadClients: () => Promise<StoredClient[]>;
      saveClients: (clients: StoredClient[]) => Promise<void>;
      input: (event: {
        deckId: string;
        source: string;
        key: number;
        down: boolean;
      }) => void;
      disconnect: (source: string) => void;
      visibilityLost?: (source: string) => void;
      visibility?: (event: {
        source: string;
        deckId: string;
        version: string;
      }) => void;
      now?: () => number;
      status: (status: WebStatus) => void;
      error?: (error: unknown) => void;
    },
  ) {}
  private state(): WebStatus {
    return {
      running: Boolean(this.server?.listening),
      port: this.boundPort,
      urls: this.urls(),
      clients: [...this.clients.values()].map(
        ({ tokenHash: _hash, ...client }) => ({
          ...client,
          online: [...this.sockets.values()].some(
            (s) => s.clientId === client.id,
          ),
        }),
      ),
      pending: [...this.pending.values()]
        .filter((p) => p.approved === undefined)
        .map(
          ({
            pollHash: _hash,
            sessionToken: _token,
            approved: _approved,
            ...p
          }) => p,
        ),
    };
  }
  private publish() {
    this.options.status(this.state());
  }
  private urls() {
    return [...this.allowedHosts]
      .filter((h) => h !== "localhost")
      .map((h) => `http://${h.includes(":") ? `[${h}]` : h}:${this.boundPort}`);
  }
  async start(port = 9018) {
    if (this.server) return;
    for (const client of await this.options.loadClients())
      if (this.views.has(client.deckId)) this.clients.set(client.id, client);
    this.allowedHosts = new Set(["localhost", "127.0.0.1"]);
    for (const interfaces of Object.values(networkInterfaces()))
      for (const i of interfaces ?? [])
        if (i.family === "IPv4" && isLocalAddress(i.address))
          this.allowedHosts.add(i.address);
    this.server = createServer((req, res) => {
      void this.handle(req, res).catch((error) => {
        this.options.error?.(error);
        if (!res.headersSent)
          this.json(res, 400, { error: "Request could not be completed" });
        else res.end();
      });
    });
    this.wss = new WebSocketServer({ noServer: true, maxPayload: 2048 });
    this.server.on("upgrade", (req, socket, head) => {
      const client = this.authenticate(req);
      if (
        !this.validRequest(req) ||
        !client ||
        new URL(req.url ?? "/", this.origin(req)).pathname !== "/socket" ||
        req.headers.origin !== this.origin(req) ||
        !this.views.has(client.deckId) ||
        this.sockets.size >= 64
      ) {
        socket.end("HTTP/1.1 403 Forbidden\r\n\r\n");
        return;
      }
      this.wss!.handleUpgrade(req, socket, head, (ws) =>
        this.connect(ws, client),
      );
    });
    try {
      await new Promise<void>((resolve, reject) => {
        this.server!.once("error", reject);
        this.server!.listen(port, "0.0.0.0", () => resolve());
      });
      this.server.on("error", (error) => this.options.error?.(error));
      this.boundPort = (this.server.address() as { port: number }).port;
    } catch (error) {
      this.server = undefined;
      this.wss.close();
      this.wss = undefined;
      throw new Error(
        `Cannot start local web decks on port ${port}: ${String(error)}`,
      );
    }
    this.interval = setInterval(() => {
      const now = this.options.now?.() ?? Date.now();
      for (const [ws, s] of this.sockets) {
        if (s.viewAt !== undefined && now - s.viewAt >= 12000) {
          s.version = undefined;
          s.viewAt = undefined;
          s.held.clear();
          this.options.disconnect(s.source);
        }
        if (!s.alive) {
          this.drop(ws);
          ws.terminate();
        } else {
          s.alive = false;
          ws.ping();
        }
      }
      for (const [id, p] of this.pending)
        if (p.expiresAt < now) this.pending.delete(id);
      for (const [id, i] of this.invitations)
        if (i.expiresAt < now) this.invitations.delete(id);
      for (const [id, r] of this.rates)
        if (now - r.at > 60000) this.rates.delete(id);
      this.publish();
    }, 10000);
    this.interval.unref();
    this.publish();
  }
  configure(views: WebDeckView[]) {
    this.views = new Map(views.map((v) => [v.id, v]));
    for (const client of this.clients.values())
      if (!this.views.has(client.deckId)) this.revoke(client.id);
    for (const [ws, s] of this.sockets) {
      const client = this.clients.get(s.clientId),
        view = client && this.views.get(client.deckId);
      if (view) {
        if (s.version && s.version !== view.version) {
          s.version = undefined;
          s.viewAt = undefined;
          // A held press still owns its captured release/hold binding across navigation.
          this.options.visibilityLost?.(s.source);
        }
        this.send(ws, { type: "view", view });
      } else {
        this.drop(ws);
        ws.close(1008, "Deck removed");
      }
    }
  }
  invite(deckId: string) {
    if (!this.server?.listening || !this.views.has(deckId))
      throw new Error("Enable local web decks in Settings first");
    if (this.invitations.size >= 32)
      throw new Error("Too many active pairing links");
    const ticket = token(),
      expiresAt = Date.now() + 120000;
    this.invitations.set(hash(ticket), { deckId, expiresAt });
    return {
      urls: this.urls().map(
        (base) => `${base}/deck/${encodeURIComponent(deckId)}#invite=${ticket}`,
      ),
      expiresAt,
    };
  }
  approve(id: string, approved: boolean) {
    const p = this.pending.get(id);
    if (!p || p.expiresAt < Date.now() || p.approved !== undefined)
      throw new Error("Pairing request expired");
    p.approved = approved;
    if (approved) {
      if (this.clients.size >= 64)
        throw new Error("Maximum paired browsers reached (64)");
      const sessionToken = token();
      p.sessionToken = sessionToken;
      const client: StoredClient = {
        id: randomUUID(),
        deckId: p.deckId,
        name: p.name,
        tokenHash: hash(sessionToken),
        createdAt: Date.now(),
        lastSeen: Date.now(),
      };
      this.clients.set(client.id, client);
      void this.persist();
    }
    p.expiresAt = Date.now() + 30000;
    this.publish();
  }
  revoke(id: string) {
    this.clients.delete(id);
    for (const [ws, s] of this.sockets)
      if (s.clientId === id) {
        this.drop(ws);
        ws.close(1008, "Pairing revoked");
      }
    void this.persist();
    this.publish();
  }
  private async persist() {
    try {
      await this.options.saveClients([...this.clients.values()]);
    } catch (error) {
      this.options.error?.(error);
    }
  }
  private origin(req: IncomingMessage) {
    return `http://${req.headers.host}`;
  }
  private validRequest(req: IncomingMessage) {
    try {
      const host = new URL(this.origin(req));
      return (
        this.allowedHosts.has(host.hostname.replace(/^\[|\]$/g, "")) &&
        Number(host.port) === this.boundPort &&
        isLocalAddress(req.socket.remoteAddress ?? "")
      );
    } catch {
      return false;
    }
  }
  private authenticate(req: IncomingMessage) {
    const deckId = new URL(req.url ?? "/", this.origin(req)).searchParams.get(
      "deck",
    );
    const sessions =
      req.headers.cookie
        ?.split(";")
        .map((s) => s.trim())
        .filter((s) => s.startsWith("decker_session_"))
        .map((s) => s.slice(s.indexOf("=") + 1))
        .filter((s) => s.length <= 200) ?? [];
    const matches = [...this.clients.values()].filter(
      (client) =>
        (!deckId || client.deckId === deckId) &&
        sessions.some((token) => client.tokenHash === hash(token)),
    );
    return matches.length === 1 ? matches[0] : undefined;
  }
  private json(res: ServerResponse, status: number, value: unknown) {
    res.writeHead(status, {
      "Content-Type": "application/json",
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
    });
    res.end(JSON.stringify(value));
  }
  private async body(req: IncomingMessage) {
    let text = "";
    for await (const chunk of req) {
      text += String(chunk);
      if (text.length > 4096) throw new Error("Request is too large");
    }
    return JSON.parse(text);
  }
  private async handle(req: IncomingMessage, res: ServerResponse) {
    if (!this.validRequest(req)) {
      this.json(res, 403, { error: "Local network access only" });
      return;
    }
    const ip = req.socket.remoteAddress ?? "",
      now = Date.now(),
      rate = this.rates.get(ip) ?? { at: now, count: 0 };
    if (now - rate.at > 10000) {
      rate.at = now;
      rate.count = 0;
    }
    this.rates.set(ip, rate);
    if (++rate.count > 120 || this.rates.size > 1024) {
      this.json(res, 429, { error: "Too many requests" });
      return;
    }
    const url = new URL(req.url ?? "/", this.origin(req)),
      path = url.pathname;
    if (req.method === "POST") {
      if (
        req.headers.origin !== this.origin(req) ||
        req.headers["x-decker-request"] !== "1"
      ) {
        this.json(res, 403, { error: "Origin rejected" });
        return;
      }
      if (path === "/api/pair") {
        const { ticket, name } = z
            .object({
              ticket: z.string().max(100),
              name: z.string().min(1).max(80),
            })
            .parse(await this.body(req)),
          invitation = this.invitations.get(hash(ticket));
        if (
          !invitation ||
          invitation.expiresAt < now ||
          !this.views.has(invitation.deckId) ||
          this.pending.size >= 32
        ) {
          this.json(res, 403, {
            error: "Pairing link expired. Request a new link from Decker.",
          });
          return;
        }
        this.invitations.delete(hash(ticket));
        const id = randomUUID(),
          pollToken = token(),
          code = String(Math.floor(Math.random() * 900000) + 100000);
        this.pending.set(id, {
          id,
          deckId: invitation.deckId,
          name,
          code,
          expiresAt: now + 120000,
          pollHash: hash(pollToken),
        });
        this.publish();
        this.json(res, 200, { id, pollToken, code });
        return;
      }
      if (path === "/api/pair-status") {
        const { id, pollToken } = z
            .object({ id: z.string(), pollToken: z.string().max(100) })
            .parse(await this.body(req)),
          p = this.pending.get(id);
        if (!p || p.expiresAt < now || p.pollHash !== hash(pollToken)) {
          this.json(res, 403, { error: "Pairing expired" });
          return;
        }
        if (p.approved && p.sessionToken) {
          res.setHeader(
            "Set-Cookie",
            `decker_session_${hash(p.deckId).slice(0, 16)}=${p.sessionToken}; HttpOnly; SameSite=Strict; Path=/; Max-Age=31536000`,
          );
          this.pending.delete(id);
          this.json(res, 200, { approved: true });
          return;
        }
        this.json(res, 200, { approved: p.approved ?? null });
        return;
      }
      this.json(res, 404, { error: "Unknown operation" });
      return;
    }
    if (req.method !== "GET") {
      this.json(res, 405, { error: "Method unavailable" });
      return;
    }
    if (path === "/api/session") {
      const client = this.authenticate(req);
      if (
        !client ||
        client.deckId !== url.searchParams.get("deck") ||
        !this.views.has(client.deckId)
      ) {
        this.json(res, 401, {
          error: "Pair this browser from the desktop app",
        });
        return;
      }
      this.json(res, 200, { paired: true });
      return;
    }
    if (path.startsWith("/key-assets/")) {
      const client = this.authenticate(req),
        id = path.slice(12),
        view = client && this.views.get(client.deckId);
      if (
        !view ||
        !/^[a-f0-9]{64}$/.test(id) ||
        !Object.values(view.keys).some((k) => k.asset === id)
      ) {
        this.json(res, 403, { error: "Asset unavailable" });
        return;
      }
      const bytes = await readFile(join(this.options.assetDirectory, id));
      res.writeHead(200, {
        "Content-Type": "image/png",
        "Cache-Control": "private, max-age=3600",
        "X-Content-Type-Options": "nosniff",
      });
      res.end(bytes);
      return;
    }
    if (/^\/assets\/[a-zA-Z0-9_-]+\.(js|css)$/.test(path)) {
      const html = await readFile(
        join(this.options.rendererDirectory, "web.html"),
        "utf8",
      );
      if (!html.includes(path)) {
        this.json(res, 404, { error: "Asset unavailable" });
        return;
      }
      const bytes = await readFile(
        join(this.options.rendererDirectory, "assets", basename(path)),
      );
      res.writeHead(200, {
        "Content-Type": path.endsWith(".js") ? "text/javascript" : "text/css",
        "X-Content-Type-Options": "nosniff",
      });
      res.end(bytes);
      return;
    }
    if (path === "/" || /^\/deck\/[^/]+$/.test(path)) {
      const html = (
        await readFile(join(this.options.rendererDirectory, "web.html"), "utf8")
      ).replaceAll('="./assets/', '="/assets/');
      res.writeHead(200, {
        "Content-Type": "text/html",
        "Cache-Control": "no-store",
        "Content-Security-Policy":
          "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self'; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'",
        "X-Content-Type-Options": "nosniff",
        "Referrer-Policy": "no-referrer",
      });
      res.end(html);
      return;
    }
    this.json(res, 404, { error: "Not found" });
  }
  private send(ws: WebSocket, value: unknown) {
    if (ws.readyState === WebSocket.OPEN && ws.bufferedAmount < 1_000_000)
      ws.send(JSON.stringify(value));
    else {
      this.drop(ws);
      ws.terminate();
    }
  }
  private connect(ws: WebSocket, client: StoredClient) {
    const source = `web:${client.id}:${randomUUID()}`;
    this.sockets.set(ws, {
      clientId: client.id,
      source,
      alive: true,
      sequence: 0,
      held: new Set(),
      rate: 0,
      rateAt: Date.now(),
    });
    client.lastSeen = Date.now();
    this.send(ws, { type: "view", view: this.views.get(client.deckId) });
    ws.on("pong", () => {
      const s = this.sockets.get(ws);
      if (s) s.alive = true;
    });
    ws.on("error", () => this.drop(ws));
    ws.on("close", () => this.drop(ws));
    ws.on("message", (data) => {
      try {
        const s = this.sockets.get(ws);
        if (!s) return;
        const now = this.options.now?.() ?? Date.now();
        if (now - s.rateAt > 1000) {
          s.rateAt = now;
          s.rate = 0;
        }
        if (++s.rate > 120) throw new Error("Input limit reached");
        const input = inputSchema.parse(JSON.parse(String(data)));
        if (input.sequence <= s.sequence) throw new Error("Stale input");
        s.sequence = input.sequence;
        s.alive = true;
        const view = this.views.get(client.deckId);
        if (!view || !this.clients.has(client.id))
          throw new Error("Deck unavailable");
        if (input.type === "view") {
          if (!input.visible || input.version !== view.version) {
            s.version = undefined;
            s.viewAt = undefined;
            if (!input.visible) {
              s.held.clear();
              this.options.disconnect(s.source);
            } else this.options.visibilityLost?.(s.source);
            return;
          }
          s.version = view.version;
          s.viewAt = now;
          this.options.visibility?.({
            source: s.source,
            deckId: client.deckId,
            version: view.version,
          });
          return;
        }
        if (input.type === "heartbeat") return;
        if (input.type === "reset") {
          s.held.clear();
          this.options.disconnect(s.source);
          return;
        }
        if (input.type === "down") {
          if (
            input.version !== view.version ||
            input.key >= view.rows * view.columns
          )
            throw new Error("Deck changed; wait for the current page");
          if (s.held.has(input.key)) return;
          s.held.add(input.key);
          this.options.input({
            deckId: client.deckId,
            source: s.source,
            key: input.key,
            down: true,
          });
        } else if (s.held.delete(input.key))
          this.options.input({
            deckId: client.deckId,
            source: s.source,
            key: input.key,
            down: false,
          });
      } catch (error) {
        this.send(ws, {
          type: "error",
          error: error instanceof Error ? error.message : String(error),
        });
      }
    });
    this.publish();
  }
  private drop(ws: WebSocket) {
    const s = this.sockets.get(ws);
    if (!s) return;
    this.sockets.delete(ws);
    this.options.disconnect(s.source);
    this.publish();
  }
  async resetPairings() {
    this.clients.clear();
    for (const ws of [...this.sockets.keys()]) {
      this.drop(ws);
      ws.close(1008, "Pairing reset");
    }
    this.invitations.clear();
    this.pending.clear();
    await this.persist();
    this.publish();
  }
  async stop() {
    clearInterval(this.interval);
    for (const ws of [...this.sockets.keys()]) {
      this.drop(ws);
      ws.terminate();
    }
    this.wss?.close();
    await new Promise<void>((resolve) => {
      if (!this.server?.listening) {
        resolve();
        return;
      }
      this.server.close(() => resolve());
      this.server.closeAllConnections();
    });
    this.server = undefined;
    this.wss = undefined;
    this.invitations.clear();
    this.pending.clear();
    this.publish();
  }
}
