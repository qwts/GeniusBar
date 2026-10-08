---
id: permissions-and-modes
title: Permissions, approvals, Safe Mode and Auto-Pilot
keywords: [permission, approval, approve, deny, approve for session, safe mode, auto-pilot, autopilot, execution mode, touch id, confirm, owner, proposal, risk, tool call]
sources:
  - label: GeniusBar #85 — approving the daemon's open proposals
    url: https://github.com/qwts/GeniusBar/issues/85
  - label: agent-bot-identity #397 — keyd approvals
    url: https://github.com/qwts/agent-bot-identity/issues/397
---
observed: In **Safe Mode**, the default, a soul's risky and external tool calls wait for you. The request shows in its chat as "X wants to run Y" with a risk line (Reaches outside your computer, Can change or delete files, or Read-only) and in the menu's **Waiting for your approval** list; its face bounces while it waits. **Approve** or **Deny** decides; agent-bot may ask you to confirm on this Mac ("Confirm on this Mac to finish…"). The decision is recorded in the audit log.

observed: **Approve for session** is shown but disabled: agent-bot has no session scope for the daemon's approvals yet, so each request is approved on its own.

observed: **Auto-Pilot** is the other execution mode: the soul runs tools without asking. It is set per companion in its ⓘ sheet or Details ("Auto-Pilot for X"), or for every companion at once with the footer switch; agent-bot may ask you to confirm each one. While it is on, an amber banner says "Auto-Pilot is on — X runs tools without asking" with **Turn off**. The mode applies on the soul's next permission request, not mid-turn.

observed: Modes and approvals are **owner-gated**: agent-bot refuses them from a soul, including from Genius or the GeniusBar lead. A soul can explain how to approve something or ask you to; it cannot approve it. Reading this guide grants nobody any permission.

design: Approval scopes beyond one request (a session, a tool for good) and policy editing from the app are planned around agent-bot's approvals and not shipped.

## Technical details
- `agent-bot approvals list`, `approvals approve <id> --scope once`, `approvals deny <id>`; `agent-bot soul mode <agentId> safe|autopilot`.
- A refusal ("Execution mode unchanged: …") is agent-bot's; the app shows it as-is and leaves the switch where it was.
