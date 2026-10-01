# ADR-0004: GeniusBar is a Tauri menubar app with a bundled Node sidecar

**Status:** Proposed
**Date:** 2026-10-01
**Issue:** qwts/GeniusBar#4

## Context

R1 built GeniusBar as a native Swift `MenuBarExtra` app. It lists souls from
the agent-comms broker census, with Dudles and a health header. It runs only
on macOS, needs a Swift toolchain to build, and has no signing, packaging, or
release.

The goal is a download anyone can install and use, with no prerequisites, on
macOS now and Windows later. agent-comms
[ADR-0059](https://github.com/qwts/agent-comms/blob/main/docs/decisions/ADR-0059-host-apps-embed-agent-comms.md)
says a host app bundles pinned releases with its own Node and names
everything a user sees.
[ADR-0007 amendment 1](https://github.com/qwts/agent-comms/blob/main/docs/decisions/ADR-0007-observability-and-geniusbar.md)
makes GeniusBar one principal client, with no authority of its own.

R3 adds chat, launch, first-run setup, and soul package editing, which
roughly triples the UI. Building that twice, once in Swift and once for
Windows, would be the expensive path. Two signed desktop apps already
exist: qwts/cartograph, a Tauri 2 app with Developer ID signing and
notarization, and qwts/overlook, with Azure Trusted Signing for Windows.

## Decision

1. **Tauri 2.** GeniusBar is a Tauri 2 app.
   - **macOS:** a menubar item (`LSUIElement`, no Dock icon).
   - **Windows:** a tray item.

   Clicking the item opens a popup window anchored to it, and the R1
   `--window` and `--snapshot` test modes carry over.
2. **A thin shell.** The UI is a web view. The Rust shell is limited to the
   tray, the window, sidecar processes, and platform calls such as the
   secret store and login items. Agent logic stays in agent-comms and
   agent-bot, reached through the agent-comms principal client API
   (qwts/agent-comms#64).
3. **Bundled Node as a sidecar.** The app ships an official Node binary
   through Tauri's `externalBin`, signed with the app and given the
   hardened-runtime entitlements its JavaScript engine needs. With Node it
   bundles pinned release tags of agent-comms and of agent-bot (the
   qwts/agent-bot-identity repository), and it never uses a Node the user
   installed.
4. **Services outlive the app.** First-run setup registers the broker and
   daemon to start at login. They run the Node and components inside the
   installed app. Quitting GeniusBar never stops them, and the app
   reconnects when it starts. After an update, GeniusBar restarts them on
   the new version. If the app is moved or deleted while they are
   registered, they fail to start, and the next launch registers them
   again. Removing the services is an explicit action in the app.
5. **Signing reuses what exists.**
   - **macOS:** cartograph's universal build, Developer ID signing, and
     notarization, from the same five secrets.
   - **Windows:** overlook's Azure Trusted Signing account, through Tauri's
     custom sign command.

   With no secrets, a build is labeled unsigned. A partial secret set fails
   the build.
6. **Updates come from GitHub releases.** The Tauri updater reads this
   repository's releases, and update artifacts are signed with the updater
   key. Unsigned builds are never published as updates. Bundled component
   versions change only through a GeniusBar release.
7. **The Swift app is the specification, then it goes.** The R1 Swift tests
   define the behaviour to port: census nesting, cycle handling, Dudle
   derivation, wire framing, custody, and launch options. The Swift package
   is removed once the Tauri app passes the equivalent tests.
8. **No org is named.** Bundle identifiers, the service label, and the
   stored-credential name are this app's own, set through ADR-0059's host
   configuration. The updater URL and signing identities are release
   configuration. The repository can move to another organization without
   code changes.

## Consequences

- One codebase covers macOS and Windows. Windows still waits for the
  agent-comms platform seams (qwts/agent-comms#63).
- The build needs Rust and Node toolchains, and the R1 Swift work is
  rewritten.
- The download is about 10 MB of app plus about 40 MB of Node, smaller than
  an Electron app but larger than the Swift one.
- The web view differs by platform: WebKit on macOS, WebView2 on Windows.
  UI tests run on both.
- Cartograph's pipeline does not cover the tray, the sidecar, the updater,
  or Windows. Those parts are new work.

## Alternatives

- **Keep native Swift:** the best Mac experience and no rewrite, but Windows
  would mean a second app with every R3 screen built twice.
- **Electron:** reuses overlook's pipeline, but uses about 150 MB of memory
  at idle for an app that stays in the menubar all day, and it ships its own
  Node beside the one the services need.
- **A web page served by the broker:** no menubar presence, and no place for
  first-run setup or login items.
