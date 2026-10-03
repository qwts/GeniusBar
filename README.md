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
node scripts/fetch-components.mjs   # pinned Node, agent-comms, agent-bot
npm run tauri dev               # tray item with its popup
npm run tauri dev -- -- --window   # the same UI in a regular window
# --snapshot PATH renders the popup to a PNG; see "Testing the UI"
npm --prefix ui test            # UI tests
(cd src-tauri && cargo test)    # shell tests
npm run build:unsigned          # unsigned GeniusBar.app
```

The app bundles its own Node and pinned agent-comms and agent-bot releases
(`components.json`); it never uses a Node the user installed. The web view
reaches agent-comms only through `bridge/bridge.mjs`, which runs in that Node
and holds the principal credential.

First-run setup (on the owner's click) uses an agent-comms broker that already
answers, or registers GeniusBar's own (`app.geniusbar.broker`). It pairs and
approves this account and GeniusBar as a principal. Then it uses a running
agent-bot daemon, or pairs one and registers it (`app.geniusbar.agent-bot`).
Both login services run the app's own Node. In release builds, each launch
re-registers a GeniusBar service that still points at an older or moved copy
of the app. **Remove services…** in the popup footer unloads and deletes
both. Services from another install, such as Homebrew's, are never changed.

The Swift app below remains the specification until the Tauri app reaches
parity (#11).

## Releases

Pushing a `vX.Y.Z` tag on `main` (matching the version in
`src-tauri/tauri.conf.json`, `package.json` and `Cargo.toml`) runs
`.github/workflows/release.yml`. It calls `package.yml`, which builds a
universal (Apple Silicon and Intel) `GeniusBar.app` and dmg, then publishes a
GitHub release. `package.yml` can also be run by hand to build without
releasing.

Repository **secrets** (Settings › Secrets and variables › Actions):

| Secret | Value |
| --- | --- |
| `CSC_LINK` | base64 of the Developer ID Application certificate (`.p12`) |
| `CSC_KEY_PASSWORD` | the `.p12` password |
| `APPLE_API_KEY` | base64 of the App Store Connect API key (`AuthKey_*.p8`) |
| `APPLE_API_KEY_ID` | that key's ID |
| `APPLE_API_ISSUER` | that key's issuer ID |
| `TAURI_SIGNING_PRIVATE_KEY` | the updater private key from `npx tauri signer generate` |
| `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` | its password (empty if it has none) |

Repository **variables**:

| Variable | Value |
| --- | --- |
| `GENIUSBAR_UPDATER_PUBKEY` | the updater public key (the `.pub` file's contents) |
| `GENIUSBAR_UPDATER_ENDPOINT` | `https://github.com/<owner>/<repo>/releases/latest/download/latest.json` |

All five Apple secrets give a Developer ID signed, notarized build. With none
of them the build is ad-hoc signed and labeled `unsigned-dev`; a partial set
fails the build. A signed release also needs the updater variables and key,
and carries the dmg, `GeniusBar_<version>_universal.app.tar.gz` with its
`.sig`, and `latest.json`. An unsigned build is published only as a
prerelease titled "(unsigned)" with the dmg alone: no `latest.json` and no
updater archive, so installed apps never update to it.

The updater key and endpoint are build-time configuration, not code
(ADR-0004 decision 8). A build without them, such as `npm run
build:unsigned`, runs with updates off and shows "Updates Off in This Build"
in the tray menu. With them, the app checks at startup and from the tray's
"Check for Updates…" item; the web view has no updater permissions.

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

### Tauri app

The Tauri app takes the same flags. Run the built binary directly so its
stdout and exit code reach the caller:

```sh
APP=src-tauri/target/release/bundle/macos/GeniusBar.app/Contents/MacOS/geniusbar
$APP --snapshot /tmp/geniusbar.png
$APP --snapshot /tmp/geniusbar.png --snapshot-detail agent_abc123
$APP --window
```

`--snapshot` (`--snapshot=PATH` also works) loads the popup hidden, with
activation policy `.accessory`, so there is no Dock icon, tray item or
visible window. The popup fetches the census through the Node bridge
exactly as when shown (so custody and auth are exercised), retrying until
the bridge answers. Once a census has settled it renders statically
(Dudles paused, eyes open) and calls `snapshot_ready`. The shell then
captures the web view with WebKit's `takeSnapshotWithConfiguration`,
redraws it at scale 2 (768×1120 for the 384×560 popup), writes the PNG and
prints `{"snapshot":"<path>","souls":N}`. Unlike R1, the PNG keeps the
popup's own colour scheme. `--snapshot-detail` takes a bare agent ID or an
`account/agentId` key and opens that soul's detail beneath the list. A
snapshot only reads: it polls no inbox, acks nothing, takes no Finder-opened
package, and starts no service refresh or update check. Failures work as in
R1: an unpaired or unreachable census, an unknown detail ID, or an
unwritable path still prints the JSON line, sends the error to stderr and
exits 1, with the PNG showing what the popup shows wherever it can be
written. If no census settles within 30 seconds, the shell captures
whatever is on screen and exits 1.

`cargo test` covers the flag parsing (`parse_mode`), and the UI tests cover
the readiness report (`useSnapshot`).

## Layout

- `Sources/GeniusBarLib/` — protocol client, models, custody, principal
  credential store, Dudle derivation, `AppState`, menu/detail/Dudle
  views, launch-flag parsing, offscreen snapshot renderer.
- `Sources/GeniusBar/` — SwiftUI `MenuBarExtra` app wiring (`--snapshot`
  / `--window` modes).
- `Tests/GeniusBarTests/` — Dudle derivation, soul nesting, wire framing,
  client decoding, credential store, paths, launch options, snapshot
  rendering suite.
