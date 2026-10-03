import assert from 'node:assert/strict';
import { test } from 'node:test';
import { describeUnit, inspectServices, MIGRATED, migrateServices, programArgs, refreshServices, removeServices, runsCopy } from './services.mjs';

const node = '/Applications/Genius Bar.app/Contents/MacOS/node';
const entry = '/Applications/Genius Bar.app/Contents/Resources/components/agent-comms/bin/agent-comms.mjs';
const plist = (n, e) => `<plist><dict><key>ProgramArguments</key><array>
  <string>${n}</string><string>${e}</string><string>broker</string><string>run</string>
</array></dict></plist>`;
const units = { broker: 'B', daemon: 'D' };

function fake(script) {
  const calls = [];
  const run = async (args) => {
    const key = args.join(' ');
    calls.push(key);
    if (!(key in script)) throw new Error(`unexpected: ${key}`);
    return script[key];
  };
  return { run, calls };
}

test('recognizes the copy a plist runs, escaped as launchd writes it', () => {
  assert.equal(runsCopy(plist(node, entry), node, entry), true);
  assert.equal(runsCopy(plist('/old/node', entry), node, entry), false);
  assert.equal(runsCopy(plist(node, '/old/agent-comms.mjs'), node, entry), false);
  assert.equal(runsCopy(plist('/a&amp;b/node', entry), '/a&b/node', entry), true);
});

test('refresh leaves current services alone and re-registers moved ones', async () => {
  const cli = fake({ 'broker install': { ok: true, installed: true } });
  const bot = fake({ 'daemon install --json': { label: 'app.geniusbar.agent-bot', changed: false, loaded: true } });
  const current = { B: plist(node, entry), D: '<plist/>' };
  assert.deepEqual(await refreshServices({ units, read: (f) => current[f], node, commsEntry: entry, cli: cli.run, bot: bot.run }),
    { broker: 'current', daemon: 'current' });
  assert.deepEqual(cli.calls, []);

  const moved = { B: plist('/Users/me/Downloads/GeniusBar.app/Contents/MacOS/node', entry), D: '<plist/>' };
  const bot2 = fake({ 'daemon install --json': { label: 'app.geniusbar.agent-bot', changed: true, loaded: true } });
  assert.deepEqual(await refreshServices({ units, read: (f) => moved[f], node, commsEntry: entry, cli: cli.run, bot: bot2.run }),
    { broker: 'reinstalled', daemon: 'reinstalled' });
  assert.deepEqual(cli.calls, ['broker install']);
});

test('refresh restarts unchanged units when the running version moved (#34)', async () => {
  const kicks = [];
  const kickstart = async (which) => { kicks.push(which); return true; };
  const stamp = {
    version: '0.1.0',
    read: async () => stamp.version,
    write: async (v) => { stamp.version = v; },
  };
  const cli = fake({});
  const bot = fake({ 'daemon install --json': { label: 'app.geniusbar.agent-bot', changed: false, loaded: true } });
  const current = { B: plist(node, entry), D: '<plist/>' };
  assert.deepEqual(await refreshServices({ units, read: (f) => current[f], node, commsEntry: entry,
    cli: cli.run, bot: bot.run, version: '0.1.1', stamp, kickstart }),
    { broker: 'restarted', daemon: 'restarted' });
  assert.deepEqual(kicks, ['broker', 'daemon']);
  assert.equal(stamp.version, '0.1.1');
});

test('a missing stamp means never reconciled: the first refresh restarts', async () => {
  const kicks = [];
  const stamp = { read: async () => null, write: async () => {} };
  const kickstart = async (which) => { kicks.push(which); return true; };
  const bot = fake({ 'daemon install --json': { label: 'app.geniusbar.agent-bot', changed: false, loaded: true } });
  const current = { B: plist(node, entry), D: '<plist/>' };
  assert.deepEqual(await refreshServices({ units, read: (f) => current[f], node, commsEntry: entry,
    cli: fake({}).run, bot: bot.run, version: '0.1.1', stamp, kickstart }),
    { broker: 'restarted', daemon: 'restarted' });
  assert.deepEqual(kicks, ['broker', 'daemon']);
});

