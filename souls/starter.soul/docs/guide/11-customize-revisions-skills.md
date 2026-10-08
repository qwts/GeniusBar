---
id: customize-revisions-skills
title: Customization, revisions and skills
keywords: [customize, profile, role, color, colour, description, context, agents.md, files, skills, credentials, sop, revision, save, why, reason, touch id, reload, stale]
sources:
  - label: GeniusBar #64 — customizing a companion
    url: https://github.com/qwts/GeniusBar/issues/64
  - label: GeniusBar #268 — revisions through the soul environment
    url: https://github.com/qwts/GeniusBar/issues/268
  - label: agent-bot-identity #535 — a soul's role
    url: https://github.com/qwts/agent-bot-identity/issues/535
---
observed: **Customize…** (right-click a companion on the desktop, or the ⓘ sheet) opens the companion's package. The **Profile** tab edits its **Role** (one line, at most 60 characters), its **Color** (a swatch, or "Use the default color" derived from the Agent ID) and its **Description**. The **Context** tab shows the files its harness loads (its `AGENTS.md` and the rest of the package, with their size), and the sections **SOP** (which SOP it follows: resolved, or an override), **Skills** (each skill with a switch; "A skill switched off stays in the package but is not loaded") and **Credentials** (named by reference only; no secret is ever shown). The Handle, Package, Revision, Template and Status rows are read-only.

observed: **Save** asks **Why** (one line kept in the revision history; "Edited in GeniusBar" by default). agent-bot then asks for your approval (Touch ID or your login password) and records the change as a new package **revision**: "Saved as revision …". A revision can be reviewed and reverted with agent-bot; nothing is edited in place. If the companion changed while the dialog was open, it says so and offers **Reload**; your edits there are dropped.

observed: Genius and the GeniusBar lead ship skills and docs inside their packages. A revision never touches the soul's memory, history or workspaces: those live in the package's `.soul-state`, which the package hash ignores.

design: Installing a new skill into a soul from the Customize dialog, and editing a context file in place, are not offered; a skill is added by a revision of the package (agent-bot's `soul revision`), which the GeniusBar lead can prepare for you.

## Technical details
- The dialog reads `agent-bot soul profile <agentId> --json`; a save is `soul revision prepare`, the edit, then `soul revision edit --apply` when the engine reports `revision-prepare`, else the bridge stages the edit itself.
- `appearance.hue` (0..359), `role` and `skills.disabled` are the `soul.json` keys the dialog writes.
