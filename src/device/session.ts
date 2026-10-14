import type {
  StreamDeck,
  StreamDeckDeviceInfo,
} from "@elgato-stream-deck/node";
import type { DeviceStatus, DeviceState, KeyBinding } from "../shared/schema";

export type Frame = {
  deckId: string;
  hardwareId: string;
  brightness: number;
  page: Record<string, KeyBinding["appearance"]>;
  name?: string;
  rows?: number;
  columns?: number;
};
export type DeviceTransport = Pick<
  StreamDeck,
  "CONTROLS" | "setBrightness" | "fillKeyBuffer" | "on" | "close"
>;
export type DeviceEvent =
  | { type: "devices"; devices: DeviceStatus[] }
  | { type: "nativeReady"; ready: boolean; error?: string }
  | { type: "key"; id: string; key: number; down: boolean }
  | { type: "disconnect"; id: string };
type Connection = {
  deck: DeviceTransport;
  active: boolean;
  sent: Map<number, string>;
  brightness?: number;
  work?: Promise<void>;
};
type Session = {
  status: DeviceStatus;
  info?: StreamDeckDeviceInfo;
  frame?: Frame;
  generation: number;
  connection?: Connection;
  opening?: Promise<void>;
  closing?: Promise<void>;
  retry?: ReturnType<typeof setTimeout>;
  failures: number;
};
const blank: KeyBinding["appearance"] = {
  label: "",
  icon: "",
  background: "#111214",
  running: "#5865f2",
  success: "#23a559",
  error: "#f23f42",
};
export const hardwareIdentity = (info: StreamDeckDeviceInfo) =>
  info.serialNumber
    ? `${info.model}:${info.serialNumber}`
    : `session:${info.path}`;

export function classifyDeviceError(
  error: unknown,
  stage: "open" | "write" | "discovery",
): { state: DeviceState; details: NonNullable<DeviceStatus["errorDetails"]> } {
  const value = error as { code?: unknown; errno?: unknown; message?: unknown };
  const code = typeof value?.code === "string" ? value.code : undefined;
  const errno = typeof value?.errno === "number" ? value.errno : undefined;
  const message =
    typeof value?.message === "string" ? value.message : String(error);
  const permission =
    ["EACCES", "EPERM"].includes(code ?? "") ||
    [1, 13, -1, -13].includes(errno ?? 0) ||
    /permission denied|access denied|operation not permitted/i.test(message);
  const busy =
    code === "EBUSY" ||
    Math.abs(errno ?? 0) === 16 ||
    /\bdevice (?:is )?busy\b/i.test(message);
  return {
    state: permission
      ? "permission-denied"
      : busy
        ? "busy"
        : stage === "open"
          ? "open-error"
          : "io-error",
    details: { stage, message, code, errno, at: Date.now() },
  };
}

// All physical I/O is injected. Importing this module never loads node-hid.
export class DeviceSessions {
  private sessions = new Map<string, Session>();
  private frames = new Map<string, Frame>();
  private assetDirectory = "";
  private scanning = false;
  private scanAgain = false;
  private stopped = false;
  constructor(
    private io: {
      discover(): Promise<StreamDeckDeviceInfo[]>;
      open(path: string): Promise<DeviceTransport>;
      render(
        appearance: KeyBinding["appearance"],
        size: number,
        directory: string,
      ): Promise<Buffer>;
      permissionDenied?(path: string): Promise<boolean>;
    },
    private send: (event: DeviceEvent) => void,
  ) {}

  private report() {
    this.send({
      type: "devices",
      devices: [...this.sessions.values()]
        .filter((s) => s.status.present || s.status.configured)
        .map((s) => structuredClone(s.status)),
    });
  }
  private transition(session: Session, state: DeviceState) {
    session.status.state = state;
    session.status.connected = state === "ready";
    session.status.updatedAt = Date.now();
    this.report();
  }
  private makeSession(id: string, frame?: Frame): Session {
    return {
      status: {
        id,
        name: frame?.name ?? id,
        connected: false,
        present: false,
        configured: !!frame,
        state: "disconnected",
        updatedAt: Date.now(),
        simulated: false,
        rows: frame?.rows ?? 4,
        columns: frame?.columns ?? 8,
        iconSize: 96,
      },
      frame,
      generation: 0,
      failures: 0,
    };
  }

