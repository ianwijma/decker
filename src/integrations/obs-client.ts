import OBSWebSocket from "obs-websocket-js/json";
import { withCancellation } from "../runtime/cancellation";

// obs-websocket-js exposes its socket/cleanup as protected extension points.
// A peer that never finishes a close handshake must not retain a test socket.
export class DisposableObsClient extends OBSWebSocket {
  async dispose() {
    try {
      await withCancellation(this.disconnect(), AbortSignal.timeout(250), 0);
    } catch {
      const socket = this.socket as
        (WebSocket & { terminate?: () => void }) | undefined;
      socket?.terminate?.();
    } finally {
      this.cleanup();
      this.removeAllListeners();
    }
  }
}
