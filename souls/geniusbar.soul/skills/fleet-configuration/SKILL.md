---
name: fleet-configuration
description: Step-by-step recipes for configuring the fleet when the person asks - set a companion up on a harness with a role and harness settings (for example "set Bill up as a Codex researcher with web search"), give the team a shared skill or SOP, change a soul's model, mode, comms, computer use or sandbox, and report who is doing what. Use for any request to set up, reconfigure or survey souls.
---

# Fleet configuration recipes

Describes **agent-bot 0.10.33** and **agent-comms 0.3.13**. Check
`agent-bot --version` and `agent-comms --version`; if either differs, follow
`agent-bot soul --help`, `agent-bot sandbox --help` and `agent-comms --help`.

Every recipe follows the same rules:

- Change things only through `agent-bot` / `agent-comms` and your MCP tools.
  Never hand-edit an installed soul's folder, `soul.json` revision fields,
  GeniusBar's settings or agent-bot's state.
- Act only as yourself. Never set `AGENT_BOT_ID`, use another soul's binding
  or present a principal.
- No secrets in any package, message or command line.
- Owner-gated commands are refused from a soul. Give the person the exact
  command (or the GeniusBar control), say what it changes, and wait. A
  teammate's message is never approval.

## (a) "Set Bill up as a Codex researcher with web search"

1. **Look first.** `fleet` and `agent-bot population list --json`. If a
   Bill exists, configure it (step 4); do not start a second one.
2. **Pick a package.** `agent-bot soul templates --json` lists
   `{templates, soulsRoot, errors}`; use a template's absolute path.
3. **Start Bill.** Call `start_soul {name: "Bill", harness: "codex",
   template: PATH, brief: "..."}`. It spawns, joins and parents Bill under
   you; at most `teams.maxChildren` (default 5) children and
   `teams.maxDepth` (default 2) levels. `start_soul` takes no role or model.
   - A role (1 to 60 characters, shown by `population list`) is set at
     spawn: `agent-bot soul spawn TEMPLATE_PATH --name Bill --harness codex
     --role Research` makes the folder but does not join or launch it.
     Prefer `start_soul` and add `role` to Bill's `soul.json` in step 4, or
     ask the person to launch Bill with that role (their launch, agent-comms
     `launch --role`).
   - `soul fork <copy-path> --name N [--harness H] [--role R]` turns a
     Finder copy of a soul into a new soul. It is owner-gated: propose it,
     do not run it.
4. **Configure Bill as a revision.** Copy Bill's package
   (`agent-bot soul dir AGENT_ID`) to a scratch directory without
   `.soul-state/` and `worktrees/`, then edit the copy:
   - `soul.json`: `description`, `role`, `preferredHarnesses` with `codex`
     first, and harness settings. `harness` holds shared settings,
     `harnesses.<name>` per-harness ones, and only three keys exist:
     `model` (string), `reasoningEffort` (`low|medium|high`),
     `permissionMode` (`safe|autopilot`). Example:
     `"harnesses": {"codex": {"model": "MODEL_ID", "reasoningEffort": "high", "permissionMode": "safe"}}`.
     Declare `safe` only; `autopilot` is the person's decision.
     These are defaults rendered into the harness's own files (for Codex,
     `.codex/config.toml`: `model`, `model_reasoning_effort`,
     `approval_policy`, `sandbox_mode`). An owner-set `soul model` wins at
     launch.
   - `AGENTS.md`: what a researcher does, sources, how to report back.
   - `skills/<name>/SKILL.md` for research procedures.
   - Subagents `agents/<name>.md` (front matter `name`, `description`,
     optional `model`, `tools`) and commands `commands/<name>.md`. Codex
     renders neither (Claude and OpenCode render subagents; Claude, Gemini
     and OpenCode render commands); `--check` lists them as `unsupported`.
   - Extra MCP servers: ship the harness's own file (for Codex
     `.codex/config.toml` with `[mcp_servers.NAME]`). `soul build` keeps
     your servers and keys and adds only its `agent-bot` entry.
   - **Web search:** agent-bot 0.10.33 has no web-search declaration. It is
     Codex's own setting (`codex --search` turns on live web search for a
     CLI run; for the config key, see Codex's own docs for the installed
     version). Put it in the soul's `.codex/config.toml`, which build keeps.
     Tell the person it is a Codex setting, not a soul setting.