  configure(frames: Frame[], assetDirectory: string) {
    if (this.stopped) return;
    this.frames = new Map(
      frames.map((f) => [f.hardwareId, structuredClone(f)]),
    );
    this.assetDirectory = assetDirectory;
    for (const [id, frame] of this.frames)
      if (!this.sessions.has(id))
        this.sessions.set(id, this.makeSession(id, frame));
    for (const session of this.sessions.values()) {
      const previous = session.frame;
      session.frame = this.frames.get(session.status.id);
      session.status.configured = !!session.frame;
      if (!session.frame) {
        this.release(session);
        this.clearError(session);
        this.transition(
          session,
          session.status.present ? "discovered" : "disconnected",
        );
      } else if (previous && previous.deckId !== session.frame.deckId) {
        this.release(session);
        session.failures = 0;
        this.clearError(session);
        this.transition(
          session,
          session.status.present ? "discovered" : "disconnected",
        );
      } else if (session.connection) this.draw(session);
    }
    this.report();
    void this.scan();
  }

  async scan() {
    if (this.stopped) return;
    if (this.scanning) {
      this.scanAgain = true;
      return;
    }
    this.scanning = true;
    try {
      const found = await this.io.discover();
      if (this.stopped) return;
      this.send({ type: "nativeReady", ready: true });
      const present = new Set(found.map(hardwareIdentity));
      for (const session of this.sessions.values()) {
        if (!present.has(session.status.id)) {
          session.status.present = false;
          session.info = undefined;
          this.release(session);
          session.failures = 0;
          this.clearError(session);
          if (session.status.state !== "disconnected")
            this.transition(session, "disconnected");
        }
      }
      for (const info of found) {
        const id = hardwareIdentity(info);
        let session = this.sessions.get(id);
        if (!session) {
          session = this.makeSession(id, this.frames.get(id));
          this.sessions.set(id, session);
        }
        const fresh =
          !session.status.present || session.info?.path !== info.path;
        if (fresh) {
          this.release(session);
          session.failures = 0;
          this.clearError(session);
        }
        session.info = info;
        session.status.present = true;
        session.status.name = info.modelInfo.name;
        const controls = info.modelInfo.controls.filter(
          (c) => c.type === "button",
        );
        const first = controls.find((c) => c.feedbackType === "lcd");
        session.status.rows = Math.max(1, ...controls.map((c) => c.row + 1));
        session.status.columns = Math.max(
          1,
          ...controls.map((c) => c.column + 1),
        );
        session.status.iconSize =
          first?.feedbackType === "lcd" ? first.pixelSize.width : 96;
        if (fresh || session.status.errorDetails?.stage === "discovery") {
          this.clearError(session);
          this.transition(session, "discovered");
        }
        if (session.frame && session.status.state === "discovered")
          this.connect(session);
      }
      this.report();
    } catch (error) {
      if (this.stopped) return;
      this.send({ type: "nativeReady", ready: false, error: String(error) });
      for (const session of this.sessions.values()) {
        this.release(session);
        this.fail(session, error, "discovery", false);
      }
    } finally {
      this.scanning = false;
      if (this.scanAgain && !this.stopped) {
        this.scanAgain = false;
        void this.scan();
      }
    }
  }

  private clearError(session: Session) {
    delete session.status.error;
    delete session.status.errorDetails;
  }
  private release(session: Session) {
    session.generation++;
    clearTimeout(session.retry);
    session.retry = undefined;
    const connection = session.connection;
    session.connection = undefined;
    this.send({ type: "disconnect", id: session.status.id });
    if (connection) {
      connection.active = false;
      session.closing = (async () => {
        await connection.work;
        await connection.deck.close().catch(() => {});
      })();
    }
  }
  private fail(
    session: Session,
    error: unknown,
    stage: "open" | "write" | "discovery",
    retry = true,
  ) {
    const failure = classifyDeviceError(error, stage);
    session.status.errorDetails = failure.details;
    session.status.error = `${session.status.name}: ${failure.details.message}`;
    this.transition(session, failure.state);
    // Five automatic attempts, with exponential delay capped at 8 seconds.
    // Permission and unknown open errors wait for explicit Retry or reconnect.
    if (
      retry &&
      session.frame &&
      session.status.present &&
      (failure.state === "io-error" ||
        failure.state === "busy" ||
        ["EIO", "ETIMEDOUT", "ENODEV", "ENOENT", "EPIPE"].includes(
          failure.details.code ?? "",
        )) &&
      session.failures < 5
    ) {
      const delay = Math.min(250 * 2 ** session.failures++, 8000);
      session.retry = setTimeout(() => {
        session.retry = undefined;
        this.connect(session);
      }, delay);
      session.retry.unref?.();
    }
  }

