# Architecture decisions (ADR series)

Durable records for decisions about the GeniusBar app. Decisions about the
components it bundles live in their own repositories:
[agent-comms](https://github.com/qwts/agent-comms/tree/main/docs/decisions)
and
[agent-bot-identity](https://github.com/qwts/agent-bot-identity/tree/main/docs/decisions).

`ADR-NNNN` takes the originating issue number in this repository, so numbers
are sparse. Each record starts with `**Status:**`, `**Date:**`, and
`**Issue:**`. Status is `Proposed`, `Accepted`, or `Superseded by ADR-NNNN`.
Records are never rewritten after acceptance; supersede them instead.

| ID | Title | Status |
| --- | --- | --- |
| [ADR-0004](ADR-0004-tauri-menubar-app-with-a-node-sidecar.md) | GeniusBar is a Tauri menubar app with a bundled Node sidecar | Proposed |
| [ADR-0046](ADR-0046-windows-pipe-transport-dpapi-store-and-logon-tasks.md) | Windows runs the same services over a named pipe, a DPAPI store, and logon tasks | Proposed |
