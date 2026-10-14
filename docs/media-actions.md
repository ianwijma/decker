# Media action contract (PR11)

Document schema stays at v3. Both libraries offer the Media category with
`media.play`, `media.pause`, `media.playPause`, `media.next`, `media.previous`
and `media.stop`. They dispatch MPRIS `Play`, `Pause`, `PlayPause`, `Next`,
`Previous` and `Stop` respectively. Each config is `{ "player": "" }` by default;
there is no operation field. The shared handler also executes workflow nodes
and sequences. `media.control` remains editable, importable and executable with
its original operation/player values, but is hidden from new assignments.

## Player selection and observation

Blank player means the first lexically sorted `org.mpris.MediaPlayer2.*` bus
name, for both dispatch and observation. An explicit bus name never falls back
to another player. The default remains the first enumerated player even when
that player's status query fails; a healthy second player is still observed.

The existing observation shape remains `{ defaultPlayer, [busName]: status }`.
Per-player errors/timeouts yield `"Unknown"`; enumeration/session errors yield
the existing worker `{ unavailable: true }` snapshot. Every poll replaces the
media observation, so missing players clear stale feedback and a later valid
poll restores it. Queries are independently bounded to two seconds and always
disconnect. Action dispatch is abortable, bounded and checks cancellation before
further D-Bus work. Missing methods and player errors identify the operation and
player. Existing capability semantics are preserved: the player enforces them;
there is no new universal capability preflight. A method return is not proof
that playback changed (players may ignore requests they cannot perform).

## Feedback and authored appearance

Only a single direct press action gets media feedback. Sequences and workflow
bindings can have multiple effects and do not imply one observed media state.
All six direct actions and legacy `media.control` accent only on observed
`Playing`. The new Play/Pause default icon follows observed playback:

| Observation | Default icon | Playing accent |
| --- | --- | --- |
| Playing | `pack:lucide:v1:pause` | Yes |
| Paused | `pack:lucide:v1:play` | No |
| Stopped | `pack:lucide:v1:square` | No |
| Present, status unknown/query failed | `pack:lucide:v1:circle-help` | No |
| Missing player/session unavailable/no observation | `pack:lucide:v1:triangle-alert` | No |

The authored neutral `pack:lucide:v1:music` icon opts Play/Pause into this dynamic
default. Other authored strings, emoji, pack tokens, and an intentionally empty
icon are preserved. Uploaded artwork takes precedence over the dynamic icon.
Choosing the neutral music token again restores dynamic defaults. Labels stay
authored, and legacy icons stay unchanged. Observations never mutate the saved
appearance. Dispatch does not optimistically toggle it.

Desktop deck keys, web payloads and generated device frames consume the same
shared resolved appearance. Existing running/success/failure overlays and legacy
appearance overrides compose over that base; cancellation and expiry reveal the
latest observation. Concurrent activity, keys, generations and timers are
unchanged. The editor's appearance controls/preview continue to show the authored
artwork being edited.

## Host acceptance still required

CI uses injected MPRIS fixtures, temporary persistence, simulator/Electron
libraries and observation snapshots, plus generated frame comparisons. The
coordinator's consolidated host session must check real players, capability
refusals/no-ops, external playback changes and disappearance, explicit-player
isolation, and physical device appearance/cancellation. No hardware or real
desktop playback acceptance is claimed here.
