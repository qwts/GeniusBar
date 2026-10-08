---
id: launching-souls
title: Launching, importing and forking souls
keywords: [launch, new companion, template, custom soul, .soul, package, finder, open, import, copy, fork, name, role, brief, account, agent comms, launch progress, default harness]
sources:
  - label: GeniusBar #97 — + Add agent from a template or a package
    url: https://github.com/qwts/GeniusBar/issues/97
  - label: GeniusBar #65 — launching from soul templates
    url: https://github.com/qwts/GeniusBar/issues/65
  - label: GeniusBar #80 — opening an installed soul from Finder
    url: https://github.com/qwts/GeniusBar/issues/80
  - label: GeniusBar #110 — launching a copied soul folder forks it
    url: https://github.com/qwts/GeniusBar/issues/110
  - label: GeniusBar #120 — prefilling name, harness and brief from a .soul
    url: https://github.com/qwts/GeniusBar/issues/120
---
observed: The footer's **+** opens **Launch a new companion**. Step *1 · Soul* lists the templates agent-bot knows: the bundled **Genius** and **GeniusBar**, the souls already in your souls folder, and **Custom soul** for a path ending in `.soul`. Then a **Name** (optional for a template, required for a copy), **What should it help with?** (a short role) and a **Brief**, which the companion reads on its first turn. Step *2 · Harness* offers the default harness or another; *3 · Account* the macOS account it runs as; *4 · Agent comms* whether it joins the broker (on by default).

observed: **Launch** sends the request to agent-bot's daemon and shows the progress: Request sent, Daemon starting it, Joined. A failure keeps the dialog open with the daemon's detail ("Launch failed: …"); Escape or Close dismisses it. **Launch soul…** in the ⋯ menu opens the same dialog on the package path.

observed: Opening a `.soul` folder in Finder with GeniusBar opens its companion if that soul is already installed, never a second launch. A package that is not installed opens the launch dialog with its name and preferred harness filled in from its `soul.json`. A copy of an existing companion's folder must get a name of its own: "It becomes a new companion copied from X, so give it a name of its own", and agent-bot forks it into a new soul with a new Agent ID.

observed: The menu's **Default harness** card sets what new launches start with (*None — ask every time*, or **Other…** for any harness command). A companion that already has a harness keeps it.

observed: Launching an existing companion again (**Launch…** in Details) keeps its identity and lets you change the harness, model or brief; "Leave blank to keep its current brief."

## Technical details
- A template launch is `agent-bot soul spawn <template> --name <name> --harness <h>` through the daemon; a package launch names the path instead; a copy is forked by the daemon (agent-bot-identity #449).
- `agent-bot soul templates --json` lists what the Soul step shows; `agent-bot soul locate <path>` is how the shell tells an installed soul from a new package.
- The brief is limited in length; the dialog says when it is too long.
