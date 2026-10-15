import { useState, useEffect, useRef, useLayoutEffect } from "react";
import {
  Copy,
  FolderPlus,
  Play,
  Plus,
  Trash2,
  ChevronRight,
  Settings2,
  Globe,
  ClipboardPaste,
} from "lucide-react";
import { useApp } from "./store";
import { keySlot, visibleSlot } from "../../shared/decks";
import { DeckOptions, WebConnect } from "./DeckManager";
import { binding, uid } from "../../shared/defaults";
import { buttonAppearance, selectBindingRun } from "../../shared/feedback";
import { deviceStatusLabel } from "../../shared/device-status";
import { actionById } from "../../shared/catalog";
import type { KeyBinding } from "../../shared/schema";
import { Catalog, FieldLabel, TargetEditor } from "./components";
import { SearchableDropdown } from "./SearchableDropdown";
import { selectIcon } from "../../shared/icons";
import { KeyIcon } from "./KeyIcon";
import { IconPicker } from "./IconPicker";
import { ToggleEditor } from "./ToggleEditor";
import { selectToggle, toggleDisplay } from "../../shared/toggle-presentation";
export function Deck() {
  const { snapshot, edit, request } = useApp(),
    doc = snapshot!.document,
    [selected, setSelected] = useState(0),
    [copied, setCopied] = useState<KeyBinding>(),
    [event, setEvent] = useState<"press" | "release" | "longPress">("press"),
    [options, setOptions] = useState(false),
    [connect, setConnect] = useState(false);
  const deck = doc.decks.find((d) => d.id === doc.activeDeckId)!;
  const profile = doc.profiles.find((p) => p.id === deck.activeProfileId)!,
    page = profile.pages.find((p) => p.id === deck.activePageId)!;
  const slot = keySlot(selected, deck.columns),
    key = page.keys[slot];
  const imageEpoch = useRef(0);
  useLayoutEffect(() => {
    imageEpoch.current++;
  }, [
    deck.id,
    page.id,
    slot,
    key?.id,
    key?.generation,
    JSON.stringify(key?.appearance),
  ]);
  const display = key
    ? toggleDisplay(key, selectToggle(snapshot!.toggles ?? [], key, deck.id))
    : undefined;
  const device = snapshot!.devices.find(
    (d) => d.id === (deck.hardwareId ?? deck.id),
  );
  useEffect(() => setSelected(0), [deck.rows, deck.columns]);
  const keys = (fn: (keys: typeof page.keys) => void) =>
    edit((d) =>
      fn(
        d.profiles
          .find((p) => p.id === profile.id)!
          .pages.find((p) => p.id === page.id)!.keys,
      ),
    );
  const update = (fn: (key: KeyBinding) => void) =>
    keys((all) => {
      if (all[slot] && all[slot].id === key?.id) fn(all[slot]);
    });
  const assign = (type: string, index = selected) =>
    keys((all) => {
      all[keySlot(index, deck.columns)] = binding(type, actionById(type)?.name);
      all[keySlot(index, deck.columns)].appearance.icon =
        actionById(type)?.icon ?? "";
    });
  const addPage = (folder: boolean) =>
    edit((d) => {
      const p = d.profiles.find((p) => p.id === profile.id)!,
        id = uid();
      p.pages.push({
        id,
        name: folder ? "New folder" : `Page ${p.pages.length + 1}`,
        parentId: folder ? page.id : undefined,
        keys: folder ? { 0: binding("deck.back", "Back") } : {},
      });
      if (folder) {
        const folderBinding = binding("deck.page", "New folder");
        folderBinding.appearance.icon = "▦";
        folderBinding.press = {
          kind: "action",
          action: { type: "deck.page", version: 1, config: { pageId: id } },
        };
        p.pages.find((p) => p.id === page.id)!.keys[slot] = folderBinding;
      }
      d.decks.find((deck) => deck.id === doc.activeDeckId)!.activePageId = id;
      setSelected(0);
    });
  const latest = key
    ? selectBindingRun(snapshot!.runs, key, deck.id)
    : undefined;
  return (
    <div className="workspace deck-workspace">
      <aside className="secondary-sidebar">
        <div className="workspace-label">
          <span className="workspace-avatar">D</span>
          <div>
            <strong>Your workspace</strong>
            <small>Local · personal</small>
          </div>
        </div>
        <div className="section-heading">
          PROFILES
          <button
            className="icon-button"
            aria-label="Add profile"
            onClick={() => {
              const id = uid(),
                pageId = uid();
              edit((d) => {
                d.profiles.push({
                  id,
                  name: `Profile ${d.profiles.length + 1}`,
                  pages: [{ id: pageId, name: "Home", keys: {} }],
                });
                const deck = d.decks.find(
                  (deck) => deck.id === doc.activeDeckId,
                )!;
                deck.profileIds.push(id);
              });
              void request({
                type: "navigate",
                deckId: deck.id,
                profileId: id,
                pageId,
              });
            }}
          >
            <Plus size={16} />
          </button>
        </div>
        <SearchableDropdown
          label="Profile"
          searchLabel="Search profiles"
          options={doc.profiles
            .filter((p) => deck.profileIds.includes(p.id))
            .map((p) => ({
              id: p.id,
              name: p.name,
              description: `${p.pages.length} pages`,
            }))}
          value={profile.id}
          onSelect={(id) => {
            const next = doc.profiles.find((p) => p.id === id)!;
            void request({
              type: "navigate",
              deckId: deck.id,
              profileId: next.id,
              pageId: next.pages[0].id,
            });
          }}
        />
        <div className="sidebar-divider" />
        <Catalog onPick={assign} />
        <div className="sidebar-tip">
          Make it yours
          <br />
          <small>
            Drag an action onto a key, or select a key and choose an action.
          </small>
        </div>
      </aside>
      <main className="deck-main">
        <div className="page-heading">
          <div>
            <div className="eyebrow">YOUR CONTROL ROOM</div>
            <h1>Everything, a key away.</h1>
            <p>Build a workspace that works the way you do.</p>
          </div>
          <span className="tag">
            {(deck.kind !== "hardware" || device?.state === "ready") && (
              <span className="status-dot" />
            )}
            {deck.kind === "web"
              ? snapshot!.web.running
                ? "Web deck ready"
                : "Sharing paused"
              : deck.kind === "simulator"
                ? "Simulator mode"
                : deviceStatusLabel(device)}
          </span>
        </div>
        {deck.kind === "hardware" && device?.error && (
          <div role="status">
            <p>{device.error}</p>
            <button
              onClick={() =>
                void request({ type: "retryDevice", hardwareId: device.id })
              }
            >
              Retry device
            </button>
          </div>
        )}
        <div className="deck-toolbar">
          <span className="inline-label">
            {deck.icon} <strong>{deck.name}</strong>
          </span>
          <button aria-label="Deck settings" onClick={() => setOptions(true)}>
            <Settings2 size={15} />
          </button>
          {deck.kind === "web" && (
            <button
              onClick={() => setConnect(true)}
              disabled={!snapshot!.web.running}
            >
              <Globe size={15} /> Connect browser
            </button>
          )}
          <div className="grow" />
          <span className="muted small">
            {deck.columns} × {deck.rows} keys
          </span>
        </div>
        <div className="deck-device">
          <div className="deck-brand">
            {deck.kind === "web" ? "WEB DECK" : "STREAM DECK"}{" "}
            <span>{deck.kind === "simulator" ? "SIMULATOR" : ""}</span>
          </div>
          <div
            className="key-grid"
            style={{
              gridTemplateColumns: `repeat(${deck.columns},minmax(0,1fr))`,
            }}
          >
            {Array.from({ length: deck.rows * deck.columns }, (_, index) => {
              const original = page.keys[keySlot(index, deck.columns)];
              const b = original
                  ? {
                      ...original,
                      appearance: buttonAppearance(
                        original,
                        snapshot!.observed,
                        doc.settings.accent,
                        deck.id,
                        snapshot!.toggles,
                      ),
                    }
                  : undefined,
                run = b
                  ? selectBindingRun(snapshot!.runs, b, deck.id)
                  : undefined;
              const toggle = b
                ? toggleDisplay(
                    b,
                    selectToggle(snapshot!.toggles ?? [], b, deck.id),
                  )
                : undefined;
              return (
                <button
                  key={index}
                  aria-label={`Key ${index + 1}${b ? `: ${b.appearance.label}` : ""}${toggle ? ` · ${toggle.summary}` : ""}`}
                  aria-pressed={toggle ? undefined : selected === index}
                  aria-current={
                    toggle && selected === index ? "true" : undefined
                  }
                  aria-busy={toggle?.busy || run?.status === "running"}
                  className={`deck-key ${selected === index ? "selected" : ""} ${run?.status === "running" ? "running" : ""}`}
                  style={{ backgroundColor: b?.appearance.background }}
                  onClick={() => setSelected(index)}
                  onDoubleClick={() =>
                    b &&
                    (!toggle ||
                      (!toggle.disabled && !useApp.getState().saving)) &&
                    void request({ type: "test", deckId: deck.id, binding: b })
                  }
                  onDragOver={(e) => e.preventDefault()}
                  onDrop={(e) => {
                    e.preventDefault();
                    const type = e.dataTransfer.getData("decker/action");
                    if (actionById(type)) {
                      setSelected(index);
                      assign(type, index);
                    }
                  }}
                >
                  {b?.appearance.asset ? (
                    <img alt="" src={`decker-asset://${b.appearance.asset}`} />
                  ) : (
                    <KeyIcon
                      icon={b?.appearance.icon ?? ""}
                      label={b?.appearance.label ?? ""}
                      fallback={
                        b?.toggle
                          ? ""
                          : ((b?.press?.kind === "action"
                              ? actionById(b.press.action.type)?.icon
                              : b
                                ? "⑂"
                                : "+") ?? "✦")
                      }
                    />
                  )}
                  <span className="key-label">{b?.appearance.label ?? ""}</span>
                  {b?.appearance.stateLabel && (
                    <small className="toggle-key-state">
                      {b.appearance.stateLabel}
                    </small>
                  )}
                  <span className="key-index">
                    {String(index + 1).padStart(2, "0")}
                  </span>
                  {run && <i className={`key-state ${run.status}`} />}
                </button>
              );
            })}
          </div>
          <div className="device-foot">
            <span />
            <span>decker</span>
            <span />
          </div>
        </div>
        <div className="page-tabs">
          {profile.pages
            .filter(
              (p) => !p.parentId || p.id === page.id || p.id === page.parentId,
            )
            .map((p) => (
              <button
                key={p.id}
                className={p.id === page.id ? "active" : ""}
                onClick={() =>
                  void request({
                    type: "navigate",
                    deckId: deck.id,
                    profileId: profile.id,
                    pageId: p.id,
                  })
                }
              >
                {p.parentId && <ChevronRight size={12} />} {p.name}
              </button>
            ))}
          <button aria-label="Add page" onClick={() => addPage(false)}>
            <Plus size={16} />
          </button>
        </div>
        <div className="deck-bottom">
          <div>
            <strong>
              {profile.name} <ChevronRight size={13} /> {page.name}
            </strong>
            <p>
              {Object.keys(page.keys).length} keys configured · Double-click a
              key to test
            </p>
          </div>
          <button onClick={() => addPage(true)}>
            <FolderPlus size={16} /> New folder
          </button>
        </div>
        <details className="page-management">
          <summary>Manage profile & page</summary>
          <div className="two-columns">
            <FieldLabel label="Profile name">
              <input
                aria-label="Profile name"
                value={profile.name}
                onChange={(e) =>
                  edit((d) => {
                    d.profiles.find((p) => p.id === profile.id)!.name =
                      e.target.value || "Untitled";
                  })
                }
              />
            </FieldLabel>
            <FieldLabel label="Page name">
              <input
                aria-label="Page name"
                value={page.name}
                onChange={(e) =>
                  edit((d) => {
                    d.profiles
                      .find((p) => p.id === profile.id)!
                      .pages.find((p) => p.id === page.id)!.name =
                      e.target.value || "Untitled";
                  })
                }
              />
            </FieldLabel>
          </div>
          <div className="row">
            <button
              disabled={
                profile.pages.length === 1 ||
                profile.pages.some((p) => p.parentId === page.id)
              }
              onClick={() =>
                edit((d) => {
                  const p = d.profiles.find((p) => p.id === profile.id)!;
                  p.pages = p.pages.filter((x) => x.id !== page.id);
                  d.decks.find(
                    (deck) => deck.id === doc.activeDeckId,
                  )!.activePageId = p.pages[0].id;
                })
              }
            >
              Delete page
            </button>
            <button
              disabled={deck.profileIds.length === 1}
              onClick={() =>
                edit((d) => {
                  d.profiles = d.profiles.filter((p) => p.id !== profile.id);
                  const deck = d.decks.find(
                    (deck) => deck.id === doc.activeDeckId,
                  )!;
                  deck.profileIds = deck.profileIds.filter(
                    (id) => id !== profile.id,
                  );
                  deck.activeProfileId = deck.profileIds[0];
                  deck.activePageId = d.profiles.find(
                    (p) => p.id === deck.activeProfileId,
                  )!.pages[0].id;
                })
              }
            >
              Delete profile
            </button>
          </div>
          <small className="muted">
            Profile ID: {profile.id}
            <br />
            Page ID: {page.id}
          </small>
        </details>
        {Object.keys(page.keys).some(
          (slot) => !visibleSlot(Number(slot), deck.rows, deck.columns),
        ) && (
          <p className="muted small">
            This page has saved assignments outside the current grid. Expand the
            layout in Deck settings to restore them.
          </p>
        )}
      </main>
      <aside className="inspector">
        <div className="inspector-title">
          <div>
            <span className="eyebrow">KEY PROPERTIES</span>
            <h2>Key {String(selected + 1).padStart(2, "0")}</h2>
          </div>
          <div className="row">
            <button
              className="icon-button"
              title="Copy key"
              aria-label="Copy key"
              disabled={!key}
              onClick={() => setCopied(structuredClone(key))}
            >
              <Copy size={16} />
            </button>
            <button
              className="icon-button"
              title="Paste key"
              aria-label="Paste key"
              disabled={!copied}
              onClick={() =>
                keys((all) => {
                  all[slot] = {
                    ...structuredClone(copied!),
                    id: uid(),
                    generation: 0,
                  };
                })
              }
            >
              <ClipboardPaste size={16} />
            </button>
            <button
              className="icon-button"
              title="Clear key"
              aria-label="Clear key"
              disabled={!key}
              onClick={() =>
                keys((all) => {
                  delete all[slot];
                })
              }
            >
              <Trash2 size={16} />
            </button>
          </div>
        </div>
        {key ? (
          <>
            {key.toggle && <small>Authored base preview</small>}
            <div
              className="selected-key-preview"
              style={{ backgroundColor: key.appearance.background }}
            >
              {key.appearance.asset ? (
                <img
                  alt="Key icon"
                  src={`decker-asset://${key.appearance.asset}`}
                />
              ) : (
                <KeyIcon
                  icon={key.appearance.icon}
                  label={key.appearance.label}
                  fallback={key.toggle ? "" : undefined}
                />
              )}
              <small>{key.appearance.label}</small>
            </div>
            <FieldLabel label="Label">
              <input
                aria-label="Label"
                value={key.appearance.label}
                onChange={(e) =>
                  update((k) => {
                    k.appearance.label = e.target.value;
                  })
                }
              />
            </FieldLabel>
            <IconPicker
              key={key.id}
              value={key.appearance.icon}
              onSelect={(icon) => update((k) => selectIcon(k.appearance, icon))}
            />
            <div className="two-columns">
              <FieldLabel label="Background">
                <input
                  aria-label="Background"
                  type="color"
                  value={key.appearance.background}
                  onChange={(e) =>
                    update((k) => {
                      k.appearance.background = e.target.value;
                    })
                  }
                />
              </FieldLabel>
            </div>
            <button
              className="wide"
              onClick={async () => {
                const token = ++imageEpoch.current;
                const asset = await request({ type: "asset" });
                if (imageEpoch.current === token && typeof asset === "string")
                  update((k) => {
                    k.appearance.asset = asset;
                  });
              }}
            >
              Choose image…
            </button>
            {key.appearance.asset && (
              <button
                onClick={() =>
                  update((k) => {
                    delete k.appearance.asset;
                  })
                }
              >
                Remove image
              </button>
            )}
            <ToggleEditor
              key={`${deck.id}:${page.id}:${slot}:${key.id}:${key.generation}`}
              binding={key}
              deckId={deck.id}
              onSave={update}
            />
            {!key.toggle && (
              <>
                <div className="segmented">
                  {(["press", "release", "longPress"] as const).map((type) => (
                    <button
                      key={type}
                      className={event === type ? "active" : ""}
                      onClick={() => setEvent(type)}
                    >
                      {type === "longPress"
                        ? "Hold"
                        : type === "press"
                          ? "Press"
                          : "Release"}
                    </button>
                  ))}
                </div>
                <TargetEditor
                  target={key[event]}
                  workflows={doc.workflows}
                  onChange={(target) =>
                    update((k) => {
                      k[event] = target;
                    })
                  }
                />
              </>
            )}
            {!key.toggle && (
              <details>
                <summary>Behaviour & feedback</summary>
                <FieldLabel label="Repeated presses">
                  <select
                    aria-label="Repeated presses"
                    value={key.policy}
                    onChange={(e) =>
                      update((k) => {
                        k.policy = e.target.value as KeyBinding["policy"];
                      })
                    }
                  >
                    <option value="ignore">Ignore while running</option>
                    <option value="queue">Bounded FIFO queue</option>
                    <option value="restart">Cancel then restart</option>
                    <option value="concurrent">Bounded concurrent runs</option>
                  </select>
                </FieldLabel>
                <FieldLabel label="Queue / concurrency limit">
                  <input
                    type="number"
                    min={1}
                    max={16}
                    value={key.limit}
                    onChange={(e) =>
                      update((k) => {
                        k.limit = Number(e.target.value);
                      })
                    }
                  />
                </FieldLabel>
                <FieldLabel label="Hold threshold (ms)">
                  <input
                    type="number"
                    min={200}
                    max={10000}
                    value={key.longPressMs}
                    onChange={(e) =>
                      update((k) => {
                        k.longPressMs = Number(e.target.value);
                      })
                    }
                  />
                </FieldLabel>
                <small className="muted">
                  When a hold action exists, short press runs on release.
                  Release uses the original binding.
                </small>
                {(["success", "error"] as const).map((state) => (
                  <FieldLabel label={`${state} colour`} key={state}>
                    <input
                      type="color"
                      value={key.appearance[state]}
                      onChange={(e) =>
                        update((k) => {
                          k.appearance[state] = e.target.value;
                        })
                      }
                    />
                  </FieldLabel>
                ))}
              </details>
            )}
            {!key.toggle && (
              <button
                className="primary wide"
                onClick={() =>
                  void request({ type: "test", deckId: deck.id, binding: key })
                }
              >
                <Play size={16} /> Test action
              </button>
            )}
            {deck.kind === "simulator" && (
              <button
                className="wide"
                disabled={display?.disabled || useApp.getState().saving}
                onPointerDown={(e) => {
                  e.currentTarget.setPointerCapture(e.pointerId);
                  void request({
                    type: "press",
                    deckId: deck.id,
                    key: selected,
                    down: true,
                  });
                }}
                onPointerUp={() =>
                  void request({
                    type: "press",
                    deckId: deck.id,
                    key: selected,
                    down: false,
                  })
                }
                onPointerCancel={() =>
                  void request({
                    type: "press",
                    deckId: deck.id,
                    key: selected,
                    down: false,
                  })
                }
              >
                Hold simulated key
              </button>
            )}
            <div className="key-run-status">
              {latest ? `Last run: ${latest.status}` : "Ready when you are"}
              <small>Policy: {key.policy}</small>
            </div>
            <button
              className="wide"
              onClick={() => {
                const empty = Array.from(
                  { length: deck.rows * deck.columns },
                  (_, i) => i,
                ).find((i) => !page.keys[keySlot(i, deck.columns)]);
                if (empty !== undefined)
                  keys((all) => {
                    all[keySlot(empty, deck.columns)] = {
                      ...structuredClone(key),
                      id: uid(),
                      generation: 0,
                    };
                    setSelected(empty);
                  });
              }}
            >
              Duplicate to empty key
            </button>
          </>
        ) : (
          <div className="empty-inspector">
            <span>＋</span>
            <h3>A little space for a big idea.</h3>
            <p>Choose an action from the library or drag it onto this key.</p>
          </div>
        )}
      </aside>
      {options && <DeckOptions deck={deck} onClose={() => setOptions(false)} />}
      {connect && <WebConnect deck={deck} onClose={() => setConnect(false)} />}
    </div>
  );
}
