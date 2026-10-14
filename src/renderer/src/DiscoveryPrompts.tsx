import { Usb } from "lucide-react";
import type { Snapshot } from "../../shared/schema";
import { discoverDevices } from "./home-health";
import "./home.css";

export function DiscoveryPrompts({
  snapshot,
  onAdd,
}: {
  snapshot: Snapshot;
  onAdd: (deviceId: string) => void;
}) {
  return discoverDevices(snapshot).map((device) => (
    <button
      key={device.id}
      className="discovery-prompt"
      aria-label={`New Stream Deck detected — Add: ${device.name} (${device.id})`}
      title={`${device.name} · ${device.id}`}
      onClick={() => onAdd(device.id)}
    >
      <Usb size={19} aria-hidden="true" />
      <span>
        New Stream Deck detected — <strong>Add</strong>
      </span>
      <small>{device.id}</small>
    </button>
  ));
}
