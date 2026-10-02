# GeniusBar
macOS menubar for the agent-comms hub

Display-only menubar app (SwiftUI `MenuBarExtra`): lists souls from the
broker `census` operation nested under their parents, each with a
deterministic Dudle avatar, plus a broker `health` header. No routing, no
authority, no chat (chat comes in R3).

## Tauri app (R3)

GeniusBar is moving to a Tauri 2 menubar/tray app with a bundled Node
sidecar ([ADR-0004](docs/decisions/ADR-0004-tauri-menubar-app-with-a-node-sidecar.md)).
The shell lives in `src-tauri/` and the web UI in `ui/`. Requirements: Node
24 and the Rust toolchain from `rust-toolchain.toml`.

```sh
npm ci && npm --prefix ui ci
npm run tauri dev               # tray item with its popup
npm run tauri dev -- -- --window   # the same UI in a regular window
npm --prefix ui test            # UI tests
(cd src-tauri && cargo test)    # shell tests
npm run build:unsigned          # unsigned GeniusBar.app
```

The Swift app below remains the specification until the Tauri app reaches
parity (#11).

## Building and running (Swift, R1)

Requirements: macOS 14+, Swift 6 toolchain (Xcode 16+ or swift.org), no
third-party dependencies.

```sh
swift build
swift test
```

To run the menubar app from a checkout:

```sh
swift run GeniusBar
```

The app speaks the newline-delimited JSON protocol over the broker Unix
socket and applies the same custody checks as the CLI (socket and state
directories must belong to the pinned broker account). It reads the
principal credential from the login keychain — pair first with the
agent-comms CLI, which stores the credential for us (GeniusBar never
sends pair requests itself):

```sh
agent-comms principal pair
```

The broker holds the new principal as pending until the owner approves
it on the admin socket:

```sh
agent-comms admin principal-approve <code>
```

Until then census/health fail as not approved and the menubar says so.

Environment overrides (tests, isolated brokers):

- `AGENT_COMMS_SHARED_DIR` — rendezvous dir (default
  `/Users/Shared/Public/agent-comms`)
- `AGENT_COMMS_BROKER_STATE_DIR` — broker state dir
- `AGENT_COMMS_CLIENT_STATE_DIR` — client state dir (keychain is used
  instead of the credential file on macOS)

CI (`.github/workflows/ci.yml`) runs `swift build` and `swift test` on
`macos-latest`.

## Testing the UI

The menubar itself is invisible to computer-use agents and CI (status
items are not capturable without Screen Recording permission), so two
launch flags expose the same menu content. A launch with neither flag is
an unchanged menubar launch.

```sh
# Render the menu content offscreen to a PNG and exit 0.
swift run GeniusBar -- --snapshot /tmp/geniusbar.png

# Render the menu content with one soul's detail panel beneath it.
swift run GeniusBar -- --snapshot /tmp/geniusbar.png --snapshot-detail agent_abc123

# Show the menu content in a regular titled window for desktop automation.
swift run GeniusBar -- --window
```

`--snapshot` loads the keychain credential and fetches census+health
once through the same `AppState`/`BrokerClient` path as the menubar (so
custody and auth are exercised), renders the menu content view offscreen
with SwiftUI `ImageRenderer` at scale 2, writes the PNG, prints
`{"snapshot":"<path>","souls":N}` on stdout, and exits 0. Dudle blink
animations render paused (eyes open) for a stable frame, and the app
stays `.accessory` with no visible window. The PNG uses a fixed light
scheme on an opaque white backdrop (the menu's material comes from its
window, which does not exist offscreen). On any failure (unpaired,
broker unreachable, unknown detail ID, unwritable path) the PNG still
shows what the UI would show — e.g. the unpaired or unreachable header
— the error goes to stderr, and the exit code is 1 (the JSON line is
still printed so automation can locate the rendering).

`--window` uses activation policy `.regular` and a titled `NSWindow`
hosting the same `ContentView`; clicking a row opens the read-only
detail sheet exactly as in the menu.

`swift test` covers the flag parsing as a pure function
(`parseLaunchOptions`) and renders a fixed fake forest + health through
the same view to a PNG in a temp dir, asserting a nonzero file. The
render test skips gracefully (and says so) when `ImageRenderer` cannot
produce an image in the test environment.

## Layout

- `Sources/GeniusBarLib/` — protocol client, models, custody, principal
  credential store, Dudle derivation, `AppState`, menu/detail/Dudle
  views, launch-flag parsing, offscreen snapshot renderer.
- `Sources/GeniusBar/` — SwiftUI `MenuBarExtra` app wiring (`--snapshot`
  / `--window` modes).
- `Tests/GeniusBarTests/` — Dudle derivation, soul nesting, wire framing,
  client decoding, credential store, paths, launch options, snapshot
  rendering suite.
