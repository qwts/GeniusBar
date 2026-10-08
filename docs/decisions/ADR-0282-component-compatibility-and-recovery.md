# ADR-0282: Bundled components are compatible by evidence, and the host holds what it cannot prove

**Status:** Proposed
**Date:** 2026-10-07
**Issue:** qwts/GeniusBar#282

## Context

GeniusBar bundles pinned releases of agent-comms and agent-bot with its own
Node (ADR-0004 decision 3, agent-comms ADR-0059 decision 1) and restarts
the login services onto the new files at the first launch after an update
(ADR-0004 decision 4, `bridge/services.mjs` `refresh`, #34). Moving over
from a Homebrew install reuses the same state directories (#41, PR #44).
The persistent state those services write — the broker's event log, the
population census, identity records, soul revisions, each soul's
`.soul-state`, cold wake settings, credential stores — is owned by the
components, and their readers were pinned without any statement of which
older release can still read what a newer one wrote.

The [compatibility matrix](../compatibility-matrix.md) inventories the
published tuples (0.1.20 … 0.1.60 and main) and exercises the exact pinned
engines against each other. Its findings:

- Every upgrade pair is supported: newer readers take older state with
  defaults and keep it on write (E-B5, E-C5).
- agent-comms refuses a log it cannot read before it writes anything, with
  a diagnostic that names the record (`lib/state.mjs:180-183`): a
  v0.3.13+ log holding `launch-progress` under a v0.3.11 or v0.3.8 broker
  (0.1.39+ → 0.1.25 … 0.1.30, 0.1.20), and any future record under v0.3.14
  (E-C2 … E-C4). Nothing is dropped.
- agent-bot refuses a future census `schemaVersion` before writing (T2),
  ignores and keeps `.soul-state` entries and revision journal kinds it
  does not know (E-B2 … E-B4, T5), but rebuilds census rows from the fields
  it knows and rewrites the whole file on the daemon's first launch write:
  `brief` and `sandbox`, added at v0.10.26, are dropped silently by
  v0.10.21 (0.1.25+ → 0.1.20; E-B3, E-B4). From v0.10.26 through v0.10.52
  the row is unchanged, so 0.1.25 … main downgrade among themselves
  without loss.
- Component pins are monotonic across releases, the updater only moves
  forward, and `refresh` restarts services on any version change, up or
  down, without distinguishing the two.

Both ADR-0004 and ADR-0059 are Proposed; this record does not promote them.

## Decision

1. **The update contract stays.** `components.json` pins each component to
   a release tag and commit; a GeniusBar release bundles exactly those; the
   updater reads `releases/latest`; `refresh` reconciles the login services
   at the first launch under a new version and stamps it. Two rules are
   added to that contract: component pins never move backwards between
   releases, and a pin change is a compatibility event (decision 8).

2. **Compatibility is kept per dimension**, as the matrix separates them:
   wire and protocol (bridge ↔ broker, daemon ↔ broker, the daemon's
   HTTP API); persistent state (event log, census, identities, revisions,
   `.soul-state`, cold wake, daemon state and bindings, the services
   stamp); credential stores (principal, soul keys, keyd); feature gating.
   A claim about one dimension never stands for another: "the broker
   started" says nothing about the census.

3. **Supported versions and the minimum reader.** An upgrade from any
   published release is supported. A downgrade is supported only to a
   release whose pinned engines pass the compatibility test against state
   the newer release writes; that release is the **minimum reader** of the
   newer one. Today the minimum reader of 0.1.60 (and main) is **0.1.39**:
   the first release bundling agent-comms v0.3.14, with the census row
   unchanged since v0.10.26. Earlier releases either refuse (0.1.25 …
   0.1.38 once a launch was recorded) or lose fields (0.1.20). The minimum
   reader is recorded in the matrix at every pin change and named in the
   release notes when it rises.

4. **Formats belong to the components; host policy belongs to GeniusBar.**
   - A component owns its state formats, their forward migrations and its
     reader guards. The guard this ADR expects of every store is
     *refuse-before-write*: a reader that meets data it does not understand
     stops with a diagnostic naming the store and the record, before it
     appends, truncates committed data, or rewrites. agent-comms' log meets
     it. agent-bot's census meets it for a schema bump and not for a
     same-schema field: closing that is the component's follow-up (F1),
     because only the component knows which fields are facts to preserve.
   - GeniusBar owns when services restart, what it refuses to do on the
     user's behalf, backups, the recovery path the user sees, and the
     release gate. It never rewrites component state itself.

5. **Downgrade is refusal, not recovery.** Because the component guard is
   incomplete (decision 4) and the host cannot know which fields a newer
   release added, `refresh` now **holds** when the running app is older
   than the stamped version: nothing is restarted, re-registered or
   re-stamped, the units keep running the files they loaded, and the result
   reports `held` with `downgrade: {from, to}` (`bridge/services.mjs`,
   `refreshServices`; tests in `bridge/services.test.mjs`). The recovery
   path is to install the newer release again, which is always published.
   `GENIUSBAR_ALLOW_DOWNGRADE=1` accepts the downgrade for the testing
   workflow in `docs/testing-updates.md` and for an owner who restored a
   backup. The hold is the host's fail-before-write, not a guarantee: a
   reboot or a crash starts whatever is on disk, which is why the component
   guard (F1) remains the real fix.

   `migrate` likewise refuses another install whose broker or daemon names a
   version newer than the bundled one (`migrate-downgrade`), before it
   stops anything; the message says to update GeniusBar first. A unit whose
   version cannot be read moves as before.

6. **Backup before upgrade, and what restore covers.** GeniusBar will take
   a snapshot of the state directories (`$XDG_STATE_HOME/agent-bot`,
   `$XDG_STATE_HOME/agent-comms-broker`, the services stamp) before the
   first `refresh` under a new version, keeping the last few (F3). Restore
   is an explicit owner action that moves the current directories aside and
   copies the snapshot back, then holds until the matching release runs.
   Restore covers census rows and fields, event log records, identities,
   revision journals and snapshots, and cold wake settings **as they were at
   the snapshot**. It does not cover data accepted after it: messages,
   acks, pairings, launches, revisions, settings and sign-ins made under the
   newer release are lost by a restore, and the app says so before doing
   it. It does not cover soul folders (`.soul-state` lives under the souls
   root and, by the evidence, needs no restore: older engines ignore what
   they do not know and delete nothing), keychain items, or another
   install's units. "The old snapshot loads" is never read as lossless.

7. **Startup ordering, readiness and the recovery the user sees.** The
   order is broker, then daemon, then keyd, as `refresh` and `migrate`
   already do; readiness is `broker pairings` answering, `daemon status
   --json` reporting `running`, and `keyd install` returning its label.
   What the app shows and offers, per outcome:

   | Outcome | Cause, by the evidence | Shown | Recovery offered |
   | --- | --- | --- | --- |
   | Both start | Same or newer release, or a downgrade within the minimum reader | Nothing | — |
   | Broker only | Daemon refused its state (future `daemon.json`, invalid identity) or crashed | "Identity daemon is not running" with the daemon log's last diagnostic line | Set up again; install the release that wrote the state; restore a snapshot |
   | Daemon only | Broker refused the log ("unknown log record type …") | The broker's diagnostic naming the record | Install the release that wrote the log (the log is intact); restore a snapshot |
   | Neither | Hold on downgrade, or both refused | "GeniusBar X is older than the Y that wrote your data" with the hold | Install Y again; accept the downgrade knowingly |
   | Failed migration from another install | GeniusBar's units did not answer in time, or `migrate-downgrade` | The existing message: the previous services were started again (or could not all be) | Retry; update GeniusBar first |

   Service rollback (`migrateServices`) restores registrations and
   processes and is kept as is; it never restores data, and the matrix is
   what says whether the data is compatible. The two are reported apart.

8. **Release validation gate.** Every release must prove, in CI before the
   tag: the bundled engines read the committed fixtures
   (`bridge/fixtures/compat/`, `bridge/compat.test.mjs`), keep every field
   on a write, and refuse what they cannot read before writing. Every
   change of a component pin must additionally re-record the fixtures with
   the new pin, run `scripts/compat-check.mjs` for new pin → previously
   released pin, and record the verdict in the matrix. A `silent-loss`
   verdict blocks the pin until the component ships its reader guard or
   the minimum reader is raised and named in the release notes. Pins must
   not move backwards. The tag-to-version check in the Release workflow
   stays.

## Consequences

- A user who installs an older GeniusBar over a newer one no longer gets
  older engines restarted onto newer state unasked; they get a hold and a
  named way out. Until F4 lands the hold is visible only in the app log
  line `services: {...}`.
- Moving over from a Homebrew install that is ahead of the bundle is
  refused with a reason instead of silently rewriting the census.
- The compatibility test runs in CI with the fetched components and skips
  without them; the pair runner needs git access to the component
  repositories (or local mirrors) and is run by hand at pin changes.
- The census gap (F1) is the component's to close; this record documents
  it rather than papering over it in the host.
- Backups (F3) and the user-visible recovery (F4) are specified here and
  not yet built; the matrix and the hold ship now.
- Windows (ADR-0046) and keychain-backed stores are not covered by the
  evidence; both are hypotheses in the matrix.

## Alternatives

- **Backward-readable evolution only** (every reader tolerates every
  future shape): rejected as the sole policy. agent-bot's census shows the
  failure mode — tolerant reads plus whole-file rewrites lose fields
  silently — and it cannot be imposed on a component from the host.
- **Fail-before-write version checks only**: adopted for components
  (decision 4) and mirrored in the host (decision 5), but a host check on
  the app version is coarse (it holds a harmless downgrade such as
  0.1.60 → 0.1.59) and cannot stop launchd after a reboot.
- **Backup and restore as the primary answer**: rejected as primary because
  restore loses everything accepted after the snapshot (decision 6); kept
  as the explicit last resort.
- **Store the minimum reader in `components.json` and refuse to build a
  release below it**: deferred (F5); the matrix carries it until the
  gate is automated.

## Remaining owner decisions

1. Accept this record (code merge is not acceptance).
2. Whether the hold on downgrade should extend to the Tauri updater
   refusing to install below the minimum reader, or stay a services-level
   hold with a manual escape hatch.
3. Retention policy for snapshots (F3): how many, and whether to include
   the souls root.
4. Whether `migrate-downgrade` should offer "move anyway" in the UI, or
   only "update GeniusBar first".
5. Whether F1 (preserve unknown census fields) or a schema bump per field
   addition is the agent-bot contract; this ADR recommends preserving.
6. Whether the minimum reader is published in release notes from 0.1.61 on.

## Follow-up issues (drafts, not filed)

- **F1 — agent-bot: the population census keeps fields it does not know,
  or refuses to rewrite.** `normalizeSoul` rebuilds a row from known fields
  and every setter rewrites the whole file, so a release that does not
  know `brief` or `sandbox` (v0.10.21) drops them on its first launch write
  with no diagnostic (GeniusBar matrix E-B3/E-B4, T3). Carry unknown keys
  through unchanged, or refuse the rewrite with a message naming the keys;
  add a test that a row with an unknown field survives `recordSoulLaunch`.
- **F2 — agent-comms: retention and checkpoints ship with a reader guard
  and a minimum reader (#122).** The event log is replayed whole and an
  unknown record stops the broker before any write (E-C4). When #122 adds
  checkpoint or retention records, keep that property, name the first
  release that reads them, and give the refusal a stable error code hosts
  can show.
- **F3 — GeniusBar: snapshot the state directories before the first
  refresh under a new version, and an explicit restore.** Snapshot
  `$XDG_STATE_HOME/agent-bot`, `$XDG_STATE_HOME/agent-comms-broker` and
  the services stamp; keep the last N; restore moves the current state
  aside, copies the snapshot back, and holds until the matching release
  runs, saying what is lost (everything accepted after the snapshot).
- **F4 — GeniusBar UI: show `held` / `downgrade` and `migrate-downgrade`
  with the recovery path.** The services result now carries `downgrade:
  {from, to}` and `migrate` fails with `migrate-downgrade`; both are only
  in the log line. Show the table in ADR-0282 decision 7, with "install
  GeniusBar Y again" as the primary action (UI through the Lovable
  designs; flag via Dudles).
- **F5 — GeniusBar: `components.json` carries the minimum reader and CI
  runs the pair check on pin bumps.** Add `minimumReader` (GeniusBar
  version) and fail the build when a pin moves backwards; on a pin change
  run `scripts/compat-check.mjs` new → previous pin and `--record` the
  fixtures, failing on `silent-loss`.
- **F6 — agent-bot: verify daemon state, bind tokens and jobs refuse before
  writing.** `daemon.json`, `bindings.json` and invocation journals require
  `schemaVersion === 1`; confirm no path rewrites them after a failed read
  and add them to the compat fixtures.
- **F7 — GeniusBar: cover keychain-backed stores and Windows in the
  compatibility check.** The pair runner uses `AGENT_COMMS_NO_KEYCHAIN=1`
  and file credentials; add a keychain lane on a lab Mac and the DPAPI
  store once ADR-0046 ships.
