---
id: harness-model-parent
title: Harness, model, provider and parent
keywords: [harness, model, provider, parent, independent, claude, codex, opencode, model picker, harness default, model id, team lead, subagent]
sources:
  - label: GeniusBar #128 — model picker per soul
    url: https://github.com/qwts/GeniusBar/issues/128
  - label: GeniusBar #284 — inherited versus explicit default model choices
    url: https://github.com/qwts/GeniusBar/issues/284
  - label: GeniusBar #261 — agents started by an agent stay parented
    url: https://github.com/qwts/GeniusBar/issues/261
---
observed: "GeniusBar doesn't run models itself — the harness does." The harness is the coding agent a soul runs in: `claude` (Claude Code), `codex`, or any command you name under **Other…**. Genius prefers `claude`, then `codex`. Each harness signs in on its own, in your browser, and keeps its own sign-in.

observed: The **Model** field in the launch dialog and the **Model choice** row in a companion's ⓘ sheet pick a model for that soul: **Harness default**, one of the models the harness listed after its first turn, or **Other…** with a model ID. "Applies on X's next turn." A refusal says "Model unchanged: …" and leaves it.

design: Showing whether a model was inherited from the harness or chosen explicitly, and a **Provider** choice separate from the harness, are in the Lovable design (#284) and not in the app.

observed: A soul started by another soul (`start_soul`, or a lead's task) has that soul as its **Parent**; the Delegation tab and the team cards follow it. The launch dialog has no parent field: a companion you launch yourself has no parent.

design: Choosing a parent at launch, including *Independent* (no parent) for a soul an agent started, is #261 and not shipped. Today the parent is fixed at launch.

## Technical details
- `agent-bot soul model <agentId> …` sets or clears the model (`--help` has the exact form); its list is what the harness reported.
- The harness command for *Other…* is kept per viewer as the default harness; a half-typed command is never applied.
