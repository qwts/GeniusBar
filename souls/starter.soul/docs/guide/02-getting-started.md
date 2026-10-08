---
id: getting-started
title: Getting started
keywords: [setup, first start, onboarding, install, set up, checklist, command line tools, xcode, git, homebrew, first companion, meet genius, sign in]
sources:
  - label: GeniusBar #9 — first-run setup and login services
    url: https://github.com/qwts/GeniusBar/issues/9
  - label: GeniusBar #101 — explaining the Command Line Tools prompt
    url: https://github.com/qwts/GeniusBar/issues/101
  - label: GeniusBar #102 — bundled git
    url: https://github.com/qwts/GeniusBar/issues/102
  - label: GeniusBar #287 — Genius, the default companion, and this guide
    url: https://github.com/qwts/GeniusBar/issues/287
---
observed: On first start the menu bar item opens a popover that says "Checking connection…", then "GeniusBar needs setup on this Mac. Choose Set up below." The setup panel lists four steps: *Start GeniusBar's background service*, *Connect this account*, *Connect GeniusBar* and *Start your agents*. **Set up** runs them in order; a step that fails shows its error and the button turns into **Try again**. Each done step gets a tick.

observed: Setup installs two login services for this Mac: agent-comms's broker and agent-bot's daemon. If a copy from Homebrew is already installed, the panel says so and offers **Keep them** or **Move to GeniusBar**, which takes the services over while keeping your agents, messages and pairings.

observed: A soul's home is a git worktree, so git must work. GeniusBar ships its own git; on a Mac where that build is missing, the first-companion card explains that Apple's free command-line tools are needed, **Continue** opens Apple's installer, and the card waits for it. If the installer is cancelled, the card shows the command to run yourself: `xcode-select --install`.

observed: With setup done and no companions yet, the popover shows **Your first companion**: "Meet Genius, your guide", a Harness field with the template's preferred harness filled in (`claude`, then `codex`), an **Agent comms** switch that is on, and **Start with Genius**. After the launch the card checks the harness sign-in and offers **Sign in to Claude** (the harness's own browser sign-in) when needed; "Ready. Open the companion in the fleet to chat." means it is done.

observed: **About GeniusBar** and **Open App guide** are reachable from the setup panel and from the first-companion card, so you can report a version or read this guide before anything else works.

observed: Recovery: a failed first launch shows the daemon's reason on the card and you can start again from it; a half-installed set of services is reset with **Remove services…** in the ⋯ menu followed by **Set up** again (see *Updates, services and About*).

## Technical details
- The starter launch is `agent-bot`'s spawn of the bundled package `souls/starter.soul` under your macOS account, with the harness you chose and comms on unless you switched it off.
- Harness sign-in is `agent-bot harness auth status|login <harness> <agentId>`.
- A stock Mac needs no Homebrew: the bundled components run from inside the app bundle.
