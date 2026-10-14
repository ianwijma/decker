import type { DeviceStatus } from "./schema";

export function deviceStatusLabel(device?: DeviceStatus) {
  if (!device) return "Disconnected";
  if (device.simulated) return "Simulator mode";
  return {
    discovered: "Not configured",
    opening: "Opening",
    ready: "Ready",
    "permission-denied": "Permission required",
    busy: "Device busy",
    "open-error": "Cannot open device",
    "io-error": "I/O error",
    disconnected: "Disconnected",
  }[device.state];
}