test('the stamped version leaves current services alone', async () => {
  const stamp = { read: async () => '0.1.1', written: null, write: async (v) => { stamp.written = v; } };
  const kickstart = async () => { throw new Error('must not run'); };
  const bot = fake({ 'daemon install --json': { label: 'app.geniusbar.agent-bot', changed: false, loaded: true } });
  const current = { B: plist(node, entry), D: '<plist/>' };
  assert.deepEqual(await refreshServices({ units, read: (f) => current[f], node, commsEntry: entry,
    cli: fake({}).run, bot: bot.run, version: '0.1.1', stamp, kickstart }),
    { broker: 'current', daemon: 'current' });
  assert.equal(stamp.written, '0.1.1');
});

test('absent units stay absent and still move the stamp forward', async () => {
  const stamp = { read: async () => '0.1.0', written: null, write: async (v) => { stamp.written = v; } };
  const kickstart = async () => { throw new Error('must not run'); };
  assert.deepEqual(await refreshServices({ units, read: () => null, node, commsEntry: entry,
    cli: fake({}).run, bot: fake({}).run, version: '0.1.1', stamp, kickstart }),
    { broker: 'absent', daemon: 'absent' });
  assert.equal(stamp.written, '0.1.1');
});

test('a broker that will not kickstart is reinstalled instead', async () => {
  const cli = fake({ 'broker install': { ok: true, installed: true } });
  const bot = fake({ 'daemon install --json': { label: 'app.geniusbar.agent-bot', changed: false, loaded: true } });
  const stamp = { read: async () => '0.1.0', write: async () => {} };
  const kickstart = async (which) => which === 'daemon';
  const current = { B: plist(node, entry), D: '<plist/>' };
  assert.deepEqual(await refreshServices({ units, read: (f) => current[f], node, commsEntry: entry,
    cli: cli.run, bot: bot.run, version: '0.1.1', stamp, kickstart }),
    { broker: 'reinstalled', daemon: 'restarted' });
  assert.deepEqual(cli.calls, ['broker install']);
});

test('a daemon that will not restart after install fails the refresh', async () => {
  const bot = fake({ 'daemon install --json': { label: 'app.geniusbar.agent-bot', changed: false, loaded: true } });
  const stamp = { read: async () => '0.1.0', write: async () => { throw new Error('must not write'); } };
  const current = { B: plist(node, entry), D: '<plist/>' };
  // The broker kickstarts fine; the daemon's failure stops the stamp write.
  const kickstart = async (which) => which === 'broker';
  await assert.rejects(refreshServices({ units, read: (f) => current[f], node, commsEntry: entry,
    cli: fake({}).run, bot: bot.run, version: '0.1.1', stamp, kickstart }),
    { code: 'daemon-restart-failed' });
});

test('refresh never registers a service setup did not, and reports failures', async () => {
  const none = fake({});
  assert.deepEqual(await refreshServices({ units, read: () => null, node, commsEntry: entry, cli: none.run, bot: none.run }),
    { broker: 'absent', daemon: 'absent' });
  assert.deepEqual(none.calls, []);
  const cli = fake({ 'broker install': { ok: false, error: { code: 'launchagent-load-failed', message: 'no' } } });
  await assert.rejects(refreshServices({ units, read: (f) => (f === 'B' ? plist('/old', entry) : null), node, commsEntry: entry,
    cli: cli.run, bot: none.run }), { code: 'launchagent-load-failed' });
});

test('remove unloads and deletes both GeniusBar units, skipping absent ones', async () => {
  const cli = fake({ 'broker uninstall': { ok: true, installed: false, unloaded: true } });
  const bot = fake({ 'daemon disable --json': { unloaded: true } });
  const stamp = { cleared: 0, clear: async () => { stamp.cleared += 1; } };
  assert.deepEqual(await removeServices({ units, read: () => 'x', cli: cli.run, bot: bot.run, stamp }),
    { daemon: 'removed', broker: 'removed' });
  assert.equal(stamp.cleared, 1);
  const none = fake({});
  assert.deepEqual(await removeServices({ units, read: () => null, cli: none.run, bot: none.run }), { daemon: 'absent', broker: 'absent' });
  const stuck = fake({ 'daemon disable --json': { ok: false, error: { code: 'launchctl-failed', message: 'busy' } } });
  await assert.rejects(removeServices({ units, read: () => 'x', cli: none.run, bot: stuck.run }), { code: 'launchctl-failed' });
});

const keyd = '/Applications/Genius Bar.app/Contents/MacOS/agent-bot-keyd';
const keydInstall = `keyd install --bin ${keyd} --json`;

