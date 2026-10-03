# GeniusBar
macOS menubar for the agent-comms hub

A Tauri 2 menubar app with a bundled Node sidecar
([ADR-0004](docs/decisions/ADR-0004-tauri-menubar-app-with-a-node-sidecar.md)).
It lists souls from the broker census, nested under their parents, each with
a deterministic Dudle avatar, and lets you chat with them and launch new ones.

## Building and running

The shell lives in `src-tauri/`, the web UI in `ui/`, and the Node bridge in
`bridge/`. Requirements: Node 24 and the Rust toolchain from
`rust-toolchain.toml`.

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
both. Services from another install, such as Homebrew's, are never changed,
except by the migration below.

### Command-line tools: Homebrew is not required

**Command-line tools…** in the popup footer puts the bundled `agent-bot` and
`agent-comms` on your PATH, like VS Code's `code` command (#41). They are
small wrapper scripts in `~/.local/bin` that run the copies inside the app,
so an in-app update reaches them with nothing to reinstall, and each launch
repoints them if the app moved. A stock Mac has no `~/.local/bin` on PATH,
so install adds a marked `export PATH=...` block to `~/.zprofile` (zsh) or
`~/.bash_profile` (bash) when a new terminal would not find it; Uninstall
removes that block. Other shells get a note to add it themselves. An
agent you start yourself (in a terminal, an IDE or a chat app) can then run
`agent-bot setup-worktree` and `agent-comms join` with no other install. No
admin password is needed.

If `agent-bot` or `agent-comms` is already in `~/.local/bin` (Homebrew's
link, say), GeniusBar shows where it points and replaces it only when you
click **Replace and install**. The old entry is renamed to
`<name>.before-geniusbar`, and **Uninstall** puts it back. Uninstall removes
only the wrappers GeniusBar wrote; each one carries a
`# geniusbar-cli-tool` marker line.

### Moving from a Homebrew install

On a Mac with a Homebrew broker plist (`dev.qwts.agent-comms.broker`)
or daemon plist (`dev.qwts.agent-bot.daemon`), setup checks launchd and names
each service as running (loaded) or stopped (unloaded), then
offers two choices:

- **Move to GeniusBar** stops those services, starts GeniusBar's own in
  their place, and waits until both answer. Only then are the Homebrew units
  renamed to `<label>.plist.geniusbar-migrated`, so they no longer start at
  login. Both installs keep their state in the same directories, so your
  agents, inboxes, unread messages, pairings and daemon settings
  (`cold-wake.json`, `wake-sessions.json`) carry over unchanged. If anything
  fails, GeniusBar restores any renamed plists, removes what it installed and
  starts the previously loaded Homebrew services again. Stopped plists are
  renamed aside without attempting to stop them, and stay unloaded if the
  move fails.
- **Keep them** leaves the Homebrew plists in place and sets GeniusBar up
  using any services already running, starting its own where needed.

After moving, install the command-line tools above. You can then run
`brew uninstall agent-bot agent-comms` whenever you like. Don't run
`agent-comms broker install` or `agent-bot daemon install` from a Homebrew
copy afterwards: that would start a second broker or daemon next to
GeniusBar's.

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

## Testing the UI

The menubar itself is invisible to computer-use agents and CI (status items
are not capturable without Screen Recording permission), so two launch
flags expose the same popup content: `--window` shows it in a regular window
for desktop automation, and `--snapshot` renders it to a PNG (below). A
launch with neither flag is an unchanged menubar launch.

The R1 Swift app was the specification for this one (ADR-0004 decision 7)
and was removed in #11. Its behaviour lives on in these tests:

- census nesting and cycle handling: `ui/src/model/census.test.ts`;
- Dudle derivation, matching the Swift app's values exactly:
  `ui/src/model/dudle.test.ts`;
- launch options (`--window`, `--snapshot`, `--snapshot-detail`):
  `parse_mode` tests in `src-tauri/src/lib.rs`;
- wire framing and custody: the broker protocol and custody checks belong
  to the bundled agent-comms principal client, which the bridge uses rather
  than reimplementing, and which agent-comms tests itself.
  `bridge/bridge.test.mjs` covers the shell-to-bridge framing.

### Launch flags

Run the built binary directly so its stdout and exit code reach the
caller:

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
prints `{"snapshot":"<path>","souls":N}`. The PNG keeps the popup's own
colour scheme. `--snapshot-detail` takes a bare agent ID or an
`account/agentId` key and opens that soul's detail beneath the list. A
snapshot only reads: it polls no inbox, acks nothing, takes no Finder-opened
package, and starts no service refresh or update check. On failure, an unpaired or unreachable census, an unknown detail ID, or an
unwritable path still prints the JSON line, sends the error to stderr and
exits 1, with the PNG showing what the popup shows wherever it can be
written. If no census settles within 30 seconds, the shell captures
whatever is on screen and exits 1.

`cargo test` covers the flag parsing (`parse_mode`), and the UI tests cover
the readiness report (`useSnapshot`).

## Layout

- `src-tauri/` — the Rust shell: tray, popup and window, the bridge and
  service processes, the updater. It holds no agent logic.
- `ui/` — the React web view (Vite, TypeScript), with its models and tests.
- `bridge/` — Node scripts run in the bundled Node: the broker bridge,
  first-run setup, login services, and command-line tools.
- `scripts/` — component fetching, signing checks, and release helpers.
- `souls/` — the bundled Starter soul.
- `docs/decisions/` — ADRs.
