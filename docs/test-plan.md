# GeniusBar test plan

This is the durable inventory of regression scenarios for GeniusBar. It covers
the React UI, Rust shell, Node bridge, bundled services, and packaged macOS app.
Windows remains outside this release checklist while [ADR-0046](decisions/ADR-0046-windows-pipe-transport-dpapi-store-and-logon-tasks.md)
is proposed.

## Status and ownership

Initial source review: 2026-10-08. This inventory records test intent and existing
test locations; no test execution or passing result is implied by that review.

- **P0:** release-blocking workflows involving core functionality, data,
  authorization, or recovery.
- **P1:** regular regression scenarios; assess failures for release impact.
- **Planned:** the complete scenario still needs an executable procedure or
  automated integration test, even where related unit tests already exist.
- **Implemented:** an automated test exercises the stated acceptance criteria;
  link its file and the CI job that runs it.
- **Manual-only:** a repeatable agent or human procedure exists; link it and
  explain why it remains manual.

The contributor changing a workflow updates its case and coverage links in the
same PR. The release owner collects results for the candidate build. Keep case
IDs stable, including in implementation issues, tests, and bug reports.

All cases below initially have **Planned** status for complete-workflow
verification. Existing tests are starting points, not proof of complete coverage.
When implementation work is scheduled, link its GitHub issue in the Status cell;
do not replace the acceptance criteria with an issue link. No implementation
issues have been assigned by this inventory.

## Priority cases

| ID | Scenario and setup | Acceptance criteria | Method | Status |
| --- | --- | --- | --- | --- |
| P0-01 | Fresh user with no services or pairing: complete setup, launch the starter, send a message, quit and reopen. | Services become healthy; starter responds; pairing and conversation survive reopening; no duplicate services or soul. | Desktop agent plus service assertions | Planned |
| P0-02 | Existing Homebrew broker/daemon, each running or stopped: choose Keep or Move; inject migration failures, including a plist rename failure. | Keep preserves foreign services. Move preserves state. Failure restores files and each service's original loaded/unloaded state. | Automated fault injection plus isolated macOS check | Planned |
| P0-03 | Interrupt a send before and after broker acceptance; retry; restart during receive/store/ack; inject a storage failure. | Accepted messages are not lost or displayed twice; failed sends retain drafts and retry identity; messages are not acknowledged before durable storage. | Automated integration | Planned |
| P0-04 | Approve, deny, and approve for session; double-click a decision; decide the same proposal from two windows; inject a refusal. | Correct proposal and scope reach the backend; one authoritative decision wins; windows converge; refused decisions remain visible with a reason. | Automated integration plus desktop check | Planned |
| P0-05 | During computer use, Stop via button and hold-Escape. Pause several souls with one backend failure, then Resume. | Correct soul is stopped; UI reflects confirmed state; partial failure is visible; Resume affects only paused souls. | Automated integration plus desktop agent | Planned |
| P0-06 | Terminate bridge, broker, and daemon separately during use; restore them and retry. | Disconnection is visible; recovery needs no duplicate installation; history survives; pending controls settle or offer a retry. | Automated process tests | Planned |
| P0-07 | Update an installed build to a newer test version; repeat with offline endpoint, invalid signature, interrupted download, and an offer left unaccepted. | Accepted valid update restarts into the new version and reconciles services; pairing/history survive; rejected or unaccepted updates leave the installed version usable. | Update harness plus packaged-app check | Planned |
| P0-08 | Approve, cancel, and time out protected owner actions; try expired/replayed grants, invalid signatures, and file paths outside the allowed inventory. | Unauthorized mutations fail; cancellation preserves state without repeated prompting; grant/path violations fail; credential values stay out of UI and captured logs. | Rust/Node tests plus human-assisted native consent check | Planned |
| P1-01 | Reopen the same session repeatedly; open two souls; close/reopen windows; change shared state; fail native window creation. | Correct window is reused/focused; souls remain distinct; state converges; the in-popup fallback works. | Native automation plus desktop agent | Planned |
| P1-02 | Launch from template/custom form, Finder, and drag/drop; use installed, copied, and invalid `.soul` packages; inject launch failure. | Correct form and identity appear; copied packages follow naming/fork rules; installed packages open the existing companion; errors permit recovery without duplicate launches. | Automated integration plus Finder interaction | Planned |
| P1-03 | Edit appearance, role, skills, and editable files; decline authorization; change revision externally before Save. | Accepted edits persist; refusal retains edits; stale revision offers Reload without overwriting newer changes; unrelated fields remain intact. | Automated integration | Planned |
| P1-04 | Cancel archive; archive a stopped soul; attempt while running; inject backend refusal and comms-leave delay. | Cancel changes nothing; refusal retains the soul; successful archive preserves its package and updates roster/windows; pending leave is reported. | Automated integration | Planned |
| P1-05 | Install CLI tools with a conflicting wrapper; replace explicitly; move app; open a new terminal; uninstall. | Wrappers run the current bundle; PATH changes are correct; original wrappers are restored; unrelated shell content and files are preserved. | Filesystem tests plus shell check | Planned |
| P1-06 | Create/connect a GitHub App; reopen during pending creation; change assignment; enable sandboxing; decline consent or use an older unsupported bundle. | Pending creation resumes; authoritative identity/sandbox state appears; refusals preserve prior state; unsupported controls degrade clearly. | Automated integration plus test-account agent run | Planned |
| P1-07 | Exercise empty, large, and deeply nested rosters; long names/messages; English/Spanish; keyboard-only navigation; multiple monitors and display removal. | Controls remain reachable; text does not obscure actions; focus returns correctly; windows remain on-screen; interaction stays responsive. | Browser automation plus exploratory desktop agent | Planned |