test('refresh keeps agent-bot-keyd running beside the daemon (agent-bot-identity #397)', async () => {
  const current = { B: plist(node, entry), D: '<plist/>' };
  const daemon = { 'daemon install --json': { label: 'app.geniusbar.agent-bot', changed: false, loaded: true } };
  const fresh = fake({ ...daemon, [keydInstall]: { label: 'app.geniusbar.keyd', changed: true, loaded: true } });
  assert.deepEqual(await refreshServices({ units, read: (f) => current[f], node, commsEntry: entry, cli: fake({}).run, bot: fresh.run, keyd }),
    { broker: 'current', daemon: 'current', keyd: 'reinstalled' });
  assert.deepEqual(fresh.calls, ['daemon install --json', keydInstall]);

  const kicks = [];
  const stamp = { read: async () => '0.1.0', write: async () => {} };
  const same = fake({ ...daemon, [keydInstall]: { label: 'app.geniusbar.keyd', changed: false, loaded: true } });
  assert.deepEqual(await refreshServices({ units, read: (f) => current[f], node, commsEntry: entry, cli: fake({}).run, bot: same.run,
    keyd, version: '0.1.1', stamp, kickstart: async (which) => { kicks.push(which); return true; } }),
    { broker: 'restarted', daemon: 'restarted', keyd: 'restarted' });
  assert.deepEqual(kicks, ['broker', 'daemon', 'keyd']);

  // An agent-bot that predates `keyd install` never fails the refresh.
  const old = fake({ ...daemon, [keydInstall]: null });
  assert.deepEqual(await refreshServices({ units, read: (f) => current[f], node, commsEntry: entry, cli: fake({}).run, bot: old.run, keyd }),
    { broker: 'current', daemon: 'current', keyd: 'unavailable' });

  // No daemon unit: setup has not run, so keyd is not installed either.
  const none = fake({});
  assert.deepEqual(await refreshServices({ units, read: () => null, node, commsEntry: entry, cli: none.run, bot: none.run, keyd }),
    { broker: 'absent', daemon: 'absent', keyd: 'absent' });
  assert.deepEqual(none.calls, []);
});

test('remove unloads agent-bot-keyd first and keeps its keys', async () => {
  const bot = fake({ 'keyd uninstall --json': { unloaded: true }, 'daemon disable --json': { unloaded: true } });
  const cli = fake({ 'broker uninstall': { ok: true, installed: false, unloaded: true } });
  assert.deepEqual(await removeServices({ units, read: () => 'x', cli: cli.run, bot: bot.run, keyd }),
    { keyd: 'removed', daemon: 'removed', broker: 'removed' });
  assert.deepEqual(bot.calls, ['keyd uninstall --json', 'daemon disable --json']);
});

// Homebrew's units, as the host has them (#41).
const brewBroker = `<plist><dict><key>Label</key><string>dev.qwts.agent-comms.broker</string>
<key>ProgramArguments</key><array>
  <string>/opt/homebrew/Cellar/node/26.10.0_1/bin/node</string>
  <string>/opt/homebrew/Cellar/agent-comms/0.3.1/libexec/bin/agent-comms.mjs</string>
  <string>broker</string><string>run</string><string>--single-account</string>
</array></dict></plist>`;
const brewDaemon = `<plist><dict><key>ProgramArguments</key><array>
  <string>/opt/homebrew/opt/node/bin/node</string><string>/opt/homebrew/opt/agent-bot/libexec/agent-bot.mjs</string>
  <string>daemon</string><string>run</string>
</array></dict></plist>`;
const foreign = {
  broker: { label: 'dev.qwts.agent-comms.broker', plist: '/LA/dev.qwts.agent-comms.broker.plist' },
  daemon: { label: 'dev.qwts.agent-bot.daemon', plist: '/LA/dev.qwts.agent-bot.daemon.plist' },
};

function launchd(files, { bootoutOk = true, bootstrapOk = true, loaded = true } = {}) {
  const log = [];
  return {
    log,
    read: (file) => files[file] ?? null,
    loaded: async () => loaded,
    bootout: async (label) => { log.push(`bootout ${label}`); return bootoutOk; },
    bootstrap: async (plist) => { log.push(`bootstrap ${plist}`); return bootstrapOk; },
    rename: (from, to) => { log.push(`rename ${from} -> ${to}`); files[to] = files[from]; delete files[from]; },
  };
}
const fast = { sleep: async () => {}, now: (() => { let t = 0; return () => (t += 1000); })() };

