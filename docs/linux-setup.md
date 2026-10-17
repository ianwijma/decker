# Linux integrations and device setup

- Keyboard shortcuts and literal typing use `xdotool` on **X11**. General Wayland input injection is deliberately reported as unavailable.
- Audio probes the running `wpctl` service, falling back to `pactl`. Use `@DEFAULT_AUDIO_SINK@` for output and `@DEFAULT_AUDIO_SOURCE@` for microphone, or a backend device ID. Mute values: `0`, `1`, `toggle`; volume: `0`–`1.5`; default-device selection requires a concrete ID. The backend must support the selected target.
- Media uses MPRIS through the session D-Bus. Leave the player name blank to select the first available player, or specify its bus name. No `playerctl` dependency.
- OBS requires OBS Studio's WebSocket server. Use **Settings → General → Add OBS**, enter the password inline, and select the saved connection by name in OBS actions. See [OBS setup and read-only tests](obs-setup-testing.md). Observed status comes from OBS events.
- Commands accept an executable and an **argument array** (native string array or legacy JSON-encoded string). Shell scripts are a separate, explicit action. Command process groups receive TERM followed by KILL on cancellation.
- HTTP supports HTTP(S), bounded response bodies and optional bearer credentials by reference. Requests carrying credentials do not follow redirects.

Use current [Diagnostics guidance](diagnostics.md) for the detected distribution and session. Decker does not install tools or change USB permissions automatically.

### Stream Deck USB permissions

The maintained community package `@elgato-stream-deck/node` owns protocol framing and model-specific encoding. For an XL (`0fd9:006c`), use a desktop-user udev rule:

```udev
SUBSYSTEM=="hidraw", ATTRS{idVendor}=="0fd9", ATTRS{idProduct}=="006c", TAG+="uaccess"
```

An administrator can install it as `/etc/udev/rules.d/70-decker.rules`, reload with `sudo udevadm control --reload-rules`, then unplug/reconnect the deck. Check the actual logged-in user's device access. Existing distribution rules may already provide access. Never run Decker as root, and close other applications controlling the same deck. Serial numbers are used when available; transient hidraw paths are never persisted as identity.

Models use discovered geometry; physical operation is **not hardware-verified**. The adapter polls for hotplug, clears held keys on disconnect/suspend, restores the current page and brightness after reconnect, serializes writes and coalesces pending key updates. No missed press is replayed.

Linux x64 is the build target. Physical Pop!_OS 22.04 / Stream Deck XL acceptance
(4×8 keys, 96×96 pixels) is pending; simulator/CI readiness is not certification.
On 14 October 2026, a read-only host investigation found USB presence, driver
enumeration and identity, then a permission-denied open (root:plugdev 0660, no
user ACL). The proposed model-scoped uaccess remedy had not been applied. That
historical observation is not current live state and proves no image, key,
brightness, reconnect, suspend or performance result. Keep existing third-party
rules; never use chmod 666 or broad all-HID access.

After applying reviewed external guidance, use **Retry** in Home/Diagnostics and
check current readiness. See the consolidated [host checklist](ACCEPTANCE.md).
