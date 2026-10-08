---
id: command-line-tools
title: Command-line tools and headless use
keywords: [cli, terminal, command line, path, agent-bot, agent-comms, headless, join, unmanaged, install, uninstall, replace, zprofile, local bin, scripts, --help, doctor]
sources:
  - label: GeniusBar #41 — command-line tools from the app
    url: https://github.com/qwts/GeniusBar/issues/41
  - label: GeniusBar #71 — unmanaged agents that join
    url: https://github.com/qwts/GeniusBar/issues/71
---
observed: **Command-line tools…** in the ⋯ menu puts the bundled `agent-bot` and `agent-comms` on your PATH, like VS Code's `code` command, so an agent you start yourself can join the fleet without Homebrew. The wrappers go in `~/.local/bin`; on a Mac whose PATH lacks it, GeniusBar adds that directory to your login shell's profile (`~/.zprofile` for zsh) and says to open a new terminal. A copy already there is shown and only replaced after you choose **Replace and install**; **Uninstall** puts it back.

observed: With them installed, the same engine GeniusBar uses is yours in a terminal. Start with `agent-bot --help` and `agent-comms --help`: they list what the installed version supports, and this guide defers to them. `agent-bot doctor` checks identities and the daemon; `agent-comms health` and `agent-comms whoami` check the broker and your pairing.

observed: An agent started outside GeniusBar (a harness you ran yourself with `agent-bot join`) appears in the fleet as **Unmanaged** once it joins the broker; GeniusBar shows it and chats with it but did not start it and cannot restart it. **Managed** companions are the daemon's.

observed: Useful reads that change nothing: `agent-bot soul show <agentId|name>`, `agent-bot soul env <agentId> --json`, `agent-bot soul profile <agentId> --json`, `agent-bot soul templates --json`, `agent-bot population list --json`, `agent-bot audit list`, `agent-comms peers`, `agent-comms inbox read`, `agent-comms task list`. Writes such as `agent-bot soul spawn`, `agent-comms send` and `agent-comms launch` do what the app's controls do, and the owner-gated ones ask you the same way.

## Technical details
- Headless launch: `agent-comms launch --account <a> --soul <name>|--package <path> --harness <h> --name <n> [--comms on|off] [--model M] [--brief …]`.
- `agent-bot skill path` and `agent-comms skill` print the skills a soul reads for the exact bundled version.
- The wrappers run the copy inside the app bundle, so they move with it; GeniusBar refreshes them at startup.