test('reads a unit’s program and its Homebrew version', async () => {
  assert.deepEqual(programArgs(brewBroker).slice(2), ['broker', 'run', '--single-account']);
  assert.deepEqual(describeUnit('dev.qwts.agent-comms.broker', brewBroker),
    { label: 'dev.qwts.agent-comms.broker', program: programArgs(brewBroker), version: '0.3.1', homebrew: true });
  assert.equal(describeUnit('x', brewDaemon).version, null);
  assert.equal(describeUnit('x', plist('/n', '/e').replace('<string>run</string>', '<string>run</string><string>--group</string><string>agents</string>')).group, 'agents');
  assert.deepEqual(await inspectServices({ foreign, read: () => null }), { broker: null, daemon: null });
});

test('migrate stops Homebrew’s units, starts GeniusBar’s, then renames the old units aside', async () => {
  const files = { [foreign.broker.plist]: brewBroker, [foreign.daemon.plist]: brewDaemon };
  const host = launchd(files);
  const cli = fake({ 'broker install': { installed: true }, 'broker pairings': { ok: true, pairings: [] } });
  const bot = fake({ 'daemon install --json': { label: 'app.geniusbar.agent-bot' }, 'daemon status --json': { running: true } });
  assert.deepEqual(await migrateServices({ foreign, ...host, cli: cli.run, bot: bot.run, ...fast }), { broker: 'migrated', daemon: 'migrated' });
  assert.deepEqual(host.log, [
    'bootout dev.qwts.agent-bot.daemon',
    'bootout dev.qwts.agent-comms.broker',
    `rename ${foreign.broker.plist} -> ${foreign.broker.plist}${MIGRATED}`,
    `rename ${foreign.daemon.plist} -> ${foreign.daemon.plist}${MIGRATED}`,
  ]);
  assert.deepEqual(cli.calls, ['broker install', 'broker pairings']);
  assert.deepEqual(bot.calls, ['daemon install --json', 'daemon status --json']);
  // Nothing left to move: a second run changes nothing.
  assert.deepEqual(await migrateServices({ foreign, ...host, cli: cli.run, bot: bot.run, ...fast }), { broker: 'absent', daemon: 'absent' });
});

test('a group broker keeps its group when it moves', async () => {
  const grouped = brewBroker.replace('<string>--single-account</string>', '<string>--group</string><string>agents</string>');
  const host = launchd({ [foreign.broker.plist]: grouped });
  const cli = fake({ 'broker install --group agents': { installed: true }, 'broker pairings': { ok: true } });
  const bot = fake({ 'daemon install --json': { label: 'l' }, 'daemon status --json': { running: true } });
  assert.deepEqual(await migrateServices({ foreign, ...host, cli: cli.run, bot: bot.run, ...fast }), { broker: 'migrated', daemon: 'absent' });
});

test('a failed migration removes GeniusBar’s units and starts the old ones again', async () => {
  const files = { [foreign.broker.plist]: brewBroker, [foreign.daemon.plist]: brewDaemon };
  const host = launchd(files);
  const cli = fake({ 'broker install': { installed: true }, 'broker pairings': { ok: true }, 'broker uninstall': { installed: false } });
  const bot = fake({ 'daemon install --json': { label: 'l' }, 'daemon status --json': { running: false }, 'daemon disable --json': { unloaded: true } });
  await assert.rejects(migrateServices({ foreign, ...host, cli: cli.run, bot: bot.run, ...fast }), (error) => {
    assert.equal(error.code, 'daemon-not-ready');
    assert.match(error.message, /previous services were started again/);
    return true;
  });
  assert.ok(cli.calls.includes('broker uninstall'));
  assert.ok(bot.calls.includes('daemon disable --json'));
  assert.deepEqual(host.log.filter((line) => line.startsWith('bootstrap')), [`bootstrap ${foreign.broker.plist}`, `bootstrap ${foreign.daemon.plist}`]);
  // The old units were never renamed.
  assert.ok(files[foreign.broker.plist] && files[foreign.daemon.plist]);
});

