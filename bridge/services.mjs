#!/usr/bin/env node
// GeniusBar's login services (#9, ADR-0004 decision 4): the broker and the
// identity daemon that setup registered under GeniusBar's own labels.
//
//   refresh  At app start: re-register a service whose unit still runs an
//            older or moved copy of the app, so updates and moves take
//            effect at the next launch. An update swaps the bundle in place
//            and the units' paths stay identical, so the version each
//            refresh reconciled under is stamped in GENIUSBAR_SERVICES_STAMP;
//            a different running version restarts current units with
//            `launchctl kickstart -k`, putting them on the new files (#34).
//            Untouched when already current.
//   remove   The owner's explicit action: unload and delete both units.
//
// Only units under GeniusBar's labels are touched. A broker or daemon from
// another install (Homebrew, say) has its own label and is never changed.
// Result: one JSON line, {ok: true, broker, daemon} with each one of
// 'absent' | 'current' | 'reinstalled' | 'restarted' | 'removed' |
// 'unsupported', or {ok: false, code, message}.
//
// usage: node services.mjs refresh|remove AGENT_COMMS_DIR AGENT_BOT_DIR

import { execFile } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
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
 *
 * `version` is the running app's version and `stamp` the reconcile stamp
 * ({read() -> version|null, write(version), clear()}); `kickstart(name)`
 * restarts the named unit and resolves true only when launchd did. When the
 * stamped version differs from the running one, the bundle was swapped under
 * unchanged unit paths, so current units are restarted onto the new files.
 */
export async function refreshServices({ units, read, node, commsEntry, cli, bot, version, stamp, kickstart }) {
  const result = {};
  const reconciled = stamp ? await stamp.read() : null;
  const stale = version !== undefined && reconciled !== version;
  const broker = read(units.broker);
  if (broker === null) result.broker = 'absent';
  else if (!runsCopy(broker, node, commsEntry)) {
    // `broker install` always restarts the broker, so only on a real change.
    const installed = await cli(['broker', 'install']);
    if (!installed?.installed) throw failed(installed, 'broker-install-failed');
    result.broker = 'reinstalled';
  } else if (stale) {
    // kickstart restarts on the new files without rewriting the unit; it
    // refuses a job launchd has not loaded, so install is the fallback.
    if (kickstart && await kickstart('broker')) {
      result.broker = 'restarted';
    } else {
      const installed = await cli(['broker', 'install']);
      if (!installed?.installed) throw failed(installed, 'broker-install-failed');
      result.broker = 'reinstalled';
    }
  } else result.broker = 'current';
  if (read(units.daemon) === null) result.daemon = 'absent';
  else {
    // Idempotent: rewrites and reloads only when the unit would change.
    const installed = await bot(['daemon', 'install', '--json']);
    if (!installed?.label) throw failed(installed, 'daemon-install-failed');
    if (installed.changed) result.daemon = 'reinstalled';
    else if (!stale) result.daemon = 'current';
    else if (kickstart && await kickstart('daemon')) result.daemon = 'restarted';
    // install just ran, so a kickstart failure here is real, not "unloaded".
    else throw new SetupError('daemon-restart-failed', 'launchctl would not restart the identity daemon');
  }
  if (stamp && version !== undefined) await stamp.write(version);
  return result;
}

export async function removeServices({ units, read, cli, bot, stamp }) {
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
  // With no units there is nothing a stale version could restart.
  await stamp?.clear?.();
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
  const labels = {
    broker: process.env.AGENT_COMMS_SERVICE_LABEL,
    daemon: process.env.AGENT_BOT_SERVICE_LABEL,
  };
  const units = {
    broker: path.join(agents, `${labels.broker}.plist`),
    daemon: path.join(agents, `${labels.daemon}.plist`),
  };
  const read = (file) => (existsSync(file) ? readFileSync(file, 'utf8') : null);
  const stampFile = process.env.GENIUSBAR_SERVICES_STAMP
    ?? path.join(os.homedir(), 'Library', 'Application Support', 'app.geniusbar', 'services.json');
  const stamp = {
    read: () => {
      try { return JSON.parse(readFileSync(stampFile, 'utf8'))?.version ?? null; } catch { return null; }
    },
    write: (version) => {
      mkdirSync(path.dirname(stampFile), { recursive: true });
      writeFileSync(stampFile, `${JSON.stringify({ version })}\n`, { mode: 0o600 });
    },
    clear: () => rmSync(stampFile, { force: true }),
  };
  const kickstart = (which) => new Promise((resolve) => {
    execFile('/bin/launchctl', ['kickstart', '-k', `gui/${process.getuid()}/${labels[which]}`],
      { timeout: 15_000 }, (error) => resolve(error === null));
  });
  const version = process.env.GENIUSBAR_APP_VERSION || undefined;
  const ports = { units, read, cli: runner(commsEntry), bot: runner(botEntry), version, stamp, kickstart };
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
