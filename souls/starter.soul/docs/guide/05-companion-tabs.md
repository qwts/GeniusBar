---
id: companion-tabs
title: Chat, Delegation, Audit log and Details
keywords: [tabs, chat, conversation, delegation, tree, audit log, details, memory, export json, copy json, tool call, aside, markdown, composer, info sheet]
sources:
  - label: GeniusBar #122 — the companion session (Lovable UI)
    url: https://github.com/qwts/GeniusBar/issues/122
  - label: GeniusBar #86 — agent-to-agent asides in the conversation
    url: https://github.com/qwts/GeniusBar/issues/86
  - label: GeniusBar #268 — the cumulative soul environment (Memory)
    url: https://github.com/qwts/GeniusBar/issues/268
---
observed: Opening a companion shows its session: a header with its face, name, role and presence, the ⓘ button, and four tabs: **Chat**, **Delegation**, **Audit log** and **Details**. Escape (or **Back to fleet** in the popup) leaves it.

observed: **Chat** is the conversation with that soul: your messages, its replies, its tool calls as cards (Running, Done, Failed), its approval requests with Approve and Deny, and asides between souls shown as "A → B · Background coordination, not addressed to you". Bodies render a safe Markdown subset (headings, lists, code, bold, italic); links are shown as text and never followed. The composer sends with ↩ and adds a line with ⇧↩; it is disabled while the companion is offline and not woken by messages, or while its harness sign-in has lapsed.

observed: **Delegation** draws the team tree: who started whom. Clicking a teammate opens that companion. **Audit log** lists this companion's records (Time, Companion, Event, Detail), newest first, with **Export JSON** (a file in Downloads) and **Copy JSON**; the footer's Audit log button shows the same for every companion as "All activity". The log refreshes while it is shown.

observed: **Details** is read-only: Agent id, Account, Harness, Presence, Parent, Unread, Last wake, Sandbox, Verification, Hardened, Daemon watching, Model, Context (tokens), Model choice, Agent comms (Managed or Unmanaged), Wake on new messages, Execution mode, Computer use, Harness sign-in and the GitHub identity it acts as, then **Launch…** to start it again with another harness or brief. The ⓘ sheet holds the switches for the same settings and **Customize…**.

design: A **Memory** tab and an **Environment & memory** section in Details, showing what the soul remembers and whether its history comes back on the next run, are in the Lovable design for #268 and are not in the app yet. Today the only view of a soul's memory is agent-bot's own `soul env` descriptor (see *Soul environment, memory and history*).

## Technical details
- Chat is agent-comms's inbox for this soul plus the daemon's tool, approval and aside events; it is kept while the window is open.
- The audit log is `agent-bot audit list --json`; an older bundle without it shows "The audit log arrives with the next agent-bot update."
- Details rows come from agent-comms's census and `agent-bot soul show`, `soul mode`, `soul computer-use`, `soul cold-wake` and `soul comms show`.
