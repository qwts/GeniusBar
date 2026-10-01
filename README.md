# GeniusBar
macOS menubar for the agent-comms hub

Display-only menubar app (SwiftUI `MenuBarExtra`): lists souls from the
broker `census` operation nested under their parents, each with a
deterministic Dudle avatar, plus a broker `health` header. No routing, no
authority, no chat (chat comes in R3).

## Building and running

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

## Layout

- `Sources/GeniusBarLib/` — protocol client, models, custody, principal
  credential store, Dudle derivation.
- `Sources/GeniusBar/` — SwiftUI `MenuBarExtra` app, soul rows, Dudle
  renderer, read-only detail panel.
- `Tests/GeniusBarTests/` — Dudle derivation, soul nesting, wire framing,
  client decoding, credential store, paths suite.
