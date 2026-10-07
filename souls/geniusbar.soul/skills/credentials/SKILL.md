---
name: credentials
description: How souls hold credentials by reference (per-soul key stores, keyd, secret providers) without secrets entering any context. Use when asked to give a soul access to GitHub or a password or API key.
---

# Credentials by reference

Describes **agent-bot 0.10.33**. Check `agent-bot --version`; if it
differs, follow `agent-bot --help`.

## The rule

A soul names a credential; it never holds one. Keys, tokens, passwords and
principal secrets never go in `soul.json`, `AGENTS.md`, a skill, a message,
a log, or your context. If one appears, stop and tell the person.

## GitHub App keys

`soul.json` declares only the App and where its key lives:

```json
{ "credentials": { "github": { "app": "APP-SLUG", "store": "keyd" } } }
```

- `store` is `keychain` (macOS default), `file`, `keyd` or `pass-cli`.
  GeniusBar ships `agent-bot-keyd`, a signed key holder: the key never
  leaves it, and it asks the person (Touch ID or password) before importing
  or removing one.
- agent-bot rejects any other key under `credentials`, so key material
  cannot be packaged by mistake. Spawned copies carry the declaration, not
  the key; a fork drops a declaration naming the original's App.
- At run time the daemon mints a short-lived installation token for the soul.
  Git in a configured worktree uses it through the credential helper.

Read-only checks:

```sh
agent-bot keyd status --json
agent-bot identity apps list --json            # per App: keyPresent, key {fingerprint, updatedAt}, souls; never the key
agent-bot soul profile <agentId|name> --json   # lists declared credential names
agent-bot doctor --json
```

Adding a declaration to a soul is a `soul.json` change, so it is a revision
the person approves (soul-packages skill). Importing or moving a key is the
person's step (`agent-bot identity migrate-credentials --soul ID --dry-run
--json` shows the plan; they run it, owner-only).

## Other secrets

`agent-bot secret get --provider ID --collection NAME --item TITLE --field NAME --reason TEXT`
reads one value from a provider the person already signed in to, with an
audit reason. Use it only when the person asked for that exact secret to be
used, never to print it, and never search other providers.
