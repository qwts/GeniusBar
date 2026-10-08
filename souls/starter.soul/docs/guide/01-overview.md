---
id: overview
title: GeniusBar, agent-bot and agent-comms
keywords: [overview, what is geniusbar, agent-bot, agent-comms, components, boundaries, engine, broker, daemon, versions]
sources:
  - label: GeniusBar #73 — the built-in GeniusBar lead
    url: https://github.com/qwts/GeniusBar/issues/73
  - label: GeniusBar #301 — About GeniusBar and component versions
    url: https://github.com/qwts/GeniusBar/issues/301
---
observed: GeniusBar is a menu bar app for macOS (and a desktop app on Windows) that shows your **souls**, agents with an identity of their own, as companions you can chat with. It does not run a model itself: each companion runs in a **harness** such as Claude Code or Codex, and GeniusBar only shows what the two bundled components report and relays what you ask them to do.

observed: **agent-bot** is the engine. It owns every soul: its package folder (`soul.json`, `AGENTS.md`, skills, docs), its Agent ID, its private state, its revisions, its execution mode, its approvals and the audit log. Its daemon starts and wakes souls. Every change GeniusBar offers is an `agent-bot` command; GeniusBar never edits a soul's folder or agent-bot's state directory by hand.

observed: **agent-comms** is the messaging layer. Its broker keeps the census of who is paired, carries messages between you and the souls and between souls (inboxes, replies, task offers), and the fleet list GeniusBar shows is its census. "Agent comms" on a companion means it has joined the broker.

observed: GeniusBar bundles a copy of both components and of Node, and also uses them when they run as login services on this Mac. "About GeniusBar…" in the ⋯ menu shows the app version and build, the bundled version of each component and the version actually running, with a selectable summary and a Copy button. This guide's header names the GeniusBar version it was written for; the versions of the bundled components are in its `index.json`.

observed: The boundary matters when something goes wrong: the app can only show what the components say. "Can't reach the background service" is agent-comms's broker not answering; a refused change ("Execution mode unchanged: …") is agent-bot refusing; a reply that never comes is usually the harness, most often a sign-in that lapsed (see *Troubleshooting*).

## Technical details
- `agent-bot --version`, `agent-comms --version`, `agent-bot doctor` and `agent-comms health` report what runs on this Mac.
- The engine describes a soul with `agent-bot soul env <agentId> --json`; its `engine.capabilities` list is how GeniusBar learns what the bundled engine supports, so a newer feature appears only when the engine reports it.
- Every GeniusBar action that changes a soul is logged by agent-bot in its audit log; the app's own trace is `shell.log` in the app's log folder.
