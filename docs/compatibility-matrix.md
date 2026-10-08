# Bundled component compatibility matrix

**Issue:** qwts/GeniusBar#282 · **Decision:** [ADR-0282](decisions/ADR-0282-component-compatibility-and-recovery.md) · **Evidence as of:** 2026-10-07

GeniusBar bundles pinned releases of agent-comms (the broker) and agent-bot
(the identity daemon) with its own Node (ADR-0004). This document records
what each published app release bundled, what the pinned readers and writers
do with data a different release wrote, and which upgrade and downgrade pairs
were exercised. It is evidence, not policy; the policy is ADR-0282. Claims
marked **hypothesis** were read in the code but not run.

Reproduction: `node scripts/compat-check.mjs` runs every pair in
`DEFAULT_PAIRS` against the exact pinned commits (fetched with the same
tag-and-commit check as `scripts/fetch-components.mjs`, into
`.cache/compat-engines`); `--pair agent-bot:vWRITER:vREADER` runs one. The
fixtures under `bridge/fixtures/compat/` were recorded with `--record` and
replay in `bridge/compat.test.mjs` against the engines this build bundles.
Every run uses a scratch `HOME`, `XDG_STATE_HOME` and `AGENT_*` directories;
nothing touches the account's own state, keychain or services.

## 1. Published tuples

From `gh release list` on qwts/GeniusBar, qwts/agent-comms and
qwts/agent-bot-identity, and `components.json` at each GeniusBar tag
(`gh api repos/qwts/GeniusBar/contents/components.json?ref=vX.Y.Z`).

