---
id: sandbox-and-accounts
title: Sandboxing and accounts
keywords: [sandbox, sandboxing, account, standard account, macos account, admin, pairing, approve pairing, runs as, steps for you, sop, persona, hardened, unrestricted]
sources:
  - label: GeniusBar #66 — sandboxing in a separate standard macOS account
    url: https://github.com/qwts/GeniusBar/issues/66
---
observed: The menu's **Sandboxing** card runs companions in a separate standard macOS account with no admin rights. Its switch sets the default for every companion; the sandbox type is *Standard macOS Account* ("More options coming soon"). While on, the card shows the account's state: does not exist yet, exists but needs finishing, or ready.

observed: GeniusBar never creates the account. **Steps for you** lists what to run yourself, each with who runs it (in your account as an administrator, in your account, or logged in as the sandbox account), a Copy button for the command and a note; some ask for your password. The pairing step lists the sandbox account's and its daemon's pairings waiting on you, each with **Approve**.

observed: One companion can differ from the switch: its ⓘ sheet's **Sandbox** chip offers *Use GeniusBar setting*, *Always sandboxed* and *Never sandboxed*. When your SOP pack decides (its `persona.toml` mapping), the chip says so and offers only *inherit*; change the pack to change it. Details shows **Runs as** the sandbox account or you, and **Hardened** when the account is.

observed: Every state on the card is agent-bot's, read when the card shows and after every change; a bundled agent-bot without the `sandbox` command hides the card.

design: Issue #66 is still open: provisioning the account from the app and further sandbox types are planned, not shipped.

## Technical details
- `agent-bot sandbox status --json` reports the switch, the account, the owner's plan and the SOP mapping; `agent-comms broker pairings` lists the pairings the Approve button acts on.
- Souls are keyed by account and Agent ID, so the same ID in two accounts never collides.
