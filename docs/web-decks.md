# Web decks on your local network

1. Choose **＋ Add deck → Web deck**, set a name/icon and rows/columns (1–16 each), then create it. Creation enables local sharing, normally on TCP port 9018. You can pause it or choose another port under **Settings → Web decks**.
2. Configure its keys in the desktop editor. **Deck settings** changes the icon, accepts an uploaded image, copies profiles from another deck, and resizes the grid. Keys keep their row/column coordinates; assignments outside a smaller grid stay saved and return when expanded.
3. Choose **Connect browser**. The QR code defaults to a local-network address; choose the address for the network your phone/tablet uses. **This computer** is a loopback address for local testing, not a phone address. The QR/link expires after two minutes and is single-use.
4. Open it in a browser, give the browser a name, and request pairing. Match the displayed code and approve on the desktop, either in the connect dialog or under **Settings → Web decks**. No phone/tablet app installation is required.
5. Tap or hold configured keys. Actions execute on the Decker computer. Live key feedback, profiles/pages and folders belong to that deck. Multiple browsers viewing one deck share its current page; separate decks operate independently. Use **Revoke access** to disconnect a paired browser immediately.

Decker must remain running; the editor may be closed to the tray. The computer and browser must be on the same network, and any host firewall must allow the chosen local port. The service listens on IPv4 interfaces, accepts private/loopback/link-local peers, validates host/origin, and has no public/cloud relay. **LAN transport currently uses HTTP/WebSocket without TLS, so use a trusted local network.** Pairing authorizes host actions; it does not encrypt traffic.

The browser is an operator interface. It receives display state, sends validated key events and receives only assets used by its deck; it cannot edit configurations or submit commands. Pairing credentials are HttpOnly/SameSite cookies with separately hashed server records in `web-clients.json`, outside workspace exports. Browser pairings survive restarts on the same host address; imports reset pairings and pause sharing. Different hostnames/IP addresses use separate browser cookies. Disconnect/background clears held keys, disables controls and reconnects without replaying input.

Current workspace schema is v7. The original v1 → v2 migration runs as part of the ordered migrations automatically after creating a migration backup, preserving assignments and history. Existing XL key indices are converted to fixed row/column coordinates. Old hardware entries get independent profile copies. Hardware discovery does not add duplicate configured decks or write to unconfigured devices.

`npm run dev` builds the browser controller before starting Electron development. Rebuild to refresh the browser controller after editing its files.

See [storage/security](security.md) and [visible refresh](visible-button-refresh.md)
for foreground-browser behavior. Real phone/tablet and Wi-Fi acceptance is pending
in [ACCEPTANCE](ACCEPTANCE.md).
