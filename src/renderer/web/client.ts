import type { WebDeckView } from "../../shared/schema";
import { packKeySvg } from "../../shared/icons";
import "./style.css";
const root = document.getElementById("app")!,
  deckId = decodeURIComponent(location.pathname.split("/")[2] ?? "");
let socket: WebSocket | undefined,
  view: WebDeckView | undefined,
  sequence = 0,
  reconnect: ReturnType<typeof setTimeout> | undefined,
  ready = false,
  ended = false,
  version = "",
  heartbeat: ReturnType<typeof setInterval> | undefined;
const pointers = new Map<number, number>();
const keyboardHeld = new Set<number>();
function element<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  text?: string,
  className?: string,
) {
  const node = document.createElement(tag);
  if (text) node.textContent = text;
  if (className) node.className = className;
  return node;
}
const header = element("header"),
  brand = element("span", "▦", "brand"),
  title = element("h1", "Decker"),
  status = element("span", "Connecting…", "status"),
  controls = element("div", undefined, "controls"),
  grid = element("main", undefined, "grid"),
  footer = element(
    "footer",
    "Actions run on your Decker computer. Keep it running.",
  );
header.append(brand, title, status);
root.append(header, controls, grid, footer);
async function api(path: string, body: unknown) {
  const response = await fetch(path, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Decker-Request": "1" },
    body: JSON.stringify(body),
  });
  const result = await response.json();
  if (!response.ok) throw new Error(result.error ?? "Connection failed");
  return result;
}
function send(message: Record<string, unknown>) {
  if (ready && socket?.readyState === WebSocket.OPEN)
    socket.send(JSON.stringify({ ...message, sequence: ++sequence }));
}
function reset() {
  pointers.clear();
  keyboardHeld.clear();
  for (const button of grid.querySelectorAll("button"))
    button.classList.remove("pressed");
  send({ type: "reset" });
}
function offline(message = "Offline · reconnecting…") {
  ready = false;
  pointers.clear();
  keyboardHeld.clear();
  status.textContent = message;
  status.classList.remove("online");
  for (const button of grid.querySelectorAll("button")) {
    button.disabled = true;
    button.classList.remove("pressed");
  }
}
function renderKey(
  button: HTMLButtonElement,
  key: WebDeckView["keys"][number] | undefined,
) {
  button.replaceChildren();
  if (key?.asset) {
    const image = element("img");
    image.src = `/key-assets/${key.asset}?deck=${encodeURIComponent(deckId)}`;
    image.alt = "";
    button.append(image);
  } else {
    const svg = packKeySvg(key?.icon ?? "", key?.label ?? "");
    if (svg) {
      const icon = element("span", undefined, "pack-key-visual");
      icon.setAttribute("aria-hidden", "true");
      icon.innerHTML = svg;
      button.append(icon);
    } else button.append(element("span", key?.icon || "✦", "symbol"));
  }
  button.append(element("span", key?.label ?? "", "label"));
}
function render(next: WebDeckView) {
  const changed =
    !view ||
    view.rows !== next.rows ||
    view.columns !== next.columns ||
    grid.childElementCount !== next.rows * next.columns;
  view = next;
  ready = true;
  title.textContent = next.name;
  document.title = `${next.name} · Decker`;
  status.textContent = "Connected";
  status.classList.add("online");
  document.documentElement.style.setProperty("--accent", next.accent);
  version = next.version;
  controls.replaceChildren(element("span", next.pageName));
  if (!changed) {
    for (const button of grid.querySelectorAll<HTMLButtonElement>("button")) {
      const index = Number(button.dataset.key),
        key = next.keys[index];
      button.style.backgroundColor = key?.background ?? "#232428";
      button.disabled =
        !key &&
        ![...pointers.values()].includes(index) &&
        !keyboardHeld.has(index);
      button.setAttribute("aria-label", key?.label || `Empty key ${index + 1}`);
      renderKey(button, key);
    }
    return;
  }
  reset();
  version = next.version;
  grid.replaceChildren();
  controls.replaceChildren(element("span", next.pageName));
  grid.style.setProperty("--columns", String(next.columns));
  grid.setAttribute(
    "aria-label",
    `${next.name} ${next.rows} by ${next.columns}`,
  );
  for (let index = 0; index < next.rows * next.columns; index++) {
    const key = next.keys[index],
      button = element("button", undefined, "key");
    button.dataset.key = String(index);
    button.disabled = !key;
    button.setAttribute("aria-label", key?.label || `Empty key ${index + 1}`);
    button.style.backgroundColor = key?.background ?? "#232428";
    renderKey(button, key);
    button.addEventListener("pointerdown", (event) => {
      if (!ready || event.button !== 0 || !view?.keys[index]) return;
      event.preventDefault();
      button.setPointerCapture(event.pointerId);
      pointers.set(event.pointerId, index);
      button.classList.add("pressed");
      send({ type: "down", key: index, version });
    });
    button.addEventListener("pointerup", (event) => {
      if (!pointers.has(event.pointerId)) return;
      pointers.delete(event.pointerId);
      button.classList.remove("pressed");
      send({ type: "up", key: index });
    });
    button.addEventListener("pointercancel", () => {
      reset();
      button.classList.remove("pressed");
    });
    button.addEventListener("lostpointercapture", (event) => {
      if (pointers.has(event.pointerId)) {
        reset();
        button.classList.remove("pressed");
      }
    });
    button.addEventListener("keydown", (event) => {
      if (event.repeat || ![" ", "Enter"].includes(event.key)) return;
      event.preventDefault();
      keyboardHeld.add(index);
      button.classList.add("pressed");
      send({ type: "down", key: index, version });
    });
    button.addEventListener("keyup", (event) => {
      if (![" ", "Enter"].includes(event.key)) return;
      event.preventDefault();
      button.classList.remove("pressed");
      keyboardHeld.delete(index);
      send({ type: "up", key: index });
    });
    grid.append(button);
  }
}
function connect() {
  if (ended || document.hidden) return;
  if (
    socket &&
    (socket.readyState === WebSocket.OPEN ||
      socket.readyState === WebSocket.CONNECTING)
  )
    return;
  clearTimeout(reconnect);
  clearInterval(heartbeat);
  socket = new WebSocket(
    `${location.protocol === "https:" ? "wss:" : "ws:"}//${location.host}/socket?deck=${encodeURIComponent(deckId)}`,
  );
  sequence = 0;
  socket.addEventListener("message", (event) => {
    try {
      const message = JSON.parse(event.data);
      if (message.type === "view") render(message.view);
      else if (message.type === "error") status.textContent = message.error;
    } catch {
      offline("Invalid deck state");
    }
  });
  const current = socket;
  socket.addEventListener("close", (event) => {
    if (socket !== current) return;
    clearInterval(heartbeat);
    offline(
      event.code === 1008
        ? "Pairing revoked · open a new pairing link"
        : "Offline · reconnecting…",
    );
    if (event.code !== 1008 && !ended)
      reconnect = setTimeout(() => void resume(), 2000);
  });
  socket.addEventListener("error", () => offline());
  heartbeat = setInterval(() => send({ type: "heartbeat" }), 4000);
}
async function resume() {
  if (ended || document.hidden) return;
  try {
    const response = await fetch(
      `/api/session?deck=${encodeURIComponent(deckId)}`,
    );
    if (response.ok) {
      controls.replaceChildren();
      connect();
    } else pairing("Open a pairing link from this deck in the desktop app.");
  } catch {
    offline();
    reconnect = setTimeout(() => void resume(), 2000);
  }
}
function pairing(message: string) {
  offline("Not paired");
  grid.replaceChildren();
  controls.replaceChildren();
  const panel = element("section", undefined, "pairing");
  panel.append(element("h2", "Connect this browser"), element("p", message));
  controls.append(panel);
}
async function begin() {
  const ticket = new URLSearchParams(location.hash.slice(1)).get("invite");
  history.replaceState(null, "", location.pathname);
  if (!deckId) {
    pairing("Open the QR code or link from your web deck in Decker.");
    return;
  }
  if (!ticket) {
    await resume();
    return;
  }
  pairing("Choose a name to identify this browser on the desktop.");
  const panel = controls.querySelector("section")!,
    input = element("input");
  input.placeholder = "Browser name";
  input.setAttribute("aria-label", "Browser name");
  input.maxLength = 80;
  input.value = /mobile|android|iphone|ipad/i.test(navigator.userAgent)
    ? "My phone / tablet"
    : "My browser";
  const button = element("button", "Request pairing");
  panel.append(input, button);
  button.addEventListener("click", async () => {
    button.disabled = true;
    try {
      const result = await api("/api/pair", {
        ticket,
        name: input.value.trim() || "My browser",
      });
      panel.replaceChildren(
        element("h2", "Approve on your computer"),
        element(
          "p",
          "Match this code with the request in Decker, then approve it.",
        ),
        element("strong", result.code, "pair-code"),
      );
      const start = Date.now();
      const poll = async () => {
        try {
          const state = await api("/api/pair-status", {
            id: result.id,
            pollToken: result.pollToken,
          });
          if (state.approved === true) {
            await resume();
            return;
          }
          if (state.approved === false) throw new Error("Pairing was declined");
          if (Date.now() - start > 120000) throw new Error("Pairing expired");
          setTimeout(() => void poll(), 1000);
        } catch (error) {
          pairing(String(error));
        }
      };
      void poll();
    } catch (error) {
      pairing(error instanceof Error ? error.message : String(error));
    }
  });
}
document.addEventListener("visibilitychange", () => {
  if (document.hidden) {
    reset();
    socket?.close();
    clearTimeout(reconnect);
    offline("Paused while this browser is in the background");
  } else void resume();
});
window.addEventListener("blur", reset);
window.addEventListener("pagehide", () => {
  ended = true;
  reset();
  socket?.close();
});
window.addEventListener("pageshow", (event) => {
  if (event.persisted) {
    ended = false;
    void resume();
  }
});
void begin();
