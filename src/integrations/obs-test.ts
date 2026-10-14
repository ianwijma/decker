import { withCancellation } from "../runtime/cancellation";
import type { ObsTestResult, ObsTestStatus } from "../shared/obs-contract";
import { obsUrlSchema } from "../shared/obs-contract";
import { DisposableObsClient } from "./obs-client";

export type ObsProbeClient = Pick<
  DisposableObsClient,
  "connect" | "call" | "dispose"
>;
const messages: Record<ObsTestStatus, string> = {
  success:
    "Connection and authentication succeeded. Read-only GetVersion passed. This is a point-in-time test.",
  unreachable:
    "Endpoint refused or could not be reached. Check the address, port, OBS server and network/firewall.",
  timeout:
    "OBS did not respond in time. Check the server, address, port and network, then retry.",
  authentication:
    "OBS rejected authentication. Check the password in Tools → obs-websocket Settings.",
  "missing-credential":
    "No saved password is available. Enter a password, or explicitly choose no authentication only if OBS is configured that way.",
  "locked-credential":
    "The saved password is locked. Unlock the keyring and restart, or supply a replacement password.",
  incompatible:
    "The server did not accept the OBS WebSocket v5 / RPC 1 protocol. Use OBS 28 or newer and check the WebSocket endpoint.",
  "invalid-input":
    "Use a bounded ws:// or wss:// address without embedded credentials and a valid connection owner.",
  cancelled:
    "Test cancelled or its connection changed. Test the current draft again.",
  busy: "Another connection test is still cleaning up. Retry shortly.",
  error:
    "Connection could not be verified. Check the OBS server, address, TLS certificate and network. The underlying cause could not be classified.",
};
export function obsOutcome(id: string, status: ObsTestStatus): ObsTestResult {
  return { id, status, message: messages[status] };
}
export async function probeObs(
  id: string,
  url: string,
  password: string | undefined,
  signal: AbortSignal,
  create: () => ObsProbeClient = () => new DisposableObsClient(),
  timeoutMs = 5000,
): Promise<ObsTestResult> {
  if (
    !obsUrlSchema.safeParse(url).success ||
    (password !== undefined && (!password || password.length > 16000))
  )
    return obsOutcome(id, "invalid-input");
  const bounded = AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)]);
  let client: ObsProbeClient | undefined;
  try {
    bounded.throwIfAborted();
    client = create();
    const identified = await withCancellation(
      client.connect(url, password, { rpcVersion: 1, eventSubscriptions: 0 }),
      bounded,
      0,
    );
    if (identified.negotiatedRpcVersion !== 1)
      return obsOutcome(id, "incompatible");
    const version = await withCancellation(
      client.call("GetVersion"),
      bounded,
      0,
    );
    if (
      version.rpcVersion !== 1 ||
      typeof version.obsVersion !== "string" ||
      !version.obsVersion ||
      version.obsVersion.length > 80 ||
      typeof version.obsWebSocketVersion !== "string" ||
      !version.obsWebSocketVersion ||
      version.obsWebSocketVersion.length > 80
    )
      return obsOutcome(id, "incompatible");
    return obsOutcome(id, "success");
  } catch (error) {
    // Never return low-level text or response payloads: peers can echo secrets.
    if (signal.aborted) return obsOutcome(id, "cancelled");
    if (bounded.aborted) return obsOutcome(id, "timeout");
    const code = (error as { code?: unknown })?.code;
    const text = error instanceof Error ? error.message : "";
    if (code === 4009)
      return obsOutcome(id, password ? "authentication" : "missing-credential");
    if (code === 4010 || code === 4006 || /subprotocol/i.test(text))
      return obsOutcome(id, "incompatible");
    if (
      ["ECONNREFUSED", "ENOTFOUND", "EHOSTUNREACH", "ENETUNREACH"].includes(
        String(code),
      ) ||
      /ECONNREFUSED|ENOTFOUND|EHOSTUNREACH|ENETUNREACH/.test(text)
    )
      return obsOutcome(id, "unreachable");
    if (code === "ETIMEDOUT") return obsOutcome(id, "timeout");
    return obsOutcome(id, "error");
  } finally {
    await client?.dispose();
  }
}

export class ObsTests {
  private active = new Map<string, AbortController>();
  constructor(
    private create?: () => ObsProbeClient,
    private timeoutMs = 5000,
  ) {}
  async test(id: string, url: string, password?: string) {
    if (this.active.has(id) || this.active.size >= 2)
      return obsOutcome(id, "busy");
    const abort = new AbortController();
    this.active.set(id, abort);
    try {
      return await probeObs(
        id,
        url,
        password,
        abort.signal,
        this.create,
        this.timeoutMs,
      );
    } finally {
      this.active.delete(id);
    }
  }
  cancel(id: string) {
    this.active.get(id)?.abort();
  }
  close() {
    for (const abort of this.active.values()) abort.abort();
  }
}