For P1-07, record fixture sizes, hardware, and timings. Establish a repeatable
baseline before setting a performance gate; a subjective impression is not a
performance result.

## Existing coverage to extend

These are representative entry points, not an exhaustive coverage audit. Inspect
the assertions before deciding whether a particular failure case is covered.

| Cases | Existing tests or procedure |
| --- | --- |
| P0-01, P0-02 | [Setup tests](../bridge/setup.test.mjs), [service tests](../bridge/services.test.mjs), [first-launch UI tests](../ui/src/components/FirstLaunch.test.tsx) |
| P0-03 | [Chat tests](../ui/src/useChat.test.ts), [chat merge tests](../ui/src/model/chatMerge.test.ts), [bridge framing tests](../bridge/bridge.test.mjs) |
| P0-04 | [Chat/decision tests](../ui/src/useChat.test.ts), [approval UI tests](../ui/src/components/ApprovalsList.test.tsx), [cross-window chat tests](../ui/src/useChat.windows.test.ts) |
| P0-05 | [Pause tests](../ui/src/usePause.test.ts), [floating control tests](../ui/src/components/FloatingDudle.test.tsx), [perimeter tests](../ui/src/usePerimeter.test.tsx) |
| P0-06 | [Census tests](../ui/src/useCensus.test.ts), [Rust bridge tests](../src-tauri/src/bridge.rs), [service tests](../bridge/services.test.mjs) |
| P0-07 | [Updater procedure](testing-updates.md), [updater script tests](../scripts/updater.test.mjs), [Rust updater tests](../src-tauri/src/updates.rs), [UI updater tests](../ui/src/useUpdates.test.ts) |
| P0-08 | [Grant validation tests](../keyd/src/grant.rs), [owner-presence tests](../keyd/src/presence.rs), [Rust bridge validation tests](../src-tauri/src/bridge.rs), [credential-display tests](../ui/src/components/CustomizeDialog.test.tsx) |
| P1-01 | [Native surface routing tests](../ui/src/App.surfaces.test.tsx), [cross-window chat tests](../ui/src/useChat.windows.test.ts), [team-window tests](../ui/src/useTeamWindows.test.tsx) |
| P1-02 | [Launch tests](../ui/src/useLaunch.test.ts), [package UI tests](../ui/src/soulPackage.test.tsx), [native package tests](../src-tauri/src/soul_package.rs) |
| P1-03 | [Customize dialog tests](../ui/src/components/CustomizeDialog.test.tsx), [revision edit validation](../src-tauri/src/bridge.rs) |
| P1-04 | [Archive dialog tests](../ui/src/components/ArchiveDialog.test.tsx) |
| P1-05 | [CLI tools tests](../bridge/cli-tools.test.mjs), [CLI tools UI tests](../ui/src/components/CliTools.test.tsx) |
| P1-06 | [Identity UI tests](../ui/src/components/IdentityApps.test.tsx), [sandbox UI tests](../ui/src/components/Sandbox.test.tsx), [identity bridge tests](../src-tauri/src/bridge.rs) |
| P1-07 | [Browser fixtures](../ui/src/model/fixtures.ts), [locale tests](../ui/src/locales/locales.test.ts), [keyboard tests](../ui/src/lib/keys.test.tsx), [desktop UI tests](../ui/src/components/Desktop.test.tsx) |

