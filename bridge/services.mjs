#!/usr/bin/env node
// GeniusBar's login services (#9, ADR-0004 decision 4): the broker and the
// identity daemon that setup registered under GeniusBar's own labels.
//
//   refresh  At app start: re-register a service whose unit still runs an
//            older or moved copy of the app, so updates and moves take
//            effect at the next launch. Untouched when already current.
//   remove   The owner's explicit action: unload and delete both units.
//
// Only units under GeniusBar's labels are touched. A broker or daemon from
// another install (Homebrew, say) has its own label and is never changed.
// Result: one JSON line, {ok: true, broker, daemon} with each one of
// 'absent' | 'current' | 'reinstalled' | 'removed' | 'unsupported', or
// {ok: false, code, message}.
//
// usage: node services.mjs refresh|remove AGENT_COMMS_DIR AGENT_BOT_DIR

import { execFile } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseOutput, SetupError } from './setup.mjs';

const xmlEscape = (value) => String(value).replaceAll('&', '&amp;').replaceAll('<', '&lt;')
  .replaceAll('>', '&gt;').replaceAll('"', '&quot;');

/** Whether a launchd plist runs exactly this Node and entry script. */
export function runsCopy(plist, node, entry) {
  const strings = [...plist.matchAll(/<string>([^<]*)<\/string>/g)].map((m) => m[1]);
  const at = strings.indexOf(xmlEscape(node));
  return at >= 0 && strings[at + 1] === xmlEscape(entry);
}

function failed(result, fallback) {
  const error = result?.error;
  return new SetupError(error?.code ?? fallback, error?.message ?? fallback);
}

/**
 * `units` maps 'broker' and 'daemon' to their plist paths; `read` returns a
 * plist's text or null when absent. `node` and `commsEntry` are
 * the broker command line this copy of the app runs.
 */
export async function refreshServices({ units, read, node, commsEntry, cli, bot }) {
  const result = {};
  const broker = read(units.broker);
  if (broker === null) result.broker = 'absent';
  else if (runsCopy(broker, node, commsEntry)) result.broker = 'current';
  else {
    // `broker install` always restarts the broker, so only on a real change.
    const installed = await cli(['broker', 'install']);
    if (!installed?.installed) throw failed(installed, 'broker-install-failed');
    result.broker = 'reinstalled';
  }
  if (read(units.daemon) === null) result.daemon = 'absent';
  else {
    // Idempotent: rewrites and reloads only when the unit would change.
    const installed = await bot(['daemon', 'install', '--json']);
    if (!installed?.label) throw failed(installed, 'daemon-install-failed');
    result.daemon = installed.changed ? 'reinstalled' : 'current';
  }
  return result;
}

export async function removeServices({ units, read, cli, bot }) {
  const result = {};
  if (read(units.daemon) === null) result.daemon = 'absent';
  else {
    const disabled = await bot(['daemon', 'disable', '--json']);
    if (!disabled?.unloaded) throw failed(disabled, 'daemon-remove-failed');
    result.daemon = 'removed';
  }
  if (read(units.broker) === null) result.broker = 'absent';
  else {
    const removed = await cli(['broker', 'uninstall']);
    if (removed?.installed !== false) throw failed(removed, 'broker-remove-failed');
    result.broker = 'removed';
  }
  return result;
}

async function main() {
  const [action, commsDir, botDir] = process.argv.slice(2);
  const write = (message) => process.stdout.write(`${JSON.stringify(message)}\n`);
  if (!['refresh', 'remove'].includes(action) || !commsDir || !botDir) {
    process.stderr.write('usage: services.mjs refresh|remove AGENT_COMMS_DIR AGENT_BOT_DIR\n');
    process.exit(2);
  }
  if (process.platform !== 'darwin') {
    write({ ok: true, broker: 'unsupported', daemon: 'unsupported' });
    return;
  }
  const commsEntry = path.join(commsDir, 'bin', 'agent-comms.mjs');
  const botEntry = path.join(botDir, 'agent-bot.mjs');
  const runner = (bin) => (args) => new Promise((resolve) => {
    execFile(process.execPath, [bin, ...args], { timeout: 30_000 }, (_error, stdout) => resolve(parseOutput(String(stdout))));
  });
  const agents = path.join(os.homedir(), 'Library', 'LaunchAgents');
  const units = {
    broker: path.join(agents, `${process.env.AGENT_COMMS_SERVICE_LABEL}.plist`),
    daemon: path.join(agents, `${process.env.AGENT_BOT_SERVICE_LABEL}.plist`),
  };
  const read = (file) => (existsSync(file) ? readFileSync(file, 'utf8') : null);
  const ports = { units, read, cli: runner(commsEntry), bot: runner(botEntry) };
  try {
    const result = action === 'refresh'
      ? await refreshServices({ ...ports, node: process.execPath, commsEntry })
      : await removeServices(ports);
    write({ ok: true, ...result });
  } catch (error) {
    write({ ok: false, code: error.code ?? 'services-failed', message: String(error.message ?? error) });
    process.exitCode = 1;
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  if (!process.env.AGENT_COMMS_SERVICE_LABEL || !process.env.AGENT_BOT_SERVICE_LABEL) {
    process.stderr.write('services.mjs needs AGENT_COMMS_SERVICE_LABEL and AGENT_BOT_SERVICE_LABEL\n');
    process.exit(2);
  }
  await main();
}
