# Relative brightness and palette contexts (PR12 / PR21 contract)

Schema remains v3. `deck.brightnessIncrease` and `deck.brightnessDecrease` take
`{step: number}`: a finite positive integer from 1 to 100, default **10**.
Both return the resulting integer brightness (0–100) and are non-idempotent.
Workflow retries require the existing explicit `retrySafe` confirmation; there
are no implicit retries. Workflow data expressions resolve before validation.

Brightness actions use the existing document/credential mutation queue. They
read the current value only after acquiring it and reject settled invocations.
They save the next document before exposing it, configuring devices or reporting
success. A failed save leaves the live value unchanged. Buttons always carry
their originating deck ID, even if UI selection changes. A deleted explicit deck
fails; it cannot target another deck. Manual runs with no deck context retain
the active-deck fallback (desktop run requests capture selection at launch).

Whole-document saves preserve current brightness unless their `brightnessEdits`
metadata identifies an intentionally edited deck. The renderer tracks changed
brightness alongside the existing navigation edits, so ordinary editor saves
cannot rewind a key press and slider changes still commit. Credential ordering,
epoch guards, cancellation and navigation preservation remain unchanged.

`catalogForPalette("button" | "workflow")` filters new assignments only.
`paletteContexts` defaults to both contexts; `paletteVisible:false` overrides
all contexts. The full `catalog` and `actionById` remain the validation,
execution and import contracts. `paletteCatalog` is a compatibility export for
button context. PR21 should use workflow context for appearance authoring.

Button libraries, single actions, sequences and every key phase show relative
brightness. Absolute `deck.brightness` and `deck.appearance` are workflow-only
new choices. Existing button assignments remain selected and editable with an
**advanced** label. Globally hidden `desktop.open` and `media.control` remain
editable as **legacy**, and neither palette resurrects them.

Simulator and web decks persist the configured value; this does not claim to
change physical screen luminance. Hardware uses the existing brightness
transport. Mock frames prove software intent only. Real Stream Deck brightness,
OBS, OS keyring and host-desktop acceptance remain coordinator host gates.
