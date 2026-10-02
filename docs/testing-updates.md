# Testing the updater without a public release

The updater needs an https endpoint in a release build, which makes a local
test look impossible. `GENIUSBAR_UPDATER_INSECURE=1` is the escape hatch
(`scripts/updater.mjs`): on an **unsigned** build it allows `http://`
endpoints and archive URLs and still emits signed updater artifacts, so a
local `latest.json` exercises the real check → download → verify → install →
restart path. A signed build with the flag set fails at config time, so the
hatch can never ship.

## Setup: a throwaway updater key

```bash
npx @tauri-apps/cli signer generate -w ~/.config/geniusbar-test/updater.key
# the printed public key goes to the builds:
export GENIUSBAR_UPDATER_PUBKEY='dW50cnVz...'
export TAURI_SIGNING_PRIVATE_KEY="$(cat ~/.config/geniusbar-test/updater.key)"
export TAURI_SIGNING_PRIVATE_KEY_PASSWORD=''   # if the key has none
export GENIUSBAR_UPDATER_INSECURE=1
export GENIUSBAR_UPDATER_ENDPOINT='http://localhost:8765/latest.json'
```

## Build the "installed" app

```bash
node scripts/updater.mjs config /tmp/gb-updater.json
npm run build:unsigned -- --config /tmp/gb-updater.json
cp -R src-tauri/target/release/bundle/macos/GeniusBar.app /Applications/
```

`build:unsigned` is a release-profile build, so `refresh_services` runs and
the service reconcile is exercised exactly as in a shipped build.

## Build the "update"

Same tree, only the version changes — via a config overlay, never by editing
`tauri.conf.json`:

```bash
jq '.version = "0.1.1-test"' /tmp/gb-updater.json > /tmp/gb-updater-011.json
npm run build:unsigned -- --config /tmp/gb-updater-011.json
mkdir -p /tmp/gb-update
cp src-tauri/target/release/bundle/macos/GeniusBar.app.tar.gz{,.sig} /tmp/gb-update/
GENIUSBAR_UPDATER_INSECURE=1 node scripts/updater.mjs manifest 0.1.1-test \
  http://localhost:8765/GeniusBar.app.tar.gz \
  /tmp/gb-update/GeniusBar.app.tar.gz.sig > /tmp/gb-update/latest.json
python3 -m http.server 8765 -d /tmp/gb-update
```

## Run the test

1. Launch `/Applications/GeniusBar.app` (the 0.1.0 build), run Set up so the
   broker and daemon are installed, then chat with the starter soul.
2. Tray → "Check for Updates…" → the item becomes "Install GeniusBar
   0.1.1-test and Restart"; the popup shows the update line too.
3. Click it: "Installing…" → the app relaunches as 0.1.1-test.
4. Expect in the log (`log stream --process GeniusBar` or the console run):
   `services: {"ok":true,"broker":"restarted","daemon":"restarted"}` — the
   first refresh under the new version kickstarts both units onto the new
   bundle. `launchctl print gui/$(id -u)/app.geniusbar.broker` and
   `…/app.geniusbar.agent-bot` show new pids; the stamp lands in
   `~/Library/Application Support/app.geniusbar/services.json`.
5. Chat again: the starter answers (cold wake through the restarted broker
   and daemon), and pairing/`app.geniusbar.principal` are untouched.

## Failure cases to cover

- **Offline**: stop the server before checking → the tray item returns to
  "Check for Updates…" (startup check) or shows "Update Failed — Try Again"
  (manual check).
- **Bad signature**: corrupt `latest.json`'s `signature` field → install
  fails → "Update Failed — Try Again", the running app is untouched.
- **Declined**: see the offer, never click → nothing installs; the offer
  reappears on the next launch's startup check.
