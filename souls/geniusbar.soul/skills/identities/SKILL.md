---
name: identities
description: Agent IDs, agent-bot doctor and GitHub App identities for souls. Use when asked who a soul is, why an identity or GitHub setup is not working, or to give a soul a GitHub App.
---

# Identities, doctor and GitHub Apps

Describes **agent-bot 0.10.23**. Check `agent-bot --version`; if it
differs, follow `agent-bot --help`.

## Agent IDs

Every soul has an Agent ID, minted when it is spawned, recorded in the
census and pinned in its checkouts. Read-only commands:

```sh
agent-bot identity current --json     # the Agent ID of this checkout or environment
agent-bot identity show AGENT_ID      # its identity record (JSON)
agent-bot population show <agentId|name> --json
```

You act only under your own ID. Never mint, bind or finalize an identity
for someone else (`identity ensure|spawn|bind|record|finalize` are for the
runtime and the person).

## Diagnose

```sh
agent-bot doctor --json                 # readiness schema JSON
agent-bot doctor --machine-only --json  # skip this worktree
agent-bot doctor --app SLUG --json      # also check one App
```

`doctor` is read-only. It shows each gate, including whether the
`github-identity` feature is on. Off is a choice, not a fault to work around.

## GitHub Apps

A GitHub App is optional: souls message each other with none. An App is
only for acting on GitHub (push, pull requests, `gh`).

- What exists today: a soul declares its App by slug in `soul.json`
  (`credentials.github.app`), its key lives in that soul's own key store
  (credentials skill), and the daemon mints short-lived tokens for it.
- Moving keys into soul stores is owner-only:
  `agent-bot identity migrate-credentials --soul ID|NAME --dry-run --json`
  shows the plan; the person runs it without `--dry-run`.
- Creating and installing a new GitHub App from GeniusBar is being added. Until
  it ships, tell the person the App must be created on GitHub by them, and
  that installing it on repositories is their decision.

Anything that creates, installs, moves or removes an App or identity needs
the person's approval first.
