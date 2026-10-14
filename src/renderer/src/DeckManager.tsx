import { useEffect, useRef, useState, type ReactNode } from "react";
import { X, Usb, Globe, Plus, Check, Copy, ExternalLink } from "lucide-react";
import QRCode from "qrcode";
import { useApp } from "./store";
import { FieldLabel } from "./components";
import { visibleSlot } from "../../shared/decks";
import type { DeckConfig } from "../../shared/schema";
const icons = [
  "▦",
  "🎛",
  "🎮",
  "💻",
  "📱",
  "🎬",
  "🎵",
  "🚀",
  "⚡",
  "🛠",
  "🏠",
  "✦",
];
export function Modal({
  title,
  onClose,
  children,
}: {
  title: string;
  onClose: () => void;
  children: ReactNode;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  useEffect(() => {
    const previous = document.activeElement as HTMLElement;
    const root = ref.current;
    root?.querySelector<HTMLElement>("input,button,select")?.focus();
    const keydown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        closeRef.current();
      }
      if (e.key === "Tab" && root) {
        const controls = Array.from(
          root.querySelectorAll<HTMLElement>(
            "button:not(:disabled),input:not(:disabled),select:not(:disabled),textarea:not(:disabled),a[href]",
          ),
        ).filter((x) => x.offsetParent !== null);
        const first = controls[0],
          last = controls.at(-1);
        if (e.shiftKey && document.activeElement === first) {
          e.preventDefault();
          last?.focus();
        } else if (!e.shiftKey && document.activeElement === last) {
          e.preventDefault();
          first?.focus();
        }
      }
    };
    document.addEventListener("keydown", keydown);
    return () => {
      document.removeEventListener("keydown", keydown);
      previous?.focus();
    };
  }, []);
  return (
    <div
      className="modal-backdrop"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        className="modal"
        role="dialog"
        aria-modal="true"
        aria-label={title}
        ref={ref}
      >
        <div className="card-heading">
          <h2>{title}</h2>
          <button
            aria-label="Close dialog"
            className="icon-button"
            onClick={onClose}
          >
            <X size={19} />
          </button>
        </div>
        {children}
      </div>
    </div>
  );
}
function IconPicker({
  icon,
  setIcon,
}: {
  icon: string;
  setIcon: (icon: string) => void;
}) {
  return (
    <div className="icon-picker" aria-label="Deck icons">
      {icons.map((i) => (
        <button
          key={i}
          aria-label={`Deck icon ${i}`}
          aria-pressed={icon === i}
          className={icon === i ? "active" : ""}
          onClick={() => setIcon(i)}
        >
          {i}
        </button>
      ))}
      <FieldLabel label="Custom icon">
        <input
          aria-label="Custom icon"
          value={icon}
          maxLength={20}
          onChange={(e) => setIcon(e.target.value)}
        />
      </FieldLabel>
    </div>
  );
}
export function AddDeck({ onClose }: { onClose: () => void }) {
  const { snapshot, request, setTab } = useApp(),
    [kind, setKind] = useState<"hardware" | "web" | "simulator">("hardware"),
    [name, setName] = useState("My web deck"),
    [icon, setIcon] = useState("📱"),
    [rows, setRows] = useState(3),
    [columns, setColumns] = useState(5),
    [busy, setBusy] = useState(false);
  useEffect(() => {
    void request({ type: "diagnose" });
  }, [request]);
  const available = snapshot!.devices.filter(
    (d) =>
      !d.simulated &&
      !snapshot!.document.decks.some((deck) => deck.hardwareId === d.id),
  );
  const add = async (hardware?: (typeof available)[number]) => {
    setBusy(true);
    const result = await request({
      type: "addDeck",
      kind,
      name: hardware?.name ?? name.trim(),
      icon: kind === "hardware" ? "🎛" : icon,
      rows: hardware?.rows ?? rows,
      columns: hardware?.columns ?? columns,
      hardwareId: hardware?.id,
    });
    setBusy(false);
    if (result) {
      setTab("deck");
      onClose();
    }
  };
  return (
    <Modal title="Add deck" onClose={onClose}>
      <div className="segmented">
        <button
          className={kind === "hardware" ? "active" : ""}
          onClick={() => setKind("hardware")}
        >
          <Usb size={15} /> Stream Deck
        </button>
        <button
          className={kind === "web" ? "active" : ""}
          onClick={() => setKind("web")}
        >
          <Globe size={15} /> Web deck
        </button>
        <button
          className={kind === "simulator" ? "active" : ""}
          onClick={() => setKind("simulator")}
        >
          Simulator
        </button>
      </div>
      {kind === "hardware" ? (
        <>
          <p className="muted modal-description">
            Looking for a new Stream Deck… Connect it by USB. Existing decks
            stay in your sidebar when unplugged.
          </p>
          {available.length ? (
            available.map((device) => (
              <div className="discovered-deck" key={device.id}>
                <Usb size={24} />
                <div>
                  <strong>{device.name}</strong>
                  <small>
                    {device.rows} × {device.columns} · {device.id}
                  </small>
                </div>
                <button
                  className="primary"
                  disabled={busy || device.id.startsWith("session:")}
                  onClick={() => void add(device)}
                >
                  Add Stream Deck
                </button>
                {device.id.startsWith("session:") && (
                  <small>
                    A serial number is required to identify this deck reliably.
                  </small>
                )}
              </div>
            ))
          ) : (
            <div className="empty-state">
              <Usb size={30} />
              <h3>No new Stream Deck found</h3>
              <p>You can create a web deck while waiting for hardware.</p>
            </div>
          )}
          <button onClick={() => void request({ type: "diagnose" })}>
            Scan again
          </button>
        </>
      ) : (
        <>
          <FieldLabel label="Deck name">
            <input
              aria-label="Deck name"
              value={name}
              maxLength={80}
              onChange={(e) => setName(e.target.value)}
            />
          </FieldLabel>
          <IconPicker icon={icon} setIcon={setIcon} />
          <div className="two-columns">
            <FieldLabel label="Rows">
              <input
                aria-label="Rows"
                type="number"
                min={1}
                max={16}
                value={rows}
                onChange={(e) => setRows(Number(e.target.value))}
              />
            </FieldLabel>
            <FieldLabel label="Columns">
              <input
                aria-label="Columns"
                type="number"
                min={1}
                max={16}
                value={columns}
                onChange={(e) => setColumns(Number(e.target.value))}
              />
            </FieldLabel>
          </div>
          <div className="row presets">
            {[
              [2, 3],
              [3, 5],
              [4, 8],
            ].map(([r, c]) => (
              <button
                key={r}
                onClick={() => {
                  setRows(r);
                  setColumns(c);
                }}
              >
                {r} × {c}
              </button>
            ))}
          </div>
          <div
            className="mini-grid"
            style={{
              gridTemplateColumns: `repeat(${Math.max(1, Math.min(columns, 16))},1fr)`,
            }}
          >
            {Array.from(
              {
                length:
                  Math.max(1, Math.min(rows, 16)) *
                  Math.max(1, Math.min(columns, 16)),
              },
              (_, i) => (
                <span key={i} />
              ),
            )}
          </div>
          <p className="muted small">
            {kind === "web"
              ? "Creating a web deck enables local-network sharing. Pair a phone or tablet to operate it; configure keys here. Use a trusted network: LAN transport currently uses HTTP."
              : "A software deck for testing without physical hardware."}
          </p>
          <button
            className="primary wide"
            disabled={
              busy ||
              !name.trim() ||
              !Number.isInteger(rows) ||
              !Number.isInteger(columns) ||
              rows < 1 ||
              columns < 1 ||
              rows > 16 ||
              columns > 16
            }
            onClick={() => void add()}
          >
            <Plus size={16} /> Create{" "}
            {kind === "web" ? "web deck" : "simulator"}
          </button>
        </>
      )}
    </Modal>
  );
}
export function DeckOptions({
  deck,
  onClose,
}: {
  deck: DeckConfig;
  onClose: () => void;
}) {
  const { snapshot, edit, request } = useApp(),
    [rows, setRows] = useState(deck.rows),
    [columns, setColumns] = useState(deck.columns),
    [remove, setRemove] = useState(false),
    [profile, setProfile] = useState("");
  const update = (fn: (d: DeckConfig) => void) =>
    edit((document) => fn(document.decks.find((d) => d.id === deck.id)!));
  const affected = snapshot!.document.profiles
    .filter((p) => deck.profileIds.includes(p.id))
    .flatMap((p) => p.pages)
    .reduce(
      (count, page) =>
        count +
        Object.keys(page.keys).filter(
          (slot) => !visibleSlot(Number(slot), rows, columns),
        ).length,
      0,
    );
  return (
    <Modal title="Deck settings" onClose={onClose}>
      <FieldLabel label="Deck name">
        <input
          aria-label="Deck name"
          value={deck.name}
          onChange={(e) =>
            update((d) => {
              d.name = e.target.value || "Untitled deck";
            })
          }
        />
      </FieldLabel>
      <IconPicker
        icon={deck.icon}
        setIcon={(icon) =>
          update((d) => {
            d.icon = icon;
          })
        }
      />
      <button
        onClick={async () => {
          const asset = await request({ type: "asset" });
          if (typeof asset === "string")
            update((d) => {
              d.asset = asset;
            });
        }}
      >
        Upload deck icon…
      </button>
      {deck.asset && (
        <button
          onClick={() =>
            update((d) => {
              delete d.asset;
            })
          }
        >
          Remove image icon
        </button>
      )}
      {deck.kind !== "hardware" ? (
        <>
          <div className="two-columns">
            <FieldLabel label="Rows">
              <input
                aria-label="Rows"
                type="number"
                min={1}
                max={16}
                value={rows}
                onChange={(e) => setRows(Number(e.target.value))}
              />
            </FieldLabel>
            <FieldLabel label="Columns">
              <input
                aria-label="Columns"
                type="number"
                min={1}
                max={16}
                value={columns}
                onChange={(e) => setColumns(Number(e.target.value))}
              />
            </FieldLabel>
          </div>
          <p className="muted small">
            {affected
              ? `${affected} assignments will be outside this layout. They remain saved and reappear when you expand the grid.`
              : "All assignments fit inside this layout."}
          </p>
          <button
            disabled={
              !Number.isInteger(rows) ||
              !Number.isInteger(columns) ||
              rows < 1 ||
              columns < 1 ||
              rows > 16 ||
              columns > 16 ||
              (rows === deck.rows && columns === deck.columns)
            }
            onClick={() =>
              update((d) => {
                d.rows = rows;
                d.columns = columns;
              })
            }
          >
            Apply layout
          </button>
        </>
      ) : (
        <FieldLabel label={`Brightness · ${deck.brightness}%`}>
          <input
            aria-label="Deck brightness"
            type="range"
            min={0}
            max={100}
            value={deck.brightness}
            onChange={(e) =>
              update((d) => {
                d.brightness = Number(e.target.value);
              })
            }
          />
        </FieldLabel>
      )}
      <details>
        <summary>Copy a profile into this deck</summary>
        <select
          aria-label="Profile to copy"
          value={profile}
          onChange={(e) => setProfile(e.target.value)}
        >
          <option value="">Choose profile</option>
          {snapshot!.document.profiles.map((p) => (
            <option key={p.id} value={p.id}>
              {
                snapshot!.document.decks.find((d) =>
                  d.profileIds.includes(p.id),
                )?.name
              }{" "}
              / {p.name}
            </option>
          ))}
        </select>
        <button
          disabled={!profile}
          onClick={() =>
            void request({
              type: "copyProfile",
              fromProfileId: profile,
              toDeckId: deck.id,
            })
          }
        >
          <Copy size={14} /> Copy profile
        </button>
      </details>
      <details>
        <summary>Remove deck</summary>
        <p className="muted small">
          Removing this deck deletes its profiles and assignments. Shared
          workflows remain available.
        </p>
        {remove ? (
          <div className="row">
            <button onClick={() => setRemove(false)}>Keep deck</button>
            <button
              className="danger"
              onClick={async () => {
                const result = await request({
                  type: "deleteDeck",
                  deckId: deck.id,
                });
                if (result) onClose();
              }}
            >
              Remove this deck
            </button>
          </div>
        ) : (
          <button className="danger" onClick={() => setRemove(true)}>
            Remove deck…
          </button>
        )}
      </details>
    </Modal>
  );
}
export function WebConnect({
  deck,
  onClose,
}: {
  deck: DeckConfig;
  onClose: () => void;
}) {
  const { request, snapshot } = useApp(),
    [invite, setInvite] = useState<{ urls: string[]; expiresAt: number }>(),
    [selected, setSelected] = useState(0),
    [qr, setQr] = useState(""),
    [copied, setCopied] = useState(false),
    [now, setNow] = useState(Date.now());
  useEffect(() => {
    void request({ type: "invite", deckId: deck.id }).then((result) => {
      if (result) {
        const inviteResult = result as { urls: string[]; expiresAt: number };
        setInvite(inviteResult);
        const network = inviteResult.urls.findIndex(
          (url) => new URL(url).hostname !== "127.0.0.1",
        );
        setSelected(network < 0 ? 0 : network);
      }
    });
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [request, deck.id]);
  const url = invite?.urls[selected];
  useEffect(() => {
    if (url) void QRCode.toDataURL(url, { width: 220, margin: 2 }).then(setQr);
  }, [url]);
  return (
    <Modal title="Connect a browser" onClose={onClose}>
      <p className="muted">
        Open this link on a phone or tablet on the same network. Then approve
        its matching code in Decker.
      </p>
      {invite && (
        <>
          <FieldLabel label="Network address">
            <select
              aria-label="Network address"
              value={selected}
              onChange={(e) => setSelected(Number(e.target.value))}
            >
              {invite.urls.map((u, i) => (
                <option key={u} value={i}>
                  {new URL(u).hostname === "127.0.0.1"
                    ? "This computer"
                    : new URL(u).hostname}
                </option>
              ))}
            </select>
          </FieldLabel>
          {qr && (
            <img
              className="qr-code"
              src={qr}
              alt="Scan to pair this web deck"
            />
          )}
          <FieldLabel label="Pairing link">
            <input aria-label="Pairing link" value={url ?? ""} readOnly />
          </FieldLabel>
          <div className="row">
            <button
              onClick={() => {
                void request({ type: "copyWebLink", url: url ?? "" }).then(
                  (value) => {
                    if (value !== undefined) setCopied(true);
                  },
                );
              }}
            >
              {copied ? <Check size={15} /> : <Copy size={15} />} Copy link
            </button>
            <button
              onClick={() => void request({ type: "openWeb", url: url! })}
            >
              <ExternalLink size={15} /> Open here
            </button>
          </div>
          <p className="muted small">
            {now > invite.expiresAt
              ? "Link expired. Close and reopen to create another."
              : `Link expires in ${Math.max(0, Math.ceil((invite.expiresAt - now) / 1000))} seconds.`}
          </p>
        </>
      )}
      <PairingApprovals deckId={deck.id} />
      {snapshot!.web.error && (
        <p className="danger-text">{snapshot!.web.error}</p>
      )}
    </Modal>
  );
}
export function PairingApprovals({ deckId }: { deckId?: string }) {
  const { snapshot, request } = useApp();
  return (
    <>
      {snapshot!.web.pending
        .filter((p) => !deckId || p.deckId === deckId)
        .map((p) => (
          <div className="pair-request" key={p.id}>
            <strong>{p.name}</strong>
            <small>
              {snapshot!.document.decks.find((d) => d.id === p.deckId)?.name}
            </small>
            <span className="pair-code">{p.code}</span>
            <p className="muted small">
              Approve only if this code matches the browser you opened.
            </p>
            <div className="row">
              <button
                onClick={() =>
                  void request({
                    type: "approvePairing",
                    pairingId: p.id,
                    approved: false,
                  })
                }
              >
                Decline
              </button>
              <button
                className="primary"
                onClick={() =>
                  void request({
                    type: "approvePairing",
                    pairingId: p.id,
                    approved: true,
                  })
                }
              >
                Approve browser
              </button>
            </div>
          </div>
        ))}
    </>
  );
}
