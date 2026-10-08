---
id: environment-memory-history
title: Soul environment, memory and history
keywords: [environment, memory, history, context, continuity, restore, recover, migration, soul-state, space, worktree, workspace, home, durable, retention, soul env, export, import, clean, cache, backup, move, fork]
sources:
  - label: GeniusBar #268 — adopt the cumulative soul environment
    url: https://github.com/qwts/GeniusBar/issues/268
  - label: agent-bot-identity #583 — the cumulative ownership contract
    url: https://github.com/qwts/agent-bot-identity/issues/583
---
observed: A soul owns its life inside its package folder. `soul.json`, `AGENTS.md`, skills and docs are its **definition**, versioned by revisions. Everything it accumulates lives under `.soul-state` in the same folder: its private **home** (the working directory its harness runs in), its **tool state** (the harness's own files, when routed into the soul), its **memory** (its Agent Space), its **history** (runs, with the revision journal and wake sessions beside it), caches and temporary files. Its **workspaces** are git worktrees under `worktrees/`.

observed: agent-bot classes each part by retention: **durable** (definition, home, tool state, credentials, memory, history, workspaces), **reconstructible** (generated harness files, runtimes, caches) and **disposable** (temp). A package revision and a guide refresh change only the definition; a reinstall of GeniusBar changes nothing in a soul. The revision hash skips `.soul-state` and `worktrees/`, so memory and history never change the package's revision.

observed: Souls created before the soul environment existed may keep their memory outside the folder (a linked space). `agent-bot soul env <agentId>` shows where everything is and lists pending **migration** steps (`space-into-soul`, `adopt-host-signin`, `harnesses-into-runtimes`) that `agent-bot soul env migrate` carries out, each recorded in the soul's migration journal. GeniusBar does not run these for you.

observed: The **Environment** section in a companion's Details renders what `agent-bot soul env` reports: each component with its classification and retention, the harnesses and runtimes, readiness problems with the engine's own recovery action, and pending migration steps. Every control is live only when `engine.capabilities` lists it and stays disabled with a note otherwise: **Complete setup** (`migrate-complete`) finishes pending, interrupted or failed migration steps; **Clean up cache** (`env-clean`) removes only what the engine classes reconstructible or disposable, never the definition, home, memory, history or a workspace; **Export life…** (`env-export`) writes the soul's life as one file; **Import life…** (`env-import`) restores one. Each shows the engine's plan first, starts nothing until you confirm, and agent-bot asks for the owner's approval itself. Unavailable in the descriptor means agent-bot cannot say, not that anything is lost. The separate **Memory** tab from the design is not in the app.

observed: An export carries the definition, the private home, tool state without its sign-in files, memory, history, the revision journal and the soul-owned workspaces; a linked workspace travels as a pointer with its uncommitted changes as a patch and its untracked files, and the repository stays where it is. Credentials, sign-ins, runtimes, caches and generated files never travel. An import keeps the soul's Agent ID (a moved life); when that ID is already active here it offers **Replace** (the current folder is moved aside, never deleted) or **Import as a new soul** (a fork with a new ID); a retired ID comes back only as a fork. Linked workspaces come back as pointers under `.soul-state/imports/` with a readiness warning until the repository is checked out and linked again. Nothing can be exported or imported while the soul runs.

observed: Recovery: a soul whose folder still exists can always be launched again from it (open the `.soul` in Finder, or **Launch…** in Details); an archived soul's folder is in `.archive` inside your souls folder (see *Archive versus deletion*). Nothing in GeniusBar deletes a soul's folder.

## Technical details
- `agent-bot soul env <agentId> --json`: `components[]` with `classification` and `retention`, `migration.steps[]`, `readiness.problems[]`, `engine.capabilities[]`.
- `agent-bot soul env migrate <agentId> --space-into-soul | --adopt-host-signin [--harness NAME] | --harnesses-into-runtimes [--plan] | --complete [--plan]`, each owner-gated. `--harnesses-into-runtimes` moves a soul's legacy `.soul-state/harnesses` adapter install under `.soul-state/runtimes/harnesses/<harness>/<version>/` (agent-bot ≥ 0.10.56, capability `harnesses-into-runtimes`); until then **Complete setup** leaves that step pending.
- `agent-bot soul env clean <agentId> [--plan] [--component cache|temp|runtimes]` (agent-bot ≥ 0.10.54, capabilities `env-clean`, `migrate-complete`).
- `agent-bot soul env export <agentId> --to FILE [--plan]` and `agent-bot soul env import FILE [--fork|--replace] [--name NAME] [--plan]` (agent-bot ≥ 0.10.55, capabilities `env-export`, `env-import`); `--plan` reads only. The archive is gzip over ustar with `manifest.json` first, so `tar -tzf` lists it.
- `agent-bot soul dir <agentId>` and `soul locate <path>` find a soul's folder and the soul of a folder.
