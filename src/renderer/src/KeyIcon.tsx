import { packKeySvg } from "../../shared/icons";
import "./icons.css";

export function KeyIcon({
  icon,
  label,
  fallback = "✦",
}: {
  icon: string;
  label: string;
  fallback?: string;
}) {
  const svg = packKeySvg(icon, label);
  return svg ? (
    <span
      className="pack-key-visual"
      aria-hidden="true"
      dangerouslySetInnerHTML={{ __html: svg }}
    />
  ) : (
    <span className="key-symbol">{icon || fallback}</span>
  );
}
