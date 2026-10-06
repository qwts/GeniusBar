---
name: census
description: Read the account's population census of souls with agent-bot population (status, parent, harness, managed, comms). Use when asked who exists, who started whom, or what state a soul is in.
---

# The census

Describes **agent-bot 0.10.23**. Check `agent-bot --version`; if it
differs, follow `agent-bot population --help`.

The census is the account's record of every soul: Agent ID, name, status
(`active`, `finalized`, `retired`), harness, parent, soul directory,
`managed` (GeniusBar's daemon started it), `comms`, and `paused`.

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
  does not use it.
- `population backfill` repairs old records and is not yours to run.

Removing (`agent-bot soul remove`) archives a soul and is owner-only. Never
suggest it without the person asking.