## Test layers and execution environments

### Deterministic automation

Keep focused assertions in the existing Vitest, Node, and Rust suites. Extend
them with controlled failures, deterministic clocks where needed, and backend
state assertions. A clicked button or disappeared dialog is not sufficient
evidence of a successful mutation.

[CI](../.github/workflows/ci.yml) currently runs UI checks, bridge/script tests,
Rust shell and keyd checks, and an unsigned bundle build. It does not yet contain
a dedicated native UI interaction job. Run heavy end-to-end and performance
suites in CI or dedicated test infrastructure, following the shared SOP.

### Browser fixtures

Use [preview.tsx](../ui/src/preview.tsx) for layout, navigation, keyboard, locale,
and screenshot checks. Useful routes include:

- `/preview.html?mode=tray`
- `/preview.html?mode=window`
- `/preview.html?surface=session&soul=user/agent_p`
- `/preview.html?mode=window&dudle=computer`
- `/preview.html?open=copy`

The preview's Send and Launch handlers are currently no-ops. Add deterministic,
stateful fixtures and failure modes before claiming workflow coverage there.
Fixture checks do not establish that IPC, broker delivery, native windows, or
services work.

### Native and packaged-app checks

Use the [documented launch flags](../README.md#launch-flags):

- `--window` exposes the app for desktop interaction, but uses a different
  presentation path from the tray's native pop-out windows. Check both paths.
- `--snapshot` provides a static native render. Verify success/error exit codes,
  the JSON report, invalid detail IDs, and unwritable output paths. Confirm that
  snapshot mode does not poll/ack inboxes, refresh services, or check updates.
- Test the actual release candidate for tray behavior, Finder opening, window
  focus/placement, service registration, native consent, and update/restart.

Use disposable macOS users or machines for service, migration, Keychain, and
update scenarios. Redirecting filesystem paths alone does not isolate launchd's
GUI domain; the [setup integration test](../bridge/setup.test.mjs) explicitly
guards against registering services in the real user's session. Use test
identities and disposable souls. Serialize agents sharing a GUI session.

For updates, follow [testing-updates.md](testing-updates.md), substituting a
version newer than the installed test build for its historical example values.
Use throwaway updater keys and keep test configuration out of shipped builds.

## Agent missions and evidence

Begin with three bounded missions: new-user setup (P0-01/P0-02), daily use
(P0-03/P0-04/P1-01), and recovery/update (P0-05/P0-06/P0-07). Give each run explicit
case IDs, starting state, allowed test accounts, and acceptance criteria.

Before marking a case Manual-only, add a repeatable procedure under
`docs/testing/` and link it from the case. Each procedure must define setup,
numbered actions, observable assertions, timeouts, cleanup, and required
evidence. Native owner-consent approval may require a human; record that
dependency rather than treating a blocked prompt as success.

Record each result in a CI artifact or release issue using this structure:

```text
Case ID:
Result: PASS | FAIL | BLOCKED | NOT RUN
Commit and artifact version:
Environment: macOS version, architecture, test account/fixture, app mode
Preconditions and injected failure:
Steps performed:
Expected result:
Observed UI and backend state:
Evidence: screenshots, relevant redacted logs, message/proposal IDs
Cleanup result:
Bug or follow-up issue:
```

PASS requires evidence for every acceptance criterion exercised by the case.
List unexercised variants as NOT RUN. An unavailable control, denied permission,
or failed environment setup is BLOCKED, not PASS. Preserve the initial failure
and any retry result. Do not attach credentials or private keys to evidence.
Convert reproducible agent findings into deterministic regression tests where
practical.

## Delivery order and release use

1. Implement complete fresh setup, chat retry/persistence, approval decisions,
   native-window synchronization, and update/restart checks first: P0-01,
   P0-03, P0-04, P1-01, and P0-07.
2. Add the remaining P0 fault-injection and authorization cases, then P1 cases.
3. Keep fast checks on PRs; add heavier integration runs in CI and native checks
   against the packaged release candidate. Link new CI jobs from this plan.
4. Before release, collect P0 results for the candidate commit/artifact. A failed,
   blocked, or unrun P0 is an unresolved release gate; the release owner must
   explicitly disposition it with a reason and follow-up issue before shipping.
   Triage P1 failures for their actual impact.

Implementation status belongs here; per-build PASS/FAIL belongs in run evidence.
Update coverage links when tests move and add new cases when workflows gain
new behavior. Keep detailed procedures linked rather than duplicating them.
