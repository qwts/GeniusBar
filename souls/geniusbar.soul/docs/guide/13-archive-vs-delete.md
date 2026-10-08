---
id: archive-vs-delete
title: Archive versus deletion
keywords: [archive, remove, delete, retire, retired, restore, bring back, .archive, souls folder, team, lead, agent id]
sources:
  - label: GeniusBar #94 — Remove… a soul (agent-bot soul remove)
    url: https://github.com/qwts/GeniusBar/issues/94
  - label: GeniusBar #283 — team scope for the archive flow
    url: https://github.com/qwts/GeniusBar/issues/283
---
observed: **Remove…** (right-click on the desktop) or the fleet row's **Archive** button opens a dialog that names the companion and its Agent ID and says what happens: "agent-bot asks for your approval, then the companion: stops waking on new messages, leaves agent comms, is retired (its Agent ID can't come back), has its folder moved to `.archive` in your souls folder. Nothing is deleted." It is locked while the companion runs ("Stop the companion to archive it.").

observed: **Archive** asks agent-bot, which asks you (Touch ID or your login password). A refusal shows as-is and the soul stays. After it, a short toast says "X archived"; if it has not left agent comms yet, the toast says why.

observed: Archiving is **not** deletion: the folder, its memory, history and workspaces are all still there under `.archive`. What ends is the identity: a retired Agent ID is never reused, so bringing the same soul back as the same agent is not offered. The folder can be launched again as a new companion (it is then forked with a new Agent ID).

design: #283 designs the team case: for a lead, choosing only the lead (its members become independent) or the whole team, with every affected name listed, and an *Archived souls* browser to read old history. Today the dialog archives the one soul you chose, lead or not. Permanent deletion is not offered by GeniusBar; it would be a separate action from archiving.

## Technical details
- `agent-bot soul remove <agentId> --json` is the whole operation; its refusals ("… is running; stop it before removing it") are shown unchanged.
- The archived folder keeps its `.soul-state`; the population census marks the record retired.