| GeniusBar | Node | git | agent-comms | agent-bot | Notes |
| --- | --- | --- | --- | --- | --- |
| 0.1.20 | 24.21.0 | — | v0.3.8 `1304da90` | v0.10.21 `9bef50a3` | |
| 0.1.25 | 24.21.0 | — | v0.3.11 `b528b928` | v0.10.26 `21ba2462` | agent-bot adds the `brief` and `sandbox` census fields |
| 0.1.30 | 24.21.0 | — | v0.3.11 `b528b928` | v0.10.29 `602af7fb` | |
| 0.1.35, 0.1.38 | 24.21.0 | — | v0.3.13 `cc722edc` | v0.10.33 `59b17a07` | agent-comms adds the `launch-progress` log record |
| 0.1.39 | 24.21.0 | — | v0.3.14 `42972965` | v0.10.34 `a6711fb9` | |
| 0.1.40 | 24.21.0 | — | v0.3.14 | v0.10.35 `732f8952` | |
| 0.1.41 | 24.21.0 | — | v0.3.14 | v0.10.36 `0d10a3d5` | |
| 0.1.42 – 0.1.48 | 24.21.0 | — | v0.3.14 | v0.10.37 `fc10f705` | |
| 0.1.49 | 24.21.0 | — | v0.3.14 | v0.10.38 `768b0b9b` | |
| 0.1.50 | 24.21.0 | — | v0.3.14 | v0.10.40 `80d3b665` | |
| 0.1.51, 0.1.52 | 24.21.0 | — | v0.3.14 | v0.10.42 `4e4712b0` | |
| (0.1.53) | 24.21.0 | 2.56.0 | v0.3.14 | v0.10.44 `cd4e62bc` | tag exists, no release was published; first tag to bundle git (#102) |
| 0.1.54 | 24.21.0 | 2.56.0 | v0.3.14 | v0.10.45 `e5671fbd` | |
| 0.1.55 | 24.21.0 | 2.56.0 | v0.3.14 | v0.10.46 `cbf361dd` | |
| 0.1.56 | 24.21.0 | 2.56.0 | v0.3.14 | v0.10.47 `6e681862` | |
| 0.1.57 | 24.21.0 | 2.56.0 | v0.3.14 | v0.10.48 `45a2063d` | |
| 0.1.58, 0.1.59 | 24.21.0 | 2.56.0 | v0.3.14 | v0.10.49 `a5e7e7b3` | |
| 0.1.60 | 24.21.0 | 2.56.0 | v0.3.14 | v0.10.50 `a3783128` | latest release |
| main (`a06b87c`, unreleased) | 24.21.0 | 2.56.0 | v0.3.14 | v0.10.51 `db6ed2dc` | agent-bot v0.10.52 is published but not yet pinned |

Platform and sidecar notes:

- Every release in the window is a signed universal macOS build with the
  updater archive, its signature and `latest.json`; no release carries a
  Windows installer (ADR-0046 remains Proposed). The updater only ever moves
  forward: `latest.json` is served from `releases/latest`, so a downgrade is
  a manual install of an older dmg.
- `agent-bot-keyd` is built from this repository's `keyd/` crate
  (`scripts/build-keyd.mjs`, since 0.1.10), so its version is the app's.
  `agent-bot keyd install` exists since agent-bot v0.10.12; every tuple
  above has it. `bridge/services.mjs` tolerates an agent-bot without it
  (`keyd: 'unavailable'`).
- The bundled git (2.56.0) is on `AGENT_BOT_TOOL_PATH` since 0.1.53; older
  releases used the system git.
- Component pins are monotonic across releases: no published GeniusBar ever
  bundled an older agent-comms or agent-bot than its predecessor. An app
  downgrade therefore is a component downgrade, which is what the host
  guard in ADR-0282 keys on.
- There is no version negotiation between the app and its components
  beyond what §2.1 lists; the pin in `components.json` is the contract
  (ADR-0059 decision 1).

## 2. Compatibility dimensions

Citations are `file:lines` at the pinned commits: agent-comms v0.3.14
(`42972965`), agent-bot v0.10.50 (`a3783128`, the latest released pin; the
same lines exist at v0.10.51 unless noted), and this repository at the
commit of this document.

### 2.1 Wire and protocol

| Channel | What the pinned code does | Newer peer, older reader | Evidence |
| --- | --- | --- | --- |
| Bridge ↔ broker (Unix socket, JSON lines) | `PROTOCOL_VERSION = 1` (`lib/wire.mjs:12`), sent as `v` with every request (`lib/client.mjs:46`). Bridge and broker ship in the same bundle. | Only during the window between an app swap and `refresh` restarting the broker. The bridge strips launch fields older brokers refuse (`bridge/bridge.mjs:27-31`). | All releases since 0.1.39 share one agent-comms commit, so no released pair differs. **Hypothesis:** the exact rejection a mismatched `v` or unknown field produces was not exercised. |
| Daemon ↔ broker | The daemon pairs by public key (`daemon-pair-request` record) and calls the agent-comms CLI from `AGENT_BOT_TOOL_PATH`, i.e. the same bundle. | Same window as above; `refresh` restarts broker then daemon (`bridge/services.mjs`, `refreshServices`). | Not a released pair. |
| Daemon HTTP API (`daemon.json` state file) | Every response carries `schemaVersion: 1`; the state file must be exactly `schemaVersion === 1` or "daemon state file has an unsupported shape" (`agent-daemon.mjs:313-323`). | A future `daemon.json` makes an older CLI's `daemon status`/`install` fail closed with that message. | **Hypothesis:** no release changed it. |

### 2.2 Persistent state

| Store (owner) | Path | Writer / reader at the pin | Newer data under an older reader | Evidence |
| --- | --- | --- | --- | --- |
| Broker event log (agent-comms) | `$XDG_STATE_HOME/agent-comms-broker/events.jsonl` | Append-only JSON lines, fsynced before the reply (`lib/state.mjs:218-226`); start replays every line (`lib/broker.mjs:79-81`, `lib/state.mjs:194-216`). An unknown `t` throws "unknown log record type …" (`lib/state.mjs:180-183`), so the broker does not start and appends nothing. The one write replay makes is truncating bytes after the last newline, which were never acknowledged (`lib/state.mjs:198-203`). No checkpoint or retention exists at this pin (agent-comms#122 is open). | Record types: `launch-progress` entered at v0.3.13 (`lib/broker/launch.mjs:121`). A log containing it is refused by v0.3.11 and v0.3.8 before any write; all other records in the window replay on every pin. A record no released broker knows is refused by v0.3.14 the same way. | E-C1 … E-C4, T4 |
| Population census (agent-bot) | `$XDG_STATE_HOME/agent-bot/population.json` (`agent-population.mjs:249-255`) | `schemaVersion: 1` (`:46`). Reads accept any version ≥ 1 (`:280-282`); every write refuses a future version with "population store uses a future schemaVersion; refusing to rewrite it" (`:331-333`, `:603`, `:627` and each setter). Rows are rebuilt from the fields `normalizeSoul` knows (`:137-213`) and the whole document is rewritten on any change (`:306-321`), so a field the reader does not know is gone after its first write. `recordSoulLaunch` writes only when a launch fact changes (`:609-612`). | Fields `brief` and `sandbox` arrived at v0.10.26; the row is otherwise unchanged from v0.10.21 through v0.10.52 (`harnessAuth`, `displayName`, `computerUse`, `paused`, `managed`, `comms` all predate v0.10.21). v0.10.21 reads a v0.10.26+ row completely and drops `brief` and `sandbox` on its first rewriting launch, silently. A future `schemaVersion` is refused before writing. | E-B1 … E-B4, E-B5, T1 … T3 |
| Identity records (agent-bot) | `$XDG_STATE_HOME/agent-bot/agent-identities/<id>.json` (`agent-identity.mjs:64-71`) | `schemaVersion` must equal 1 (`agent-identity.mjs:134-137`); any other value is an invalid identity. | A future record fails closed. | **Hypothesis:** unchanged across the inventory. Read by every pair in E-B1 … E-B5. |
| Soul revisions (agent-bot) | `…/agent-identities/soul-revisions/<id>/NNNNNNNNNN.json` and `objects/<sha256>.soul` | Append-only, write-once journal files (`soul-revisions.mjs:61-70`); readers list all and keep `kind === 'revision'` (`:37-43`, `:131-133`); snapshots are content-addressed and re-hashed on read (`:44-52`). Packages of `formatVersion` 1 and 2 are accepted at every pin in the inventory (`soul-package.mjs:157` at v0.10.50, `:103` at v0.10.37, `:53` at v0.10.21; format 2 came with agent-bot#341, before v0.10.21). | An unknown `kind` is ignored and left in place; the chain stays readable. v0.10.50+ also mirrors each revision into `.soul-state/runs/revisions.jsonl` (`:69`), which older engines ignore. | E-B1 … E-B4 (history read by v0.10.21, v0.10.37, v0.10.50), T5 |
| Soul folder `.soul-state/` (agent-bot) | `<soulsRoot>/<name>.soul/.soul-state/` (`souls-root.mjs:6-11`) | v0.10.37 knows `agent-id`, `credentials/`, `home/`, `worktrees/`, `space/`, `harnesses/`, `cache/`, `session`; v0.10.50 adds `migration.json` (`soul-migration-journal.mjs:11-12`), `runs/` (`soul-history.mjs:14-19`), `tmp/`, `runtimes/`, `tools/`. The journal reader treats a malformed or oversize file as empty (`soul-migration-journal.mjs:23-34`) and never deletes it. No pin removes entries it does not know (grep for `rmSync` near `.soul-state` at v0.10.37: none). | Memory under `.soul-state/space` (the census `spacePath`, `soul-memory.mjs:1-11`), the run mirror and the journal survive reads and a census write by every older pin byte for byte. An older engine shows no `soul env` report (the command does not exist before #583) but does not touch the files. | E-B1 … E-B4 (`.soul-state` digest unchanged), T1 |
| Cold wake settings (agent-bot) | `$XDG_STATE_HOME/agent-bot/cold-wake.json` (`cold-wake-settings.mjs:16-19`) | `{schemaVersion: 1, settings}`; the reader ignores `schemaVersion` (`:20-23`); a lane it does not know reads as off (`:28-33`); a write replaces one soul's entry and keeps every other raw value (`:50-56`). | A newer lane for soul A is "off" to an older engine; a write for soul B keeps A's value. | E-B1 … E-B4 (setting read), T6 (preservation at the current pin only) |
| Daemon state, bind tokens, jobs (agent-bot) | `daemon.json`, `bindings.json`, invocation journals | Exact `schemaVersion === 1` (`agent-daemon.mjs:313-323`, `agent-binding.mjs:73-81`); jobs refuse a future version before rewriting (`agent-jobs.mjs:182-187`). | Fail closed with a message that names the file. | **Hypothesis:** unchanged across the inventory. |
| Services stamp (GeniusBar) | `~/Library/Application Support/app.geniusbar/services.json` | `{version}` written after a successful refresh (`bridge/services.mjs`, `refreshServices`); read before the next. | The stamp is what tells a swap from "unchanged" (#34), and from this change what tells a downgrade from an upgrade. | `bridge/services.test.mjs` |
| Principal credential copy (agent-comms) | `$XDG_STATE_HOME/agent-comms/principal.app.geniusbar.principal.json` (`lib/host-config.mjs:53-55`) | Written at pairing beside the keychain item (`lib/platform/secret-store.mjs:30-34`). | Not a format that changed in the window. | **Hypothesis.** |

### 2.3 Credential stores

| Store | Owner | Compatibility |
| --- | --- | --- |
| GeniusBar principal: keychain item `app.geniusbar.principal` plus the file copy above | agent-comms | Same name and shape across the window (ADR-0059 decision 2). An app of any release in the window reads it. **Hypothesis:** the file shape was not diffed across pins. |
| Soul GitHub App keys: keychain `agent-bot.soul.<id>`, or `.soul-state/credentials/`, or keyd | agent-bot (`soul-credentials.mjs:1-40`) | The readable stores are unchanged. keyd items are readable only by GeniusBar's code signature: every signed release shares the Developer ID, so up- and downgrades keep access; an unsigned build cannot read them (ADR-0004 decision 5). `migrate-credentials --to keyd` has no reverse; a release older than agent-bot v0.10.12 would lose access to keyd-held keys, but none is in the inventory. |
| Daemon pairing key | agent-bot / broker log | The public half is in the event log (`daemon-pair-request`); replays on every pin (E-C1 … E-C3). |

### 2.4 Feature and capability gating

| Capability | Gate | Behaviour on mismatch |
| --- | --- | --- |
| `keyd install` | agent-bot ≥ v0.10.12 | `refresh` reports `keyd: 'unavailable'` and continues (`bridge/services.mjs`). |
| Launch `model`, `brief`, `role`, `parent` | agent-comms accepts them from v0.3.13/14 | The bridge only forwards strings and drops the rest so an older broker never sees an unknown field (`bridge/bridge.mjs:27-31`). |
| `soul revision … --json` spelling | agent-bot ≥ v0.10.37 | Older pins print JSON anyway and reject the flag with a usage error (seen in E-B3/E-B4). |
| `soul env`, `.soul-state` migration journal | agent-bot ≥ v0.10.50 (#583) | Absent command on older pins; files untouched. GeniusBar #268 adopts the contract. |
| `soul env clean`, `soul env migrate --complete` | agent-bot ≥ v0.10.54 (capabilities `env-clean`, `migrate-complete`) | The Environment section keeps **Clean up cache** / **Complete setup** disabled with a note unless the descriptor lists the capability; an older engine's usage line maps to `*-unsupported`. |
| `soul env export`, `soul env import` | agent-bot ≥ v0.10.55 (capabilities `env-export`, `env-import`) | **Export life…** / **Import life…** disabled with a note unless listed; same usage-line mapping. |
| `soul env migrate --harnesses-into-runtimes` (and the step inside `--complete`) | agent-bot ≥ v0.10.56 (capability `harnesses-into-runtimes`) | An older engine lists the `harnesses-into-runtimes` step as pending and **Complete setup** leaves it so; the legacy install still launches. No app control is gated on it. |
| `soul env history` | agent-bot ≥ v0.10.57 (capability `env-history`) | The Memory tab's **Past conversations** shows "This agent-bot can't list past runs yet." unless the descriptor lists the capability, and never asks the engine; an older engine's usage line maps to `soul-env-history-unsupported`. Continuity and the memory location still render from `soul env`. |
| Bundled git on `AGENT_BOT_TOOL_PATH` | GeniusBar ≥ 0.1.53 | Older apps use whatever git the system has. |

## 3. Pairs exercised

All runs: `node scripts/compat-check.mjs --pair <component>:<writer>:<reader>`
on 2026-10-07 with the local mirrors as remotes (`--bot-remote`,
`--comms-remote`); the default pair list is the same set. The writer
produces: a minted identity, a soul folder with `.soul-state/agent-id`,
memory and history under `.soul-state/space`, a census row with every field
the writer knows (`sandbox`, `displayName`, `harnessAuth`, `brief` …), a
three-revision package chain, cold wake on, and where the writer has them a
run mirror and a migration journal. The reader runs `population show`,
`soul revision history`, `soul dir`, the library reads in
`scripts/compat-driver.mjs read`, and then one daemon-style write
(`recordSoulLaunch` with comms off and on). For agent-comms the writer
broker records a pairing, two souls, a message, an ack and a principal; the
reader broker replays the log, then once more with `launch-progress`
appended, and the writer once more with a record no release knows.

| ID | Component | Writer → reader | App pair it stands for | Outcome |
| --- | --- | --- | --- | --- |
| E-B1 | agent-bot | v0.10.51 → v0.10.50 | main → 0.1.60 | **Supported.** Reads complete, reads wrote nothing, the launch write kept every field, `.soul-state` unchanged. |
| E-B2 | agent-bot | v0.10.50 → v0.10.37 | 0.1.60 → 0.1.42 … 0.1.48 | **Supported.** As E-B1. |
| E-B3 | agent-bot | v0.10.50 → v0.10.21 | 0.1.60 → 0.1.20 | **Silent loss.** Reads complete and write nothing; the first launch write drops `brief` and `sandbox` with no diagnostic. `.soul-state`, revisions and cold wake unchanged. |
| E-B4 | agent-bot | v0.10.26 → v0.10.21 | 0.1.25 → 0.1.20 | **Silent loss**, the same two fields: the earliest published pair with this gap. |
| E-B5 | agent-bot | v0.10.21 → v0.10.51 | 0.1.20 → main (upgrade) | **Supported.** The newer engine reads the older row with defaults and keeps it on write. |
| E-C1 | agent-comms | v0.3.14 → v0.3.13 | 0.1.39+ → 0.1.35, 0.1.38 | **Supported.** Replays unchanged; v0.3.13 accepts `launch-progress`. |
| E-C2 | agent-comms | v0.3.14 → v0.3.11 | 0.1.39+ → 0.1.25 … 0.1.30 | **Supported** for the records a GeniusBar session writes; **refused** once the log holds `launch-progress` (any launch made on 0.1.35+): "agent-comms: unknown log record type launch-progress", log byte-identical. |
| E-C3 | agent-comms | v0.3.14 → v0.3.8 | 0.1.39+ → 0.1.20 | As E-C2. |
| E-C4 | agent-comms | v0.3.14 + future record → v0.3.14 | the next format change | **Refused** before writing: "unknown log record type mailbox-checkpoint", log byte-identical. |
| E-C5 | agent-comms | v0.3.8 → v0.3.14 | 0.1.20 → 0.1.39+ (upgrade) | **Supported.** |

Not exercised (hypotheses): agent-bot v0.10.29 … v0.10.36 as readers (their
census rows match v0.10.37's, so E-B2 is expected to hold); the daemon's
other journals under `$XDG_STATE_HOME/agent-bot` (wake sessions, launch
requests, task turns) across pins; keychain-backed stores (the runs use
`AGENT_COMMS_NO_KEYCHAIN=1` and file credentials); Windows.

## 4. Summary

| From → to | agent-comms | agent-bot census | Soul folder, revisions, cold wake | Verdict |
| --- | --- | --- | --- | --- |
| Any → newer (upgrade) | replays | reads with defaults, keeps on write | kept | **Supported** (E-B5, E-C5) |
| 0.1.60 ↔ 0.1.42 … 0.1.59 | same commit | same row format | kept | **Supported** (E-B1, E-B2) |
| 0.1.60 → 0.1.39 … 0.1.41 | same commit | same row format | kept | Supported, **hypothesis** (not run) |
| 0.1.39+ → 0.1.35, 0.1.38 | replays, knows `launch-progress` | same row format | kept | **Supported** (E-C1) |
| 0.1.39+ → 0.1.25 … 0.1.30 | refused with a diagnostic once a launch was made on 0.1.35+; replays otherwise | same row format | kept | **Refused** (safe) or supported (E-C2) |
| 0.1.25+ → 0.1.20 | as above | drops `brief` and `sandbox` silently on the first launch | kept | **Silent loss** (E-B3, E-B4): the path ADR-0282's host guard holds |
| Future format → any current pin | refused, log unchanged | future schema refused before writing; same-schema new fields dropped on the first write | unknown journal kinds and `.soul-state` entries ignored, never deleted | Refused or silent loss by store (E-C4, T2, T3) |

The bundled fixtures (`bridge/fixtures/compat/`, written by agent-bot
v0.10.51 and agent-comms v0.3.14) and `bridge/compat.test.mjs` are the
release gate ADR-0282 names: every build proves that the engines it bundles
read that state, keep it on write, and refuse what they cannot read before
writing.
