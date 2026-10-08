---
id: windows-and-popouts
title: Windows and pop-outs
keywords: [window, pop-out, popout, own window, embedded, inside the popup, close when clicking outside, click out, resize, remember, opens in, native window, scroll, menus]
sources:
  - label: GeniusBar #295 — views inside the popup, pop-outs by choice
    url: https://github.com/qwts/GeniusBar/pull/295
  - label: GeniusBar #298 — pop-out windows never scroll the page
    url: https://github.com/qwts/GeniusBar/pull/298
  - label: GeniusBar #264 — opening conversations inside GeniusBar
    url: https://github.com/qwts/GeniusBar/issues/264
  - label: GeniusBar #265 — closing GeniusBar on a click outside
    url: https://github.com/qwts/GeniusBar/issues/265
---
observed: A companion's session, the audit log, Customize and Launch open **inside the GeniusBar popup** by default. Each of those views has a pop-out arrow in its header that moves it to a native window of its own; the popup goes back to the fleet behind it. Pop-out windows are resizable and come back at the size and place you left them.

observed: The ⋯ menu's **Open conversations in their own window** switch makes every one of those views open in its own window from the start. One companion can differ from the app setting: its ⓘ sheet has **Opens in** with *Follow app setting*, *In GeniusBar* and *Own window*.

observed: **Close GeniusBar when clicking outside it** is off by default, so the popup stays open until you click the menu bar item again (a drag from Finder can reach it). On, the popup hides when it loses focus, as a menu does.

observed: A pop-out window never scrolls the whole page: only its own content scrolls, and menus and hover cards stay inside the window.

observed: A view whose own window cannot be opened (an older shell, or a window the system refuses) opens inside the popup instead, so nothing is lost.

## Technical details
- Window sizes and positions live in `windows.json` in the app's config folder; the switches live in the web view's own storage (`gb.preferences`). Neither is part of any soul.
- The app can also run its popup as a plain window with the `--window` launch flag, used for desktop automation and tests.
