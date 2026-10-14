import { useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import { ChevronDown } from "lucide-react";
import "./searchable-dropdown.css";

export type SearchableOption = {
  id: string;
  name: string;
  description?: string;
};

export function SearchableDropdown({
  label,
  searchLabel,
  options,
  value,
  onSelect,
}: {
  label: string;
  searchLabel: string;
  options: SearchableOption[];
  value?: string;
  onSelect: (id: string) => void;
}) {
  const id = useId(),
    root = useRef<HTMLDivElement>(null),
    trigger = useRef<HTMLButtonElement>(null),
    search = useRef<HTMLInputElement>(null),
    activeRow = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false),
    [query, setQuery] = useState(""),
    [activeId, setActiveId] = useState(value);
  const selected = options.find((option) => option.id === value);
  const filtered = options.filter((option) =>
    option.name.toLowerCase().includes(query.trim().toLowerCase()),
  );
  const active =
    filtered.find((option) => option.id === activeId) ?? filtered[0];
  const names = new Map<string, number>(),
    optionIds = new Map(
      options.map((option, index) => [option.id, `${id}-option-${index}`]),
    );
  for (const option of options)
    names.set(option.name, (names.get(option.name) ?? 0) + 1);
  const rowId = (option: SearchableOption) => optionIds.get(option.id);
  const close = (returnFocus = false) => {
    setOpen(false);
    if (returnFocus) trigger.current?.focus();
  };
  const show = () => {
    setQuery("");
    setActiveId(value);
    setOpen(true);
  };
  const choose = (option: SearchableOption) => {
    onSelect(option.id);
    close(true);
  };
  useLayoutEffect(() => {
    if (open) search.current?.focus();
  }, [open]);
  useLayoutEffect(() => {
    if (open) activeRow.current?.scrollIntoView({ block: "nearest" });
  }, [open, active?.id]);
  useEffect(() => {
    if (!open) return;
    const outside = (event: PointerEvent) => {
      if (!root.current?.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener("pointerdown", outside);
    return () => document.removeEventListener("pointerdown", outside);
  }, [open]);
  return (
    <div
      ref={root}
      className="searchable-dropdown"
      onBlur={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget)) close();
      }}
    >
      <button
        ref={trigger}
        type="button"
        className="searchable-dropdown-trigger"
        aria-label={`${label}: ${selected?.name ?? "None selected"}`}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={open ? `${id}-list` : undefined}
        onClick={() => (open ? close() : show())}
        onKeyDown={(event) => {
          if (event.key === "ArrowDown" || event.key === "ArrowUp") {
            event.preventDefault();
            show();
          }
        }}
      >
        <span>{selected?.name ?? "None selected"}</span>
        <ChevronDown size={16} aria-hidden="true" />
      </button>
      {open && (
        <div className="searchable-dropdown-popup">
          <input
            ref={search}
            role="combobox"
            aria-label={searchLabel}
            aria-autocomplete="list"
            aria-expanded="true"
            aria-controls={`${id}-list`}
            aria-activedescendant={active ? rowId(active) : undefined}
            placeholder={searchLabel}
            value={query}
            onChange={(event) => {
              setQuery(event.target.value);
              setActiveId(undefined);
            }}
            onKeyDown={(event) => {
              if (event.key === "Escape") {
                event.preventDefault();
                close(true);
              } else if (event.key === "Tab" && event.shiftKey) {
                event.preventDefault();
                close(true);
              } else if (event.key === "Enter") {
                event.preventDefault();
                if (active) choose(active);
              } else if (event.key === "ArrowDown" || event.key === "ArrowUp") {
                event.preventDefault();
                const index = filtered.findIndex(
                  (option) => option.id === active?.id,
                );
                const next = event.key === "ArrowDown" ? index + 1 : index - 1;
                setActiveId(
                  filtered[Math.max(0, Math.min(filtered.length - 1, next))]
                    ?.id,
                );
              }
            }}
          />
          <div
            id={`${id}-list`}
            role="listbox"
            tabIndex={-1}
            aria-label={label}
            className="searchable-dropdown-options"
          >
            {filtered.map((option) => (
              <div
                key={option.id}
                id={rowId(option)}
                ref={option.id === active?.id ? activeRow : undefined}
                role="option"
                aria-selected={option.id === value}
                className={`searchable-dropdown-option ${option.id === active?.id ? "highlighted" : ""}`}
                onMouseDown={(event) => event.preventDefault()}
                onClick={() => choose(option)}
                onMouseMove={() => setActiveId(option.id)}
              >
                <span>{option.name}</span>
                {option.description && <small>{option.description}</small>}
                {(names.get(option.name) ?? 0) > 1 && (
                  <small>ID: {option.id}</small>
                )}
              </div>
            ))}
          </div>
          {!filtered.length && (
            <div role="status" className="searchable-dropdown-empty">
              No results
            </div>
          )}
        </div>
      )}
    </div>
  );
}
