---
id: genius-and-the-lead
title: Genius, Starter and the GeniusBar lead
keywords: [genius, starter, rename, geniusbar lead, geniusbar.soul, starter.soul, template, agent id, previous names, display name, guide, who is who]
sources:
  - label: GeniusBar #287 — Genius and the bundled guide
    url: https://github.com/qwts/GeniusBar/issues/287
  - label: GeniusBar #73 — the GeniusBar lead
    url: https://github.com/qwts/GeniusBar/issues/73
---
observed: **Genius** is the default first companion, made from the bundled template `souls/starter.soul`. It used to be called **Starter**; the template's folder, its display seed and its Agent ID handle `starter` did not change, and its manifest lists the old name under `previousNames`. Genius is a friendly general companion that also carries this guide and answers questions about GeniusBar from it.

observed: The **GeniusBar lead** is a separate bundled template, `souls/geniusbar.soul`: an operational lead with skills for the engine, agent comms, the fleet, credentials, identities, configuration and updates, meant to set a fleet up and lead other souls. Both templates carry the same guide; the lead's package also carries its skills as maintained files. They are two souls with two identities and are never merged.

observed: A companion you launched from the old Starter template keeps its Agent ID, folder, memories, history, settings and parent. A name you chose yourself is never changed. A display name that was the template's own ("Starter") is renamed to Genius only by agent-bot's name migration, which records where a name came from; GeniusBar asks for it after an update when the bundled engine reports the `template-name` capability, and otherwise leaves the name as it is and says so in its log.

design: The engine side of that migration (`templateName` and `nameSource` on instances, `soul env migrate --template-name`, `soul template refresh`) is being added to agent-bot for #287 and is not in every bundled version yet; GeniusBar only ever calls it behind the capability check.

## Technical details
- `agent-bot soul templates --json` lists both templates with their package paths; the launch dialog's Soul step offers both.
- `agent-bot soul env migrate <agentId> --template-name --plan --json` reports whether a rename is pending, skipped ("the name was chosen by the owner") or done, without changing anything.
