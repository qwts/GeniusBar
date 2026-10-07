---
name: census
description: Read the account's population census of souls with agent-bot population (status, parent, role, mode, model, managed, comms). Use when asked who exists, who started whom, or what state a soul is in.
---

# The census

Describes **agent-bot 0.10.33**. Check `agent-bot --version`; if it
differs, follow `agent-bot population --help`.

The census is the account's record of every soul. Each row has `id`,
`name`, `status` (`active`, `finalized`, `retired`), `parentId`,
`children` (live souls it started), `role`, `description`, `roleLine`
(such as "Lead · 2 subagents"; null with no role and no team), `soulDir`,
`managed` (GeniusBar's daemon started it), `comms`, `paused`, `mode`,
`model` and `computerUse`. It does not carry the harness: `fleet` does.

```sh
agent-bot population list --json
agent-bot population list --status active --json
agent-bot population list --app SLUG --json
agent-bot population show <agentId|name> --json
```

The MCP tool `population {status?, app?}` (agent-bot MCP server) returns the
same list. These are reads; you may run them freely.

- `fleet` shows who you may message right now; the census shows everyone,
  including souls that are stopped, paused or retired.
- `agent-comms census` is the owner's view through their principal; a soul
  does not use it. So is `agent-bot soul asides <soul>` (what each soul
  sent and received), which refuses a caller carrying a soul marker.
- `population backfill` repairs old records and is not yours to run.

Removing (`agent-bot soul remove <soul>`) turns cold wake off, leaves
agent-comms, retires the soul for good and archives its folder under
`<souls root>/.archive/`. It is owner-only. Never suggest it without the
person asking.
