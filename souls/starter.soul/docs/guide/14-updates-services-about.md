---
id: updates-services-about
title: Updates, services and About
keywords: [update, check for updates, install and restart, release notes, services, remove services, refresh, about, version, build, component details, copy version info, report a problem, guide update, docs]
sources:
  - label: GeniusBar #34 — the update path
    url: https://github.com/qwts/GeniusBar/issues/34
  - label: GeniusBar #9 — login services
    url: https://github.com/qwts/GeniusBar/issues/9
  - label: GeniusBar #290 — About GeniusBar
    url: https://github.com/qwts/GeniusBar/issues/290
  - label: GeniusBar releases
    url: https://github.com/qwts/GeniusBar/releases
---
observed: A release build checks for an update once at startup, quietly, and whenever you choose **Check for Updates…** (the tray menu, the popup's ⋯ menu, or the setup footer). A found update shows in the popup as "GeniusBar X is available" with **Install and restart**; after your own check, "GeniusBar is up to date." says there was nothing. Installing restarts the app.

observed: After an update (or a move of the app), GeniusBar re-registers its two login services so they run the new copy, and refreshes the command-line wrappers it installed. Companions keep running through the broker and daemon; their souls are untouched. **Remove services…** in the ⋯ menu stops and deletes the broker and daemon login services after asking once; pairings and chat history stay, and **Set up** brings the services back. **Refresh** re-reads everything shown.

observed: **About GeniusBar…** shows the app's Version and Build, **Component details** with each component's bundled and running version, a selectable "Version info" summary with **Copy version info** (it holds only those lines, never paths or secrets), and links: **Release notes**, **Report a problem** (GitHub, nothing is sent until you write it) and **App guide**. It works before setup and while the service is unreachable.

observed: This guide ships inside Genius's package (and the GeniusBar lead's) as maintained documentation, with the GeniusBar version it was written for in its header and the bundled component versions in its index. A guide update arrives with an app update: GeniusBar then asks agent-bot to refresh the maintained docs of each companion made from a bundled template, which replaces only the files under the template's maintained paths (`docs/guide/` for Genius; the lead's `skills/` too) in one package revision that agent-bot asks you to approve. Memories, history, your `AGENTS.md` edits and every other file are kept. One thing to know: a file you add yourself under a maintained path is removed by the next refresh, so keep your own notes outside `docs/guide/`. If the bundled agent-bot cannot do that yet, GeniusBar says so in its log and leaves every soul as it is.

## Technical details
- Updates come from GeniusBar's GitHub releases through Tauri's updater; the web view has no updater permissions.
- The services are launchd agents installed by `bridge/services.mjs`; a version stamp tells a same-path bundle swap from "unchanged".
- The refresh is `agent-bot soul template refresh <agentId> --from <bundled template> --json`, run once per app version and only when `soul env` reports the `template-refresh` capability; `--plan` runs first, so a soul with nothing to change is never written and never asks you.
- The rename of a template-owned Starter name is `agent-bot soul env migrate <agentId> --template-name --json`, behind the `template-name` capability, the same way.
