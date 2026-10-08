// State a newer release wrote, read by the engines this build bundles
// (GeniusBar #282, ADR-0282, docs/compatibility-matrix.md). The fixture under
// bridge/fixtures/compat was recorded by scripts/compat-check.mjs --record
// from the engines named in its manifest; each test restores it into a
// scratch HOME, runs the pinned engine on it, and checks that committed data
// is still read, that a write keeps every field, and that what the engine
// cannot read it refuses before writing, with a diagnostic that names it.
//
// The engines come from src-tauri/resources/components (fetched by
// scripts/fetch-components.mjs, as CI does before the bridge tests) or
// from GENIUSBAR_COMPAT_AGENT_BOT and GENIUSBAR_COMPAT_AGENT_COMMS. Without
// them the tests are skipped, never failed.

import assert from 'node:assert/strict';
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { digestTree, restoreFixture, run, scratchEnv, scratchHome, startBroker, treeDiff } from '../scripts/compat-check.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const FIXTURE = path.join(ROOT, 'bridge', 'fixtures', 'compat');
const DRIVER = path.join(ROOT, 'scripts', 'compat-driver.mjs');
const COMPONENTS = path.join(ROOT, 'src-tauri', 'resources', 'components');
const engines = {
  bot: process.env.GENIUSBAR_COMPAT_AGENT_BOT ?? path.join(COMPONENTS, 'agent-bot'),
  comms: process.env.GENIUSBAR_COMPAT_AGENT_COMMS ?? path.join(COMPONENTS, 'agent-comms'),
};
const botCli = path.join(engines.bot, 'agent-bot.mjs');
const commsCli = path.join(engines.comms, 'bin', 'agent-comms.mjs');
const skip = existsSync(botCli) && existsSync(commsCli)
  ? false
  : 'bundled components not fetched: run node scripts/fetch-components.mjs, or set GENIUSBAR_COMPAT_AGENT_BOT and GENIUSBAR_COMPAT_AGENT_COMMS';

function restored(t) {
  const home = scratchHome();
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const manifest = restoreFixture(FIXTURE, home);
  const state = path.join(home, '.local', 'state');
  return {
    home,
    env: scratchEnv(home),
    manifest,
    id: manifest.agentId,
    soulDir: path.join(home, 'souls', 'compat-probe.soul'),
    population: path.join(state, 'agent-bot', 'population.json'),
    coldWake: path.join(state, 'agent-bot', 'cold-wake.json'),
    revisions: path.join(state, 'agent-bot', 'agent-identities', 'soul-revisions', manifest.agentId),
    log: path.join(state, 'agent-comms-broker', 'events.jsonl'),
  };
}
const json = (file) => JSON.parse(readFileSync(file, 'utf8'));
const editJson = (file, edit) => {
  const document = json(file);
  edit(document);
  writeFileSync(file, `${JSON.stringify(document, null, 2)}\n`);
};

test('the pinned agent-bot reads the newer census, the soul folder and its memory, and keeps every field on a launch write', { skip }, async (t) => {
  const f = restored(t);
  const before = digestTree(f.soulDir);
  const read = await run([DRIVER, 'read', engines.bot, f.id], f.env);
  assert.equal(read.exit, 0, read.stderr);
  assert.equal(read.json.row.ok, true, read.json.row.error);
  for (const key of f.manifest.rowKeys) assert.ok(key in read.json.row.value, `row keeps ${key}`);
  assert.equal(read.json.soulDir.value, f.soulDir);
  assert.equal(read.json.coldWake.value, true);
  assert.deepEqual(read.json.revisions.value.map((r) => r.revision), f.manifest.revisions);
  const shown = await run([botCli, 'population', 'show', f.id, '--json'], f.env);
  assert.equal(shown.exit, 0, shown.stderr);
  assert.equal(shown.json.sandbox, 'sandboxed');
  assert.equal(shown.json.harnessAuth.status, 'expired');
  const dir = await run([botCli, 'soul', 'dir', f.id], f.env);
  assert.equal(dir.exit, 0, dir.stderr);
  assert.equal(dir.json.soulDir, f.soulDir);

  const touch = await run([DRIVER, 'touch', engines.bot, f.id], f.env);
  assert.equal(touch.exit, 0, touch.stderr);
  assert.deepEqual(touch.json.dropped, []);
  assert.deepEqual(touch.json.changed, []);
  // Memory, history, the migration journal and the run mirror are as written.
  assert.deepEqual(treeDiff(before, digestTree(f.soulDir)), { changed: [], added: [], removed: [] });
  assert.equal(readFileSync(path.join(f.soulDir, '.soul-state', 'space', 'memory', 'notes.md'), 'utf8'), 'Remember: the owner prefers short answers.\n');
  assert.equal(json(path.join(f.soulDir, '.soul-state', 'migration.json')).steps[0].status, 'done');
});

