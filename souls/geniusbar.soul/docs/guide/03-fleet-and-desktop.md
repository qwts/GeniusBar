---
id: fleet-and-desktop
title: Fleet, menu and desktop
keywords: [menu bar, popup, popover, fleet, team, desktop, hide, show all, search, jump, palette, cmd k, badge, waiting, working, presence, unread, sound, language, open desktop]
sources:
  - label: GeniusBar #69 — the companion desktop
    url: https://github.com/qwts/GeniusBar/issues/69
  - label: GeniusBar #85 — approvals in the menu and its badge
    url: https://github.com/qwts/GeniusBar/issues/85
  - label: GeniusBar #223 — companions on the macOS desktop
    url: https://github.com/qwts/GeniusBar/issues/223
---
observed: The menu bar item opens the GeniusBar popup. Its header names the app and counts what matters now: companions **waiting on you** (an approval) and **working**. Under it come any update line, the **Waiting for your approval** list with Approve and Deny on each request, then the fleet, grouped by team; souls without a lead sit under **No team**. Each row shows the companion's face (a Dudle), its name, its role or harness, its presence (Ready, Starting, Offline, Waiting for you, Working…) and unread messages. Clicking a row opens the companion.

observed: The footer holds the fleet-wide Auto-Pilot switch, sound cues, the language selector (English or Spanish), the **Audit log** button (every companion's activity), **+** to launch a companion, and the ⋯ **More** menu: Open desktop, the window switches (see *Windows and pop-outs*), Check for Updates…, About GeniusBar…, App guide, Launch soul…, Command-line tools…, Refresh, Remove services…. The menu's Refresh re-reads the census and the badges at once.

observed: **Open desktop** opens the companion desktop in its own window: teams are cards you drag by their title and collapse; a lead with nobody under it is a slim card. Right-click a companion for **Open**, **Customize…**, **Hide from desktop** (a lead's whole team goes with it; **Hide only this companion** keeps the team), and **Remove…**. **Show all hidden (n)** brings them back. ⌘K opens the jump palette; the View menu holds "Show the desktop" and "Reset desktop layout".

observed: While companions are paused, a **Companions paused** chip leads the desktop's menu bar; clicking it resumes them. While every companion is on Auto-Pilot the G turns amber and a bar says "Auto-Pilot is on — companions run tools without asking", with **Turn off**.

observed: **Companions on the desktop** in the ⋯ menu places each team as a native window on the macOS desktop instead of inside one desktop window. The layout, hidden companions and card sizes are kept per Mac in the app's own storage, not in any soul.

## Technical details
- The fleet is agent-comms's census (`agent-comms census`), joined with `agent-bot population list --json` for colours, roles, pause and computer-use state; the daemon's status supplies "working" and "waiting on you".
- The badges refresh about once a minute and on Refresh; a hidden window skips its reads.