  private connect(session: Session) {
    if (
      this.stopped ||
      session.connection ||
      session.opening ||
      !session.frame ||
      !session.info ||
      !session.status.present
    )
      return;
    const generation = session.generation;
    const path = session.info.path;
    this.clearError(session);
    this.transition(session, "opening");
    session.opening = (async () => {
      await session.closing;
      if (generation !== session.generation || this.stopped) return;
      try {
        const deck = await this.io.open(path);
        if (
          generation !== session.generation ||
          this.stopped ||
          !session.frame
        ) {
          await deck.close().catch(() => {});
          return;
        }
        const connection: Connection = { deck, active: true, sent: new Map() };
        session.connection = connection;
        const input = (
          control: { type: string; index: number },
          down: boolean,
        ) => {
          if (
            connection.active &&
            session.status.state === "ready" &&
            control.type === "button"
          )
            this.send({
              type: "key",
              id: session.status.id,
              key: control.index,
              down,
            });
        };
        deck.on("down", (c) => input(c, true));
        deck.on("up", (c) => input(c, false));
        deck.on("error", (error) => {
          if (!connection.active) return;
          this.release(session);
          this.fail(session, error, "write");
        });
        this.draw(session);
      } catch (error) {
        if (generation !== session.generation || this.stopped) return;
        let failure = error;
        if (
          classifyDeviceError(error, "open").state === "open-error" &&
          this.io.permissionDenied
        ) {
          const denied = await this.io
            .permissionDenied(path)
            .catch(() => false);
          if (generation !== session.generation || this.stopped) return;
          if (denied)
            failure = Object.assign(new Error(String(error)), {
              code: "EACCES",
            });
        }
        this.send({ type: "disconnect", id: session.status.id });
        this.fail(session, failure, "open");
      }
    })().finally(() => {
      session.opening = undefined;
      // A path/configuration change can invalidate an open that was in flight.
      if (session.status.state === "discovered") this.connect(session);
    });
  }

  private draw(session: Session) {
    const connection = session.connection;
    if (!connection || connection.work || !session.frame) return;
    connection.work = (async () => {
      try {
        // Read the latest desired frame between writes. A burst of page/brightness
        // changes replaces pending work; successful writes alone populate caches.
        while (connection.active && session.frame && !this.stopped) {
          const frame = session.frame;
          const directory = this.assetDirectory;
          if (connection.brightness !== frame.brightness) {
            await connection.deck.setBrightness(frame.brightness);
            if (!connection.active) return;
            connection.brightness = frame.brightness;
            session.status.lastSuccessfulWriteAt = Date.now();
            continue;
          }
          let written = false;
          for (const control of connection.deck.CONTROLS) {
            if (control.type !== "button" || control.feedbackType !== "lcd")
              continue;
            const appearance = frame.page[control.index] ?? blank;
            const signature = JSON.stringify([appearance, directory]);
            if (connection.sent.get(control.index) === signature) continue;
            const image = await this.io.render(
              appearance,
              control.pixelSize.width,
              directory,
            );
            if (!connection.active) return;
            if (session.frame !== frame || this.assetDirectory !== directory) {
              written = true;
              break;
            }
            await connection.deck.fillKeyBuffer(control.index, image, {
              format: "rgb",
            });
            if (!connection.active) return;
            connection.sent.set(control.index, signature);
            session.status.lastSuccessfulWriteAt = Date.now();
            written = true;
            break;
          }
          if (!written) {
            session.failures = 0;
            this.transition(session, "ready");
            return;
          }
        }
      } catch (error) {
        if (!connection.active) return;
        this.release(session);
        this.fail(session, error, "write");
      }
    })().finally(() => {
      connection.work = undefined;
    });
  }

  refresh(id?: string) {
    if (this.stopped) return;
    for (const session of this.sessions.values()) {
      if (id && session.status.id !== id) continue;
      clearTimeout(session.retry);
      session.retry = undefined;
      session.failures = 0;
      this.clearError(session);
      if (session.connection) {
        session.connection.sent.clear();
        session.connection.brightness = undefined;
        this.draw(session);
      } else {
        this.transition(
          session,
          session.status.present ? "discovered" : "disconnected",
        );
        this.connect(session);
      }
    }
    void this.scan();
  }

  async stop() {
    this.stopped = true;
    for (const session of this.sessions.values()) {
      this.release(session);
      session.status.present = false;
      this.transition(session, "disconnected");
    }
    await Promise.all(
      [...this.sessions.values()].map(async (s) => {
        await s.opening;
        await s.closing;
      }),
    );
  }
}
