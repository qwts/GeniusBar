---
id: troubleshooting
title: Troubleshooting, diagnostics and limitations
keywords: [error, problem, stuck, unreachable, background service, sign in, expired, signed out, launch failed, no reply, log, shell.log, doctor, health, limitations, unsupported, not shipped, windows]
sources:
  - label: GeniusBar #84 — a signed-out harness fails silently
    url: https://github.com/qwts/GeniusBar/issues/84
  - label: GeniusBar #118 — the setup checklist after boot
    url: https://github.com/qwts/GeniusBar/issues/118
  - label: GeniusBar issues — report a problem
    url: https://github.com/qwts/GeniusBar/issues/new/choose
---
observed: **"Can't reach the background service"** means agent-comms's broker is not answering. Right after login it may say "Background service is starting…" for a short while; the fleet appears when it connects. If it stays unreachable, **Refresh**, then check `agent-comms health` in a terminal; **Remove services…** followed by **Set up** reinstalls the services. "GeniusBar needs approval to connect" means your account owner has not approved the pairing.

observed: **No reply from a companion** is usually its harness: the session shows "sign-in expired" or "signed out" with **Sign in again**. Otherwise look for a request **Waiting for your approval** in the menu, then at the **Audit log** for its last tool calls, then at `agent-bot doctor`. A companion that is **Offline** without *Wake on new messages* needs a launch (Details → **Launch…**).

observed: **"Launch failed: …"** repeats the daemon's reason (a harness not installed, a package that does not validate, an account that is not paired). A package problem is checked with `agent-bot soul pack validate <path>`; a copied folder needs a name of its own.

observed: Where to look: agent-bot's audit log (in the app, or `agent-bot audit tail`), `agent-bot doctor`, `agent-comms health`, and GeniusBar's own `shell.log` in the app's log folder, which records launches, service refreshes, guide refreshes and web view errors. "Report a problem" in About GeniusBar opens the issue form; paste the version info from About.

observed: **Not shipped today** (the guide marks each as *design* where it comes up): a Memory tab and the Environment & memory section (#268); a parent or provider choice at launch (#261, #284); Approve for session; the team scope and archived-souls browser for archiving (#283); provisioning the sandbox account from the app (#66). A control the app does not show is not available through Genius either: a soul cannot do what agent-bot refuses it.

## Technical details
- An older bundled agent-bot hides what it lacks: no `soul stop` means no Stop button, no `sandbox` means no Sandboxing card, no `audit` means "The audit log arrives with the next agent-bot update."
- The Windows build ships its own git and has no Apple tools step or Touch ID; otherwise the controls are the same.
