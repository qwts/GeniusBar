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
//   inspect  Report another install's broker and daemon (Homebrew's), if
//            any, so setup can offer to move them over (#41).
//   migrate  The owner's explicit action: stop that install's units and
//            start GeniusBar's own in their place, or put them back.
//
// Only units under GeniusBar's labels are touched, except by migrate. A
// broker or daemon from another install (Homebrew, say) has its own label;
// migrate stops it, and renames its unit aside only once GeniusBar's are
// running. Both installs keep their state in the same directories, so the
// souls, inboxes, pairings and daemon settings carry over as they are.
// Result: one JSON line, {ok: true, broker, daemon} with each one of
// 'absent' | 'current' | 'reinstalled' | 'restarted' | 'removed' |
// 'migrated' | 'unsupported' (inspect: null or {label, program, version, state}),
// or {ok: false, code, message}.
//
// usage: node services.mjs refresh|remove|inspect|migrate AGENT_COMMS_DIR AGENT_BOT_DIR

import { execFile } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
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

/** The labels a Homebrew (or source) install of agent-comms and agent-bot uses. */
export const FOREIGN_LABELS = { broker: 'dev.qwts.agent-comms.broker', daemon: 'dev.qwts.agent-bot.daemon' };
/** A migrated unit is renamed to this, so launchd no longer loads it at login. */
export const MIGRATED = '.geniusbar-migrated';
const MIGRATE_WAIT_MS = 15_000;

const xmlUnescape = (value) => value.replaceAll('&lt;', '<').replaceAll('&gt;', '>')
  .replaceAll('&quot;', '"').replaceAll('&apos;', "'").replaceAll('&amp;', '&');

/** A launchd plist's ProgramArguments, or [] when it has none. */
export function programArgs(plist) {
  const block = plist.match(/<key>ProgramArguments<\/key>\s*<array>([\s\S]*?)<\/array>/);
  return block ? [...block[1].matchAll(/<string>([^<]*)<\/string>/g)].map((m) => xmlUnescape(m[1])) : [];
}

