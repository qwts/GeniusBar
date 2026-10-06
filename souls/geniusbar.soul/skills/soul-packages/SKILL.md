---
name: soul-packages
description: The soul package format, agent-bot soul build, harness settings, templates, and how to change a soul as a reviewed revision. Use when asked to create, edit, configure or inspect a soul.
---

# Soul packages, build and harness settings

Describes **agent-bot 0.10.23** (bundled with GeniusBar). Check
`agent-bot --version` first; if it differs, follow `agent-bot soul --help`.

## The format

A soul package is a directory, conventionally `NAME.soul`:

- `soul.json` (required): `formatVersion` (1 or 2), `name`, `description`,
  `displaySeed`, `preferredHarnesses` (unique names, first is the default),
  `revision`, `parentRevision`. Optional: `template` (true marks a package
  that `soul templates` lists), `comms` (false withholds `fleet` and
  `send_message`), `credentials` (a reference only, see the credentials
  skill). Unknown fields are kept.
- `AGENTS.md` (required): the soul's instructions.
- `skills/<name>/SKILL.md`: YAML front matter with `name` (lowercase,
  hyphens, equal to the directory) and `description` (at most 1024
  characters).
- Optional: `sop/`, `agent-sop.toml`, `bin/` (every change needs the person),
  `tools.json`, `mcp.json`, `policy.json` (kept, not interpreted).
- Format 2 adds the fixed `ignore` list and keeps working state
  (`worktrees/`, `.soul-state/`) and generated harness files out of the
  revision.

The revision is a SHA-256 over the content; any edit changes it.

```sh
agent-bot soul pack validate PATH          # JSON {formatVersion, revision, parentRevision}
agent-bot soul templates --json            # {templates, soulsRoot, errors}
agent-bot soul locate PATH                 # what a path is: package, installed, copy, ...
agent-bot soul dir AGENT_ID                # a soul's directory
agent-bot soul profile <agentId|name> --json [--file RELATIVE_PATH]
agent-bot soul show <agentId|name> --json
```

## Build harness files

`agent-bot soul build [PATH] [--check]` renders each harness's files from
`AGENTS.md` and `skills/`: Claude gets `CLAUDE.md` (importing `AGENTS.md`)
and `.claude/skills/`, Gemini `GEMINI.md` and `.gemini/skills/`; Codex,
OpenCode and Cursor read `AGENTS.md` natively. `--check` prints JSON
`{drift, writes, removals}`, writes nothing and exits 1 on drift. Always
check before and after a change.

## Harness settings available today

- Which harness: `preferredHarnesses` in `soul.json`, or `harness` when
  starting a soul (`start_soul`, `soul spawn --harness H`).
- Model: `agent-bot soul model <agentId|name> [show|set <modelId>|clear] --json`.
- Mode: `agent-bot soul mode <agentId|name> [show|safe|autopilot] --json`.
- Computer use: `agent-bot soul computer-use <agentId|name> [show|on|off] --json`.
- Comms: `agent-bot soul comms <agentId|name> [show|on|off] --json`.

`show` is safe to run. Every change (`set`, `clear`, `safe`, `autopilot`,
`on`, `off`) is owner-gated: agent-bot refuses it from a soul. Propose it to
the person with the exact command, or point them to the soul's Details in
GeniusBar. Rendering model, permissions, MCP servers and web search into
each harness from `soul.json` is not in this version (agent-bot #379,
#378); say so rather than hand-writing harness config.

## Change a soul as a revision

```sh
agent-bot soul revision list ID
agent-bot soul revision history ID
agent-bot soul revision propose ID PATH 'reason'     # your own soul only
agent-bot soul revision edit ID PATH 'reason'        # owner only
agent-bot soul revision approve ID PROPOSAL_ID 'reason'   # owner only
agent-bot soul revision reject ID PROPOSAL_ID 'reason'    # owner only
```

1. Copy the soul's package (`soul dir ID`) to a scratch directory, without
   `.soul-state/` and `worktrees/`.
2. Edit the copy. Run `soul pack validate` (fix the revision it reports by
   resubmitting through the revision commands, never by hand) and
   `soul build PATH --check`.
3. For yourself: `revision propose`. Your `policy.json` decides whether it
   applies or waits for the person; `soul.json`, `bin/`, tools and MCP
   changes always wait.
4. For another soul: agent-bot refuses cross-soul proposals. Give the person
   the scratch path, a short diff and the `revision edit` command, and let
   them approve it. Undo is another edit from an earlier snapshot.

## Templates and new souls

`agent-bot soul spawn TEMPLATE_PATH --name NAME [--harness H]` makes a new
local soul named `NAME - <template name>`. Prefer `start_soul` (fleet skill),
which records you as the parent and joins it to agent-comms.