test('a census from a future schema is read but never rewritten, and says why', { skip }, async (t) => {
  const f = restored(t);
  editJson(f.population, (document) => { document.schemaVersion = 2; });
  const bytes = readFileSync(f.population);
  const read = await run([DRIVER, 'read', engines.bot, f.id], f.env);
  assert.equal(read.json.row.ok, true, 'a newer schema still reads');
  const touch = await run([DRIVER, 'touch', engines.bot, f.id], f.env);
  assert.notEqual(touch.exit, 0);
  assert.match(touch.stderr, /population store uses a future schemaVersion; refusing to rewrite it/);
  assert.ok(readFileSync(f.population).equals(bytes), 'the store is byte-identical');
});

test('a same-schema field the pinned agent-bot does not know is dropped by its first write (the gap ADR-0282 F1 closes)', { skip }, async (t) => {
  const f = restored(t);
  editJson(f.population, (document) => { document.souls[f.id].futureField = { keep: true }; });
  const read = await run([DRIVER, 'read', engines.bot, f.id], f.env);
  assert.equal(read.json.rawRow.value.futureField.keep, true, 'the file holds the field');
  assert.equal(read.json.row.value.futureField, undefined, 'the normalized view hides it');
  const touch = await run([DRIVER, 'touch', engines.bot, f.id], f.env);
  assert.equal(touch.exit, 0, touch.stderr);
  // The component's documented behaviour at this pin: a read-modify-write
  // through normalizeSoul keeps only the fields it knows. The host guard in
  // services.mjs holds a downgrade so this write never happens unasked.
  assert.deepEqual(touch.json.dropped, ['futureField']);
  for (const key of f.manifest.rowKeys) assert.ok(key in touch.json.after, `row keeps ${key}`);
});

test('the pinned broker replays the newer log unchanged, and refuses a record it does not know before writing', { skip }, async (t) => {
  const f = restored(t);
  const bytes = readFileSync(f.log);
  const broker = await startBroker(engines.comms, f.env);
  assert.equal(broker.started, true, broker.stderr);
  try {
    const pairings = await run([commsCli, 'broker', 'pairings'], f.env);
    assert.equal(pairings.exit, 0, pairings.stderr);
    assert.equal((pairings.json.pairings ?? pairings.json).length, 1);
    assert.equal((pairings.json.pairings ?? pairings.json)[0].state, 'approved');
  } finally { await broker.stop(); }
  assert.ok(readFileSync(f.log).equals(bytes), 'replay rewrote nothing');

  writeFileSync(f.log, Buffer.concat([bytes, Buffer.from('{"t":"future-record","seq":99,"at":1791429200000}\n')]));
  const appended = readFileSync(f.log);
  const refused = await startBroker(engines.comms, f.env);
  assert.equal(refused.started, false);
  assert.match(refused.stderr, /unknown log record type future-record/);
  assert.ok(readFileSync(f.log).equals(appended), 'the refused log is byte-identical');
});

test('the pinned agent-bot lists the newer revision chain, validates each snapshot, and ignores an unknown journal kind without deleting it', { skip }, async (t) => {
  const f = restored(t);
  const history = await run([botCli, 'soul', 'revision', 'history', f.id, '--json'], f.env);
  assert.equal(history.exit, 0, history.stderr);
  assert.deepEqual(history.json.map((r) => r.revision), f.manifest.revisions);
  assert.deepEqual(history.json.map((r) => r.parentRevision), [null, ...f.manifest.revisions.slice(0, 2)]);
  for (const revision of f.manifest.revisions) {
    const snapshot = path.join(f.revisions, 'objects', `${revision.slice(7)}.soul`);
    const valid = await run([botCli, 'soul', 'pack', 'validate', snapshot], f.env);
    assert.equal(valid.exit, 0, valid.stderr);
    assert.equal(valid.json.revision, revision);
  }
  const future = path.join(f.revisions, '0000000003.json');
  writeFileSync(future, '{"schemaVersion":1,"kind":"future-kind","at":"2026-10-07T12:00:00.000Z"}\n');
  const again = await run([botCli, 'soul', 'revision', 'history', f.id, '--json'], f.env);
  assert.equal(again.exit, 0, again.stderr);
  assert.deepEqual(again.json.map((r) => r.revision), f.manifest.revisions);
  assert.ok(existsSync(future), 'the unknown record is left in place');
});

test('cold wake survives, and another soul’s setting the pinned agent-bot does not understand survives its write', { skip }, async (t) => {
  const f = restored(t);
  const other = 'agent_1f3c6a0e-5b2d-4c8e-9a71-0000000000c3';
  editJson(f.coldWake, (document) => { document.settings[other] = { lane: 'teleport', policy: 'future' }; });
  const read = await run([DRIVER, 'read', engines.bot, f.id], f.env);
  assert.equal(read.json.coldWake.value, true);
  const wake = await run([DRIVER, 'wake', engines.bot, f.id], f.env);
  assert.equal(wake.exit, 0, wake.stderr);
  assert.equal(wake.json.settings[f.id], true);
  assert.deepEqual(wake.json.settings[other], { lane: 'teleport', policy: 'future' });
});
