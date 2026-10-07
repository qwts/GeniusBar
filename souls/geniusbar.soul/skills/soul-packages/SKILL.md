---
name: soul-packages
description: The soul package format, agent-bot soul build, harness settings, templates, and how to change a soul as a reviewed revision. Use when asked to create, edit, configure or inspect a soul.
---

# Soul packages, build and harness settings

Describes **agent-bot 0.10.33** (bundled with GeniusBar). Check
`agent-bot --version` first; if it differs, follow `agent-bot soul --help`.

## The format

A soul package is a directory, conventionally `NAME.soul`:

- `soul.json` (required): `formatVersion` (1 or 2), `name`, `description`,
  `displaySeed`, `preferredHarnesses` (unique names, first is the default),
  `revision`, `parentRevision`. Optional: `template` (true marks a package
  that `soul templates` lists), `role` (1 to 60 characters), `comms` (false
  withholds the teammate tools), `credentials` (a reference only, see the
  credentials skill), `appearance.hue` (0 to 359), and harness settings
  (below). Unknown fields are kept.
- `AGENTS.md` (required): the soul's instructions.
- `skills/<name>/SKILL.md`: YAML front matter with `name` (lowercase,
  hyphens, equal to the directory) and `description` (at most 1024
  characters).
- `agents/<name>.md` (subagents: front matter `name`, `description`,
  optional `model`, `tools`) and `commands/<name>.md` (optional
  `description`; the body is the prompt).
- Optional: `sop/`, `agent-sop.toml`, `bin/` (every change needs the person),
  `tools.json`, `policy.json`, and a harness's own MCP file (`.mcp.json`,
  `.codex/config.toml`, `.gemini/settings.json`, `opencode.json`).
- Format 2 adds the fixed `ignore` list and keeps working state
  (`worktrees/`, `.soul-state/`) and generated harness files out of the
  revision. A spawned soul is format 2.

The revision is a SHA-256 over the content; any edit changes it.

```sh
agent-bot soul pack validate PATH          # JSON {formatVersion, revision, parentRevision}
agent-bot soul templates --json            # {templates, soulsRoot, errors}
agent-bot soul locate PATH --json          # package, installed, copy, ... plus launch prefill
agent-bot soul dir AGENT_ID                # a soul's directory
agent-bot soul profile <agentId|name> --json [--file RELATIVE_PATH]
agent-bot soul show <agentId|name> --json
```

## Build harness files

`agent-bot soul build [PATH] [--check] [--json]` renders each harness's
files: Claude gets `CLAUDE.md` (importing `AGENTS.md`), `.claude/skills/`,
`.claude/agents/`, `.claude/commands/` and `.claude/settings.json`; Gemini
`GEMINI.md`, `.gemini/skills/`, `.gemini/commands/`; OpenCode
`.opencode/agent/`, `.opencode/command/`; Codex reads `AGENTS.md` natively
and gets `.codex/config.toml`. Every harness with MCP gets the soul's own
`agent-bot` entry (`agent-bot reach-mcp`) unless `comms` is false; a file
the package already ships keeps its other servers and keys (`merged[].kept`).
`--check` writes nothing and exits 1 on drift; `--json` reports
`{drift, writes, removals, merged, harnesses}`, where each harness lists
what it `rendered` and what is `unsupported`. Managed homes are rebuilt
before each launch.

## Harness settings

Package defaults in `soul.json`: `harness` (shared) and `harnesses.<name>`
(per harness, overrides `harness`), each with only `model` (string),
`reasoningEffort` (`low|medium|high`) and `permissionMode`
(`safe|autopilot`). Claude renders all three, Codex all three, OpenCode
`model` and `permissionMode`, Gemini `model`; the rest show as
`unsupported.settings`. agent-bot has no web-search setting.

Live settings on a soul (`show` is a read; every change is owner-gated and
refused from a soul):

- Model: `agent-bot soul model <agentId|name> [show|set <modelId>|clear] --json`
  (wins over the package default at launch).
- Mode: `agent-bot soul mode <agentId|name> [show|safe|autopilot] --json`.
- Computer use: `agent-bot soul computer-use <agentId|name> [show|on|off] --json`.
- Comms: `agent-bot soul comms <agentId|name> [show|on|off] --json`.
- Sandbox: `agent-bot sandbox override <agentId|name> [show|inherit|sandboxed|unrestricted] --json`;
  `sandbox resolve <agentId|name> --json` and `sandbox status --json` read.

Propose a change to the person with the exact command, or point them to the
soul's Details in GeniusBar. Recipes: fleet-configuration skill.

## Change a soul as a revision

```sh
agent-bot soul revision list ID --json
agent-bot soul revision history ID --json
agent-bot soul revision propose ID PATH 'reason'               # your own soul only
agent-bot soul revision edit ID PATH 'reason' [--apply]        # owner only
agent-bot soul revision approve ID PROPOSAL_ID 'reason'        # owner only
agent-bot soul revision reject ID PROPOSAL_ID 'reason'         # owner only
```

1. Copy the soul's package (`soul dir ID`) to a scratch directory, without
   `.soul-state/` and `worktrees/`.
2. Edit the copy. Run `soul pack validate` (a revision mismatch is
   expected: the revision commands recompute it; never write it by hand;
   fix every other error) and `soul build PATH --check --json`.
3. For yourself: `revision propose`. Your `policy.json` decides whether it
   applies or waits for the person; `soul.json`, `bin/`, `policy.json`,
   tools and MCP changes always wait.
4. For another soul: agent-bot refuses cross-soul proposals. Give the person
   the scratch path, a short diff and the `revision edit ... --apply`
   command (`--apply` publishes it into the soul's folder, keeping working
   state; without it the edit is only recorded), or GeniusBar's Customize.
   Undo is another edit from an earlier snapshot.

## Templates and new souls

- `start_soul` (fleet skill) is how you start a teammate: it records you as
  the parent and joins it to agent-comms.
- `agent-bot soul spawn TEMPLATE_PATH --name NAME [--harness H] [--role ROLE]`
  makes a local soul named `NAME - <template name>` and returns JSON; it
  does not join or launch it.
- `agent-bot soul fork <copy-path> --name NAME [--harness H] [--role ROLE]`
  makes a Finder copy of a soul a new soul. Owner-gated.
- `agent-bot soul remove <agentId|name>` retires and archives a soul.
  Owner-gated; never suggest it unasked.
