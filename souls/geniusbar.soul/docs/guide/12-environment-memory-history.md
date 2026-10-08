---
id: environment-memory-history
title: Soul environment, memory and history
keywords: [environment, memory, history, context, continuity, restore, recover, migration, soul-state, space, worktree, workspace, home, durable, retention, soul env]
sources:
  - label: GeniusBar #268 — adopt the cumulative soul environment
    url: https://github.com/qwts/GeniusBar/issues/268
  - label: agent-bot-identity #583 — the cumulative ownership contract
    url: https://github.com/qwts/agent-bot-identity/issues/583
---
observed: A soul owns its life inside its package folder. `soul.json`, `AGENTS.md`, skills and docs are its **definition**, versioned by revisions. Everything it accumulates lives under `.soul-state` in the same folder: its private **home** (the working directory its harness runs in), its **tool state** (the harness's own files, when routed into the soul), its **memory** (its Agent Space), its **history** (runs, with the revision journal and wake sessions beside it), caches and temporary files. Its **workspaces** are git worktrees under `worktrees/`.

observed: agent-bot classes each part by retention: **durable** (definition, home, tool state, credentials, memory, history, workspaces), **reconstructible** (generated harness files, runtimes, caches) and **disposable** (temp). A package revision and a guide refresh change only the definition; a reinstall of GeniusBar changes nothing in a soul. The revision hash skips `.soul-state` and `worktrees/`, so memory and history never change the package's revision.

observed: Souls created before the soul environment existed may keep their memory outside the folder (a linked space). `agent-bot soul env <agentId>` shows where everything is and lists pending **migration** steps (`space-into-soul`, `adopt-host-signin`) that `agent-bot soul env migrate` carries out, each recorded in the soul's migration journal. GeniusBar does not run these for you.

design: The Lovable **Environment & memory** section and **Memory** tab, showing whether the next run gets its history back (Ready, Needs migration, Unavailable, Not supported), are #268 and not in the app. Until then the descriptor is the source: Unavailable there means agent-bot cannot say, not that anything is lost.

observed: Recovery: a soul whose folder still exists can always be launched again from it (open the `.soul` in Finder, or **Launch…** in Details); an archived soul's folder is in `.archive` inside your souls folder (see *Archive versus deletion*). Nothing in GeniusBar deletes a soul's folder.

## Technical details
- `agent-bot soul env <agentId> --json`: `components[]` with `classification` and `retention`, `migration.steps[]`, `readiness.problems[]`, `engine.capabilities[]`.
- `agent-bot soul env migrate <agentId> --space-into-soul | --adopt-host-signin [--harness NAME]`, each owner-gated.
- `agent-bot soul dir <agentId>` and `soul locate <path>` find a soul's folder and the soul of a folder.
