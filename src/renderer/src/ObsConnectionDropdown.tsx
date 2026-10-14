import { SearchableDropdown } from "./SearchableDropdown";
import { useApp } from "./store";
export function ObsConnectionDropdown({
  value,
  onSelect,
}: {
  value: string;
  onSelect: (id: string) => void;
}) {
  const connections = useApp(
    (state) => state.snapshot?.document.connections ?? [],
  );
  const counts = new Map<string, number>();
  for (const c of connections)
    counts.set(c.name, (counts.get(c.name) ?? 0) + 1);
  return (
    <SearchableDropdown
      label="OBS connection"
      searchLabel="Search OBS connections"
      options={connections.map((c, index) => ({
        id: c.id,
        name:
          (counts.get(c.name) ?? 0) > 1 ? `${c.name} (${index + 1})` : c.name,
        description: c.url,
      }))}
      value={value}
      onSelect={onSelect}
      hideIds
      missingLabel="Connection unavailable — choose a replacement"
      emptyLabel="Choose OBS connection"
    />
  );
}
