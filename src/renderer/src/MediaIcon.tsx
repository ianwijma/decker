import { iconSvg } from "../../shared/icons";

/** Media palette tiles use the same bundled geometry as their assigned keys. */
export function MediaIcon({ icon }: { icon: string }) {
  return (
    <img
      alt=""
      width={18}
      height={18}
      src={`data:image/svg+xml,${encodeURIComponent(iconSvg(icon)!)}`}
    />
  );
}