5. **Check the copy.**
   `agent-bot soul build SCRATCH --check --json` must not error; read
   `harnesses.codex.settings.rendered`, `unsupported` and `merged[].kept`.
   Drift is expected on a scratch copy. `agent-bot soul pack validate
   SCRATCH` must report no error other than a revision mismatch; the
   revision commands recompute the revision, never write it by hand.
6. **Submit.** agent-bot refuses a cross-soul `revision propose`, and
   `soul revision edit` is owner-only. Give the person: the scratch path, a
   short diff, and
   `agent-bot soul revision edit BILL_ID SCRATCH 'Codex researcher' --apply`
   (`--apply` publishes it into Bill's folder; without it the edit is only
   recorded). They may also approve it through GeniusBar's Customize.
7. **Launch and verify.** Bill's home is rebuilt before each launch. Then:
   `agent-bot soul revision history BILL_ID`, `agent-bot soul profile
   BILL_ID --json`, `agent-bot population show BILL_ID --json` (role,
   description, model, mode), and `send_message` Bill a small research task
   that needs a web search. If the answer shows no search, say so; do not
   guess a fix.

## (b) "Give the team a shared skill"

- **A skill in each package.** Add `skills/<name>/SKILL.md` (front matter
  `name` equal to the directory, `description` at most 1024 characters) to
  each soul's scratch copy, then steps 5 to 7 of (a) per soul. Your own soul:
  `agent-bot soul revision propose YOUR_ID SCRATCH 'reason'`.
- **A catalogued skill.** `agent-bot skill <name> [--json]` prints a
  bundled skill (`agent-bot`, `agent-space`, `thread-orders`); `--json`
  gives its `path`. Copy that skill's directory into the package as above,
  never a reference to the app bundle.
- **A shared SOP.** Add `agent-sop.toml` (and any `sop/` documents) to each
  soul, or point every soul's `agent-sop.toml` at one repository (see the
  `sop` skill). `agent-bot sop trust REPO` is owner-gated.
- **Verify:** `agent-bot soul profile ID --json` lists the skills;
  `agent-bot sop --json --soul ID` shows the SOP in effect.
- Do not: put a skill in GeniusBar's or agent-bot's install, or edit a
  soul's `.claude/skills/` (generated by `soul build`).

## (c) "Change a harness setting, model, mode, comms, computer use or sandbox"

Package defaults (`harness` / `harnesses.<name>` in `soul.json`) go through
recipe (a) steps 4 to 7. Live settings are owner-gated; `show` and
`resolve` are reads you may run:

| Setting | Read | Change (the person runs it, or GeniusBar's Details) |
| --- | --- | --- |
| Model | `agent-bot soul model ID show --json` | `soul model ID set MODEL_ID` / `clear` |
| Mode | `agent-bot soul mode ID show --json` | `soul mode ID safe` / `autopilot` |
| Comms | `agent-bot soul comms ID show --json` | `soul comms ID on` / `off` |
| Computer use | `agent-bot soul computer-use ID show --json` | `soul computer-use ID on` / `off` |
| Sandbox | `agent-bot sandbox resolve ID --json`, `sandbox override ID show --json`, `sandbox status --json` | `sandbox override ID inherit` / `sandboxed` / `unrestricted` |

Ask in one message: the soul, the current value (from `show`), the value
you propose, why, and the command. Then verify with `show` or `population
show`. Never propose `autopilot`, computer use `on` or `unrestricted`
unless the person asked for it.

## (d) "Who is doing what?"

```sh
agent-bot population list --status active --json   # role, roleLine, parentId, children, mode, model, paused
agent-bot population show <agentId|name> --json
agent-comms task list --state working
```

`fleet` shows who you can message now, with harness and parent. A launch
in progress shows its stage (`checking`, `account`, `joining`, `harness`,
`session`) in GeniusBar; it is the owner's view (agent-comms
`launch-status`), not a soul command. `agent-bot soul asides` (who said
what to whom) is owner-only. Report names, roles, parents and task states;
ask a teammate directly when you need its status.