/** What another install's unit runs: its command line and, from a Cellar path, its version. */
export function describeUnit(label, plist) {
  const program = programArgs(plist);
  const cellar = program.map((arg) => arg.match(/\/Cellar\/(agent-comms|agent-bot)\/([^/]+)\//)).find(Boolean);
  const group = program.indexOf('--group');
  return {
    label,
    program,
    version: cellar ? cellar[2] : null,
    homebrew: program.some((arg) => arg.startsWith('/opt/homebrew/') || arg.startsWith('/usr/local/')),
    ...(group >= 0 && program[group + 1] ? { group: program[group + 1] } : {}),
  };
}

/** Another install's units: null when absent, running when loaded in launchd. */
export async function inspectServices({ foreign, read, loaded }) {
  const found = {};
  for (const which of ['broker', 'daemon']) {
    const plist = read(foreign[which].plist);
    found[which] = plist === null ? null : {
      ...describeUnit(foreign[which].label, plist),
      state: await loaded(foreign[which].label) ? 'running' : 'stopped',
    };
  }
  return found;
}

/**
 * Moves another install's broker and daemon over to GeniusBar's own units.
 * Its units are stopped (`bootout`), GeniusBar's are installed and must
 * answer, and only then are the old units renamed aside. Any failure
 * restores renamed plists, removes what was installed and starts the old
 * loaded units again (`bootstrap`). Present but unloaded plists are renamed
 * aside without bootout, and remain unloaded on rollback,
 * so a failed or cancelled move leaves the machine running as before.
 */
export async function migrateServices({ foreign, read, loaded, cli, bot, bootout, bootstrap, rename, sleep = (ms) => new Promise((r) => setTimeout(r, ms)), now = Date.now }) {
  const found = await inspectServices({ foreign, read, loaded });
  if (!found.broker && !found.daemon) return { broker: 'absent', daemon: 'absent' };
  const stopped = [];
  const installed = [];
  const renamed = [];
  const waitFor = async (probe, code, message) => {
    const deadline = now() + MIGRATE_WAIT_MS;
    while (!(await probe())) {
      if (now() > deadline) throw new SetupError(code, message);
      await sleep(250);
    }
  };
  try {
    // The daemon talks to the broker, so it stops first and starts last.
    for (const which of ['daemon', 'broker']) {
      if (found[which]?.state !== 'running') continue;
      if (!(await bootout(foreign[which].label))) throw new SetupError('migrate-stop-failed', `launchctl would not stop ${foreign[which].label}`);
      stopped.push(which);
    }
    const group = found.broker?.group;
    const broker = await cli(['broker', 'install', ...(group ? ['--group', group] : [])]);
    if (!broker?.installed) throw failed(broker, 'broker-install-failed');
    installed.push('broker');
    await waitFor(async () => (await cli(['broker', 'pairings']))?.ok, 'broker-not-ready', 'GeniusBar’s broker did not start');
    const daemon = await bot(['daemon', 'install', '--json']);
    if (!daemon?.label) throw failed(daemon, 'daemon-install-failed');
    installed.push('daemon');
    await waitFor(async () => (await bot(['daemon', 'status', '--json']))?.running, 'daemon-not-ready', 'GeniusBar’s identity daemon did not start');
    const result = {};
    for (const which of ['broker', 'daemon']) {
      if (!found[which]) { result[which] = 'absent'; continue; }
      rename(foreign[which].plist, `${foreign[which].plist}${MIGRATED}`);
      renamed.push(which);
      result[which] = 'migrated';
    }
    return result;
  } catch (error) {
    const unrestored = [];
    for (const which of renamed.reverse()) {
      try { rename(`${foreign[which].plist}${MIGRATED}`, foreign[which].plist); }
      catch { unrestored.push(which); }
    }
    if (installed.includes('daemon')) await bot(['daemon', 'disable', '--json']);
    if (installed.includes('broker')) await cli(['broker', 'uninstall']);
    const restored = [];
    for (const which of ['broker', 'daemon']) {
      if (stopped.includes(which) && !unrestored.includes(which) && await bootstrap(foreign[which].plist)) restored.push(which);
    }
    const back = restored.length === stopped.length ? 'the previous services were started again' : 'the previous services could not all be started again';
    const files = unrestored.length ? '; some previous plists could not be restored' : '';
    throw new SetupError(error.code ?? 'migrate-failed', `${error.message}; ${back}${files}`);
  }
}

async function main() {
  const [action, commsDir, botDir] = process.argv.slice(2);
  const write = (message) => process.stdout.write(`${JSON.stringify(message)}\n`);
  if (!['refresh', 'remove', 'inspect', 'migrate'].includes(action) || !commsDir || !botDir) {
    process.stderr.write('usage: services.mjs refresh|remove|inspect|migrate AGENT_COMMS_DIR AGENT_BOT_DIR\n');
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
  const foreign = Object.fromEntries(Object.entries(FOREIGN_LABELS)
    .map(([which, label]) => [which, { label, plist: path.join(agents, `${label}.plist`) }]));
  const launchctl = (args) => new Promise((resolve) => {
    execFile('/bin/launchctl', args, { timeout: 15_000 }, (error) => resolve(error === null));
  });
  const migration = {
    foreign,
    loaded: (label) => launchctl(['print', `gui/${process.getuid()}/${label}`]),
    bootout: (label) => launchctl(['bootout', `gui/${process.getuid()}/${label}`]),
    bootstrap: (plist) => launchctl(['bootstrap', `gui/${process.getuid()}`, plist]),
    rename: renameSync,
  };
  try {
    const result = action === 'refresh'
      ? await refreshServices({ ...ports, node: process.execPath, commsEntry })
      : action === 'inspect' ? await inspectServices({ ...migration, read })
        : action === 'migrate' ? await migrateServices({ ...ports, ...migration })
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
