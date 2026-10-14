import { useId, useLayoutEffect, useRef, useState } from "react";
import {
  iconSvg,
  iconToken,
  resolveIcon,
  searchIcons,
} from "../../shared/icons";
import "./icons.css";

export function IconPicker({
  value,
  onSelect,
}: {
  value: string;
  onSelect: (value: string) => void;
}) {
  const id = useId(),
    search = useRef<HTMLInputElement>(null),
    trigger = useRef<HTMLButtonElement>(null),
    activeRow = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false),
    [query, setQuery] = useState(""),
    [activeName, setActiveName] = useState("");
  const resolved = resolveIcon(value),
    results = searchIcons(query);
  const active = results.find((icon) => icon.name === activeName) ?? results[0];
  const name =
    resolved.kind === "custom"
      ? value
        ? "Custom text"
        : "None"
      : resolved.available
        ? resolved.icon.label
        : "Unavailable icon";
  const close = () => {
    setOpen(false);
    trigger.current?.focus();
  };
  const choose = (token: string) => {
    onSelect(token);
    close();
  };
  useLayoutEffect(() => {
    if (open) search.current?.focus();
  }, [open]);
  useLayoutEffect(() => {
    if (open) activeRow.current?.scrollIntoView({ block: "nearest" });
  }, [open, active?.name]);
  return (
    <div
      className="key-icon-picker"
      onBlur={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget)) setOpen(false);
      }}
    >
      <span className="field-label">Icon</span>
      <button
        ref={trigger}
        type="button"
        aria-label={`Lucide icon: ${name}`}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={open ? `${id}-list` : undefined}
        onClick={() => {
          if (open) close();
          else {
            setQuery("");
            setActiveName(resolved.kind === "pack" ? resolved.icon.name : "");
            setOpen(true);
          }
        }}
      >
        Lucide · {name}
      </button>
      {open && (
        <div className="key-icon-picker-panel">
          <input
            ref={search}
            role="combobox"
            aria-label="Search Lucide icons"
            aria-autocomplete="list"
            aria-expanded="true"
            aria-controls={`${id}-list`}
            aria-activedescendant={active ? `${id}-${active.name}` : undefined}
            placeholder="Search icons…"
            value={query}
            onChange={(event) => {
              setQuery(event.target.value);
              setActiveName("");
            }}
            onKeyDown={(event) => {
              if (event.key === "Escape") {
                event.preventDefault();
                close();
              } else if (event.key === "Enter") {
                event.preventDefault();
                if (active) choose(iconToken(active));
              } else if (
                ["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)
              ) {
                event.preventDefault();
                const index = results.findIndex(
                  (icon) => icon.name === active?.name,
                );
                const next =
                  event.key === "Home"
                    ? 0
                    : event.key === "End"
                      ? results.length - 1
                      : index + (event.key === "ArrowDown" ? 1 : -1);
                setActiveName(
                  results[Math.max(0, Math.min(results.length - 1, next))]
                    ?.name ?? "",
                );
              }
            }}
          />
          <div
            id={`${id}-list`}
            role="listbox"
            aria-label="Lucide icons"
            className="key-icon-picker-options"
          >
            {results.map((icon) => (
              <div
                key={icon.name}
                id={`${id}-${icon.name}`}
                ref={icon.name === active?.name ? activeRow : undefined}
                role="option"
                aria-selected={value === iconToken(icon)}
                className={icon.name === active?.name ? "highlighted" : ""}
                onMouseDown={(event) => event.preventDefault()}
                onMouseMove={() => setActiveName(icon.name)}
                onClick={() => choose(iconToken(icon))}
              >
                <span
                  aria-hidden="true"
                  dangerouslySetInnerHTML={{
                    __html: iconSvg(iconToken(icon))!,
                  }}
                />
                {icon.label}
              </div>
            ))}
          </div>
          {!results.length && <p role="status">No icons match your search.</p>}
        </div>
      )}
      {resolved.kind === "pack" && !resolved.available && (
        <small role="status">
          This icon is unavailable. Choose an icon or enter custom text.
        </small>
      )}
      <label className="icon-custom">
        Custom text / emoji
        <input
          aria-label="Icon"
          maxLength={100}
          value={resolved.kind === "custom" ? value : ""}
          placeholder="Text or emoji"
          onChange={(event) => onSelect(event.target.value)}
        />
      </label>
      <button
        type="button"
        onClick={() => {
          onSelect("");
          setOpen(false);
        }}
      >
        Clear icon
      </button>
    </div>
  );
}
