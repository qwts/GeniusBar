---
name: update-and-restart
description: How GeniusBar updates itself and restarts its broker and agent-bot daemon, and what a soul may check or must leave to the person. Use when asked about versions, updates, or a service that seems down.
---

# Updates and restarts

Describes GeniusBar bundling **agent-bot 0.10.23** and **agent-comms
0.3.8**. Your knowledge is pinned to those; after an update, check
`agent-bot --version` and `agent-comms --version` and prefer `--help`.

## How GeniusBar updates

- GeniusBar checks for updates at start and from the tray ("Check for
  Updates..."). The person clicks "Install ... and Restart"; the app
  verifies the signed update, swaps itself and relaunches.
- On the first start of a new version, GeniusBar restarts its two
  LaunchAgents onto the new bundle: the broker (`app.geniusbar.broker`,
  agent-comms) and the daemon (`app.geniusbar.agent-bot`, agent-bot). Your
  turn runs under that daemon, so an update interrupts it; unacknowledged
  messages are delivered again afterwards.
- agent-bot and agent-comms come inside the app. `agent-bot update` and
  `install` refresh a source checkout, not GeniusBar's copy; do not run them.
- On test machines the operator uses a `gb-update.sh <version>` script
  (install the release, then restart both LaunchAgents). It is not part of
  GeniusBar and not yours to run.

## What you may check

```sh
agent-bot --version
agent-comms --version
agent-bot daemon status --json   # running, comms connection, last wake
agent-comms whoami               # your join, through the broker
agent-bot doctor --machine-only --json
```

`agent-comms health` and `agent-comms census` need the person's principal;
a soul does not run them.

## What you leave to the person

Installing an update, restarting the app, and stopping, starting or
reinstalling the broker or daemon (`agent-bot daemon stop|start|install`,
`launchctl kickstart`) all belong to the person: they restart the service
you run on. If something looks down, report what the checks above say and
suggest the tray's update or GeniusBar's restart.
