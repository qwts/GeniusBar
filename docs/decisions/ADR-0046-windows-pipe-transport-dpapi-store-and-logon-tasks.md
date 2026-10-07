# ADR-0046: Windows runs the same services over a named pipe, a DPAPI store, and logon tasks

**Status:** Proposed
**Date:** 2026-10-08
**Issue:** qwts/GeniusBar#46

## Context

ADR-0004 chose Tauri so one codebase could reach Windows, and agent-comms
[ADR-0059](https://github.com/qwts/agent-comms/blob/main/docs/decisions/ADR-0059-host-apps-embed-agent-comms.md)
put every platform-specific behaviour behind four seams, each with a macOS
implementation and a `platform-not-implemented` stub on `win32`. Nothing
under the seams has been designed for Windows, and this record is that
design. What is macOS-only today:

- **Transport and custody.** The broker listens on a Unix socket in a shared
  directory. A client trusts the broker only after checking that the socket,
  its directory and every ancestor are owned by the broker account named at
  pairing, and that the socket is mode 0600 (one account) or 0660 with the
  persona group (`persona-accounts`). Pairing proofs are files in a sticky
  directory, so the kernel stamps who dropped them.
- **Secret store.** The principal credential lives in the login keychain
  under the host's credential name, written through `security -i`. Souls'
  GitHub App keys live in Keychain items that only agent-bot-keyd's code
  signature can read.
- **Services.** The broker, the agent-bot daemon and keyd are LaunchAgents
  in the `gui/<uid>` domain. GeniusBar's bridge writes, refreshes and
  removes their plists, and restarts them with `launchctl kickstart` after
  an update.
- **Command-line tools.** Souls get `bin/agent-bot`, `bin/agent-comms` and
  `bin/node` as `sh` shims inside the bundle; the owner's terminal gets
  `sh` wrappers in `~/.local/bin` and a marked PATH block in the login
  shell's profile.
- **Packaging.** `package.yml` builds one universal macOS app, verifies the
  signed universal Node and keyd with `lipo` and `codesign`, and the Release
  workflow publishes a dmg and one updater archive.

The Rust shell is nearly portable already: its platform branches are
`cfg(target_os = "macos")` for the activation policy, the `Opened` and
`Reopen` events, and the companion windows' desktop placement. The component
fetcher already knows the `win-x64` and `win-arm64` Node archives.

Windows has no uid, no socket file modes, no sticky directories and no
login keychain, so a port that copied the macOS checks would be wrong
rather than merely incomplete. Two facts drive the choices below. Named
pipes are a single global namespace, so any local process can create a pipe
with the broker's name before the broker does, and Node cannot read a pipe
server's identity or set its access list. And a per-user profile directory
is private by default (`%LOCALAPPDATA%` inherits an access list that
names only the user, administrators and SYSTEM), which gives files the
custody that modes give on macOS.

## Decision

1. **One account only, and nothing in a shared directory.** Windows
   implements ADR-0059's one-account mode and nothing else. `persona-accounts`
   stays `platform-not-implemented` on `win32`: it would need per-persona
   Windows accounts, interactive `runas` and a shared directory with a
   hand-built access list, and nobody has asked for it. All broker, client
   and daemon state lives under `%LOCALAPPDATA%\<host>`, where the host is
   the configured service label, so custody is the profile's own access
   list. The account-isolation seam reports the current identity as the
   account's SID (from `whoami /user`) in place of a uid, and asserts that a
   state directory is a real directory whose owner is that SID (`Get-Acl`),
   which is the whole custody check: no ancestor walk, because the profile
   root is the boundary.
2. **Local channel: a per-account named pipe, and the broker proves itself.**
   The broker listens on `\\.\pipe\<serviceLabel>.<SID>`, which Node's
   `net` module serves and connects to as it does a socket path. The name
   does not establish custody, so the broker proves its identity on every
   connection instead: pairing records a broker Ed25519 public key beside the
   `brokerUid` field that pairing records today, and the first frame on a
   connection is the client's nonce, answered by the broker's signature over
   that nonce and the pipe name before any credential is sent. A broker
   whose signature does not verify is `broker-untrusted`, the same error the
   macOS ownership check raises. The client pins the key from the broker's
   state file, not from the wire: in one-account mode the pairing client runs
   as the same account and reads
   `%LOCALAPPDATA%\<host>\broker\identity.json`, so there is no trust on
   first use. The macOS implementation keeps the ownership checks and does
   not gain the handshake; the wire framing after the handshake is identical
   on both platforms, and the pairing-proof directory is not needed on
   Windows because pairing happens inside the one account.
3. **Secret store: a DPAPI-protected file.** The principal credential is
   written as `principal.<credentialName>.dpapi` in the client state
   directory, encrypted with `ProtectedData.Protect` in the `CurrentUser`
   scope through `powershell -NoProfile -NonInteractive`, with the JSON
   passed on stdin as hex for the same reason the macOS seam feeds
   `security -i` on stdin. Reading reverses it. Only that Windows account on
   that machine can decrypt it, which is the keychain's property that the
   principal needs. Credential Manager is not used: its generic credentials
   roam with a Microsoft account, and a principal must not leave the machine.
   agent-bot-keyd has no Windows build in this decision; a Windows soul's
   GitHub App key stays in the agent-bot-identity #395 file stores, protected
   the same DPAPI way, which is what Homebrew and Linux installs do today.
   The GeniusBar add-on that offers keyd is reported `unavailable` on
   Windows, as it already is when the bundle lacks keyd.
4. **Service startup: scheduled tasks at logon.** The broker and the
   agent-bot daemon are per-user scheduled tasks named after their service
   labels, registered from an XML definition through `schtasks /Create /XML`
   (not the `/SC ONLOGON` shorthand, which cannot express restart on
   failure): run at this user's logon, hidden, `RestartOnFailure` every
   minute with no limit, `ExecutionTimeLimit` unbounded, and
   `MultipleInstances` set to ignore a second start. Registering a task for
   the current user needs no administrator. `services.mjs` keeps its
   `refresh`, `remove`, `inspect` and `migrate` operations and its result
   shape; a Windows unit is the task's XML instead of a plist, and the
   kickstart after an update is `schtasks /End` then `/Run`. agent-bot's
   daemon supervisor gains the same `win32` branch, so `agent-bot daemon
   install` works on a Windows terminal install too. Logs go to
   `%LOCALAPPDATA%\<host>\Logs`, where the macOS log-rotation rule applies
   unchanged.
5. **Command-line tools: `.cmd` shims and the user PATH.** The bundle's
   soul-facing shims become `bin\agent-bot.cmd`, `bin\agent-comms.cmd` and
   `bin\node.cmd`, each one line that runs the bundled `node.exe` with the
   component's entry script and `%*`. The owner's tools are the same `.cmd`
   wrappers in `%LOCALAPPDATA%\GeniusBar\bin`, identified by the existing
   marker line as a `REM` comment. `install` adds that directory to the
   user's PATH value in `HKCU\Environment` through
   `[Environment]::SetEnvironmentVariable(..., 'User')`, never `setx`, which
   truncates at 1024 characters, and broadcasts the change so new consoles
   see it. There is no shell profile to edit. Conflicts, aside copies and
   uninstall work as they do on macOS, keyed on the marker.
6. **Souls are copied, not linked, and git is bundled.** Creating a symlink
   on Windows needs Developer Mode or a privilege the owner usually lacks, so
   `soul build` and the worktree setup write real copies where they link on
   macOS. Soul homes are git worktrees and Claude Code runs git, and Windows
   has no system git, so the Windows bundle carries MinGit, the Git for
   Windows project's command-line-only distribution, under
   `resources\git`, placed first on a soul's PATH. This is the Windows twin
   of #102; the macOS build keeps relying on the command line tools until
   #102 decides otherwise.
7. **Tray, windows and the shell.** The tray item, the anchored popup, the
   pop-out surfaces and the desktop companions use Tauri's cross-platform
   window API as they do now; the three `macos`-only branches gain Windows
   equivalents where one exists (a companion sits on the desktop through
   `set_always_on_bottom`; there is no activation policy to switch, and a
   relaunch raises the desktop window through the single-instance plugin
   instead of the `Reopen` event). Opening a `.soul` package registers the
   file association through the installer rather than the `Opened` event.
   The web view is WebView2, which Windows 10 and 11 ship; the installer is
   Tauri's NSIS bundle, per user, no administrator.
8. **Builds, signing and updates.** `package.yml` gains a Windows job on
   `windows-latest` for `x86_64-pc-windows-msvc`, fetching the pinned
   `win-x64` Node through the existing fetcher. ARM64 Windows follows once
   someone can test it; the fetcher and the updater manifest are ready for
   it. A signed build uses overlook's Azure Trusted Signing account through
   Tauri's `signCommand`, from secrets named `AZURE_TENANT_ID`,
   `AZURE_CLIENT_ID`, `AZURE_CLIENT_SECRET`, `AZURE_SIGNING_ENDPOINT`,
   `AZURE_SIGNING_ACCOUNT` and `AZURE_SIGNING_PROFILE`; a partial set fails
   the build, as the macOS set does. Both signed artifacts are published to
   the same GitHub release, and `latest.json` carries a `windows-x86_64`
   entry beside the `darwin-aarch64` and `darwin-x86_64` entries the universal
  archive already fills, so the Windows app updates from the same
   feed. An unsigned Windows build is published the way an unsigned macOS
   build is, as a prerelease labeled unsigned with the installer only, and
   SmartScreen will warn on it.

## Consequences

- Windows owners get the one-account product: the services, the tray, the
  popup, chat, launch and setup. They do not get `persona-accounts`, keyd's
  signature-bound key custody, or the shared directory, and the README says
  so.
- The broker handshake is a protocol addition that exists only for Windows
  custody, so the local-channel seam grows a second branch rather than a
  shared one; the trade is accepted because the alternative was a native
  helper beside every Node install.
- DPAPI binds the principal to the account and machine, so a Windows account
  that is migrated to new hardware re-pairs, which is a `broker-untrusted`
  error with a clear next step rather than a silent failure.
- A scheduled task restarts a crashed service only on the task scheduler's
  minute granularity, slower than launchd's `KeepAlive`; the bridge's
  reconnect loop already tolerates that.
- The download roughly doubles on Windows with MinGit (about 50 MB), and
  git updates arrive only through GeniusBar releases.
- Signed Windows releases wait on the owner adding the six Azure secrets to
  this repository; unsigned builds, the seams, the tasks and the `.cmd`
  tools can all be built and tested without them.

## Alternatives

- **A Windows service for the broker:** survives logout and restarts
  promptly, but installing one needs administrator rights, and ADR-0059
  decision 3 removed the administrator prompt on purpose.
- **A Startup-folder shortcut:** needs no scheduler, but nothing restarts
  the process when it dies.
- **Credential Manager for the principal:** the obvious store, but generic
  credentials roam with a Microsoft account and the principal must stay on
  the machine.
- **A native custody helper for the pipe:** a small signed binary could read
  the pipe server's identity and set its access list, keeping the macOS
  ownership model exactly. Rejected for now: every terminal install would
  need it too, and a signed handshake does the same job in the code that
  already exists.
- **TCP on the loopback interface:** reachable by every local account and
  every process, which is the threat the Unix socket's modes exist to close.
