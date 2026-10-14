import { SearchableDropdown } from "./SearchableDropdown";
import { useApp } from "./store";

export function NavigationTargetDropdown({
  kind,
  value,
  onSelect,
}: {
  kind: "profile" | "page";
  value: string;
  onSelect: (id: string) => void;
}) {
  const doc = useApp((state) => state.snapshot?.document);
  const deck = doc?.decks.find((deck) => deck.id === doc.activeDeckId);
  const profile = doc?.profiles.find(
    (profile) => profile.id === deck?.activeProfileId,
  );
  const isProfile = kind === "profile";
  const options = isProfile
    ? (doc?.profiles ?? [])
        .filter((profile) => deck?.profileIds.includes(profile.id))
        .map((profile) => ({ id: profile.id, name: profile.name }))
    : (profile?.pages ?? []).map((page) => ({
        id: page.id,
        name: page.name,
        description: page.parentId
          ? `Folder in ${profile?.pages.find((parent) => parent.id === page.parentId)?.name ?? "missing page"}`
          : "Page",
      }));
  return (
    <SearchableDropdown
      key={`${kind}:${deck?.id}:${profile?.id}`}
      label={isProfile ? "Target profile" : "Page / folder"}
      searchLabel={isProfile ? "Search profiles" : "Search pages and folders"}
      options={options}
      value={value}
      onSelect={onSelect}
      emptyLabel={isProfile ? "Choose profile" : "Choose page or folder"}
      missingLabel={
        isProfile
          ? "Profile unavailable — choose a replacement"
          : "Page / folder unavailable — choose a replacement"
      }
    />
  );
}