test('a unit launchd will not stop ends the migration before anything is installed', async () => {
  const host = launchd({ [foreign.daemon.plist]: brewDaemon }, { bootoutOk: false });
  const cli = fake({});
  const bot = fake({});
  await assert.rejects(migrateServices({ foreign, ...host, cli: cli.run, bot: bot.run, ...fast }), /would not stop dev\.qwts\.agent-bot\.daemon/);
  assert.deepEqual([...cli.calls, ...bot.calls], []);
  assert.deepEqual(host.log, ['bootout dev.qwts.agent-bot.daemon']);
});

test('inspect checks launchd for present units and distinguishes stopped plists', async () => {
  const checked = [];
  const files = { [foreign.broker.plist]: brewBroker, [foreign.daemon.plist]: brewDaemon };
  const found = await inspectServices({ foreign, read: (file) => files[file] ?? null,
    loaded: async (label) => { checked.push(label); return label === foreign.broker.label; } });
  assert.equal(found.broker.state, 'running');
  assert.equal(found.daemon.state, 'stopped');
  assert.deepEqual(checked, [foreign.broker.label, foreign.daemon.label]);
  checked.length = 0;
  assert.deepEqual(await inspectServices({ foreign, read: () => null,
    loaded: async (label) => { checked.push(label); return true; } }), { broker: null, daemon: null });
  assert.deepEqual(checked, []);
});

test('migration renames stopped plists without trying to bootout unloaded units', async () => {
  const files = { [foreign.broker.plist]: brewBroker, [foreign.daemon.plist]: brewDaemon };
  const host = launchd(files, { loaded: false, bootoutOk: false });
  const cli = fake({ 'broker install': { installed: true }, 'broker pairings': { ok: true } });
  const bot = fake({ 'daemon install --json': { label: 'l' }, 'daemon status --json': { running: true } });
  assert.deepEqual(await migrateServices({ foreign, ...host, cli: cli.run, bot: bot.run, ...fast }),
    { broker: 'migrated', daemon: 'migrated' });
  assert.deepEqual(host.log, [
    `rename ${foreign.broker.plist} -> ${foreign.broker.plist}${MIGRATED}`,
    `rename ${foreign.daemon.plist} -> ${foreign.daemon.plist}${MIGRATED}`,
  ]);
});

test('failure on the second plist rename restores files and rolls services back', async () => {
  const files = { [foreign.broker.plist]: brewBroker, [foreign.daemon.plist]: brewDaemon };
  const original = { ...files };
  const host = launchd(files);
  const cli = fake({ 'broker install': { installed: true }, 'broker pairings': { ok: true }, 'broker uninstall': { installed: false } });
  const bot = fake({ 'daemon install --json': { label: 'l' }, 'daemon status --json': { running: true }, 'daemon disable --json': { unloaded: true } });
  const rename = (from, to) => {
    if (from === foreign.daemon.plist) throw Object.assign(new Error('rename denied'), { code: 'EACCES' });
    host.rename(from, to);
  };
  await assert.rejects(migrateServices({ foreign, ...host, rename, cli: cli.run, bot: bot.run, ...fast }),
    { code: 'EACCES', message: 'rename denied; the previous services were started again' });
  assert.deepEqual(files, original);
  assert.deepEqual(cli.calls, ['broker install', 'broker pairings', 'broker uninstall']);
  assert.deepEqual(bot.calls, ['daemon install --json', 'daemon status --json', 'daemon disable --json']);
  assert.deepEqual(host.log.slice(2), [
    `rename ${foreign.broker.plist} -> ${foreign.broker.plist}${MIGRATED}`,
    `rename ${foreign.broker.plist}${MIGRATED} -> ${foreign.broker.plist}`,
    `bootstrap ${foreign.broker.plist}`,
    `bootstrap ${foreign.daemon.plist}`,
  ]);
});

test('failed migration leaves stopped foreign units unloaded', async () => {
  const files = { [foreign.broker.plist]: brewBroker };
  const host = launchd(files, { loaded: false });
  const cli = fake({ 'broker install': { installed: true }, 'broker pairings': { ok: true }, 'broker uninstall': { installed: false } });
  const bot = fake({ 'daemon install --json': { error: { code: 'denied', message: 'no' } } });
  await assert.rejects(migrateServices({ foreign, ...host, cli: cli.run, bot: bot.run, ...fast }), { code: 'denied' });
  assert.deepEqual(host.log, []);
  assert.deepEqual(files, { [foreign.broker.plist]: brewBroker });
});
