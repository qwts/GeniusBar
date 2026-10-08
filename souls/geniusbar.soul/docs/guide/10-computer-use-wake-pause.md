---
id: computer-use-wake-pause
title: Computer use, wake, pause, stop, comms and sign-in
keywords: [computer use, screen, stop, halt, escape, wake, wake on new messages, cold wake, asleep, pause, pause all, resume, comms, agent comms, managed, unmanaged, sign in, signed out, expired, harness sign-in]
sources:
  - label: GeniusBar #90 — Wake on new messages
    url: https://github.com/qwts/GeniusBar/issues/90
  - label: GeniusBar #71 — managed and unmanaged souls, agent comms
    url: https://github.com/qwts/GeniusBar/issues/71
  - label: GeniusBar #84 — a signed-out harness
    url: https://github.com/qwts/GeniusBar/issues/84
  - label: agent-bot-identity #474 — halting a soul's turn
    url: https://github.com/qwts/agent-bot-identity/issues/474
---
observed: **Computer use** is a per-companion switch in the ⓘ sheet and Details: off, "its requests to control the screen are denied". While a companion is driving the screen the fleet badge says "Controlling your screen", the edges of the desktop glow, and the session header offers **Stop**: "X is controlling the screen. Hold Esc or press Stop to halt." Stop halts that soul's turn; turning the switch off while it drives also stops its screen session.

observed: **Wake on new messages** (Details, "Start X when a message arrives, even if it's asleep") lets agent-bot's daemon start a companion that has gone offline when a message reaches its inbox. The fleet shows such a companion as "Asleep — wakes on a new message", and its composer stays open. Without it, a message to an offline companion waits until you launch it again.

observed: **Pause all** (the floating Dudle's quick menu, or the desktop's **Companions paused** chip once paused) freezes every companion's work until **Resume**. Paused companions show "Paused".

observed: **Agent comms** on a companion means it has joined agent-comms's broker: it can message and be messaged by other companions and wakes on new messages when allowed. The switch is locked while the soul runs ("Stop it first to change this."). **Managed** means GeniusBar's daemon started it; **Unmanaged** means an agent started elsewhere was told to join (see *Command-line tools*).

observed: Each harness keeps its own sign-in. When it lapses, the session shows "claude sign-in expired" or "claude is signed out" (the harness's name) with **Sign in again**, which opens the harness's browser sign-in; new messages wait meanwhile. Details' **Harness sign-in** row says Signed in, Expired or Signed out.

## Technical details
- `agent-bot soul computer-use <agentId> on|off|show`; `agent-bot soul stop <agentId>` (an older bundle without `soul stop` offers no Stop button).
- `agent-bot soul cold-wake <agentId> on|off|show`; `agent-bot soul pause|resume`; `agent-bot soul comms <agentId> on|off|show`.
- `agent-bot harness auth status|login <harness> <agentId>`; the census carries the sign-in state the notice reads.
