---
name: identities
description: Agent IDs, agent-bot doctor and GitHub App identities for souls. Use when asked who a soul is, why an identity or GitHub setup is not working, or to give a soul a GitHub App.
---

# Identities, doctor and GitHub Apps

Describes **agent-bot 0.10.33**. Check `agent-bot --version`; if it
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
agent-bot doctor --probe-inbox --json   # also probe the gh-app-hook inbox (one bounded network call, no bearer)
```

`doctor` is read-only and makes no network call unless `--probe-inbox` is
given. It shows each gate, including whether the `github-identity` feature
is on. Off is a choice, not a fault to work around.

## GitHub Apps

A GitHub App is optional: souls message each other with none. An App is
only for acting on GitHub (push, pull requests, `gh`).

- A soul declares its App by slug in `soul.json`
  (`credentials.github.app`), its key lives in that soul's own key store
  (credentials skill), and the daemon mints short-lived tokens for it.
- `agent-bot identity apps list --json` is a secret-free read: per App its
  slug, bot login, `keyPresent`, `key: {fingerprint, updatedAt} | null`,
  installations, harnesses, souls and last mint status.
- The person's steps (their GitHub account and keys; each App operation
  needs their approval): `identity app create --manifest
  [--name NAME] [--org ORG] [--open]`, `identity app connect`,
  `identity app rotate-key SLUG`, `identity app assign SLUG (--harness H|--soul
  AGENT_ID)`, and `identity migrate-credentials` (`--dry-run --json` shows
  the plan). Propose the command; never pass a key path yourself.
- Installing an App on repositories is the person's decision on GitHub.

Anything that creates, installs, moves or removes an App or identity needs
the person's approval first.
