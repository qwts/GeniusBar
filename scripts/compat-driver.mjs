#!/usr/bin/env node
// Writes and reads agent-bot state through one pinned engine's own library
// (GeniusBar #282, ADR-0282), the way the daemon and the CLI do, so
// scripts/compat-check.mjs and bridge/compat.test.mjs can hand a store
// written by one release to another release and see what it keeps. Every
// path comes from the environment the caller sets up (HOME, XDG_STATE_HOME,
// AGENT_BOT_SOULS_HOME), never from the real account.
//
// usage: node compat-driver.mjs MODE AGENT_BOT_DIR [AGENT_ID]
//   write  Mint an identity with a soul folder, a census row carrying every
//          field this engine knows, a three-revision package chain, cold
//          wake on, and `.soul-state` memory, history and a migration
//          journal where this engine has them. Prints what it wrote.
//   read   Read the row, the revision chain, the cold wake setting and the
//          soul folder back; each probe reports its value or its error.
//   touch  What the daemon does at a launch: recordSoulLaunch, with comms
//          off and on again so the row is rewritten. Prints the row before
//          and after and the keys that did not survive.
//   wake   The owner turning cold wake off and on again for the soul.
//          Prints the settings file as it is afterwards.
// Output is one JSON document on stdout.

import { createHash } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const [mode, engine, agentId] = process.argv.slice(2);
if (!['write', 'read', 'touch', 'wake'].includes(mode) || !engine || (mode !== 'write' && !agentId)) {
  process.stderr.write('usage: compat-driver.mjs write|read|touch|wake AGENT_BOT_DIR [AGENT_ID]\n');
  process.exit(2);
}
const load = (file) => import(pathToFileURL(path.join(engine, file)).href);
const optional = (file) => load(file).catch(() => null);
const probe = (fn) => {
  try { return { ok: true, value: fn() }; } catch (error) { return { ok: false, error: error.message }; }
};
const ZERO = `sha256:${'0'.repeat(64)}`;
const AT = '2026-10-07T12:00:00.000Z';
const now = () => new Date(AT);
const soulsRoot = process.env.AGENT_BOT_SOULS_HOME;
if (!soulsRoot) throw new Error('AGENT_BOT_SOULS_HOME must point into the scratch HOME');
const soulDir = path.join(soulsRoot, 'compat-probe.soul');
const spacePath = path.join(soulDir, '.soul-state', 'space');
// The package the revision chain snapshots, beside the soul folder: a
// format-1 package hashes every file, so the folder's `.soul-state` must
// not be in it (that is what a revision edit publishes *into* the folder).
const packagePath = path.join(path.dirname(soulsRoot), 'packages', 'compat-probe.soul');

/** Every regular file below `dir` with its SHA-256, keyed by relative path. */
export function digestTree(dir) {
  const out = {};
  const walk = (current) => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const file = path.join(current, entry.name);
      if (entry.isDirectory()) walk(file);
      else if (entry.isFile()) out[path.relative(dir, file)] = createHash('sha256').update(readFileSync(file)).digest('hex');
    }
  };
  if (existsSync(dir) && statSync(dir).isDirectory()) walk(dir);
  return out;
}

const population = await load('agent-population.mjs');
const row = (id) => population.showSoul(id);
// The row as the file holds it, so a key this engine does not know shows up
// here and not in the normalized view `row` gives.
const rawRow = (id) => JSON.parse(readFileSync(population.populationFile(), 'utf8')).souls[id];

async function write() {
  const { mintAgentIdentity } = await load('agent-identity.mjs');
  const { computePackageRevision } = await load('soul-package.mjs');
  const revisions = await load('soul-revisions.mjs');
  const coldWake = await load('cold-wake-settings.mjs');
  const history = await optional('soul-history.mjs');
  const journal = await optional('soul-migration-journal.mjs');

  mkdirSync(packagePath, { recursive: true, mode: 0o700 });
  mkdirSync(soulDir, { recursive: true, mode: 0o700 });
  const manifest = {
    formatVersion: 1, name: 'Compat Probe', description: 'State written for the compatibility check', displaySeed: 'compat',
    preferredHarnesses: ['claude'], revision: ZERO, parentRevision: null,
  };
  const writeManifest = () => writeFileSync(path.join(packagePath, 'soul.json'), `${JSON.stringify(manifest, null, 2)}\n`);
  writeManifest();
  writeFileSync(path.join(packagePath, 'AGENTS.md'), 'Revision one.\n');
  manifest.revision = computePackageRevision(packagePath);
  writeManifest();
  for (const file of ['soul.json', 'AGENTS.md']) writeFileSync(path.join(soulDir, file), readFileSync(path.join(packagePath, file)));

  const identity = mintAgentIdentity({ appSlug: 'compat-probe', packagePath, now });
  const id = identity.id;
  const state = path.join(soulDir, '.soul-state');
  mkdirSync(state, { recursive: true, mode: 0o700 });
  writeFileSync(path.join(state, 'agent-id'), `${id}\n`, { mode: 0o600 });
  for (const [file, text] of [['memory/notes.md', 'Remember: the owner prefers short answers.\n'], ['history/2026-10-07.md', 'Answered two messages.\n']]) {
    mkdirSync(path.join(spacePath, path.dirname(file)), { recursive: true, mode: 0o700 });
    writeFileSync(path.join(spacePath, file), text, { mode: 0o600 });
  }
  chmodSync(state, 0o700);

  // The census row with every field this engine's normalizeSoul keeps; a
  // field an older engine does not know is what a downgrade would drop.
  const record = {
    id, name: 'compat-probe', soulDir, appSlug: 'compat-probe', parentId: null, status: 'active', spacePath,
    worktree: null, transcriptLocator: { provider: 'claude', id: 'session-1' }, lastSeen: AT,
    managed: true, comms: true, brief: 'Compatibility probe', paused: false, computerUse: true,
    sandbox: 'sandboxed', displayName: 'Compat Probe', harnessAuth: { status: 'expired', harness: 'claude', since: AT },
  };
  population.upsertSoul(record, { now });

  const chain = [revisions.adoptSoulPackage(id, packagePath, { reason: 'Starting package', now })];
  for (const n of [2, 3]) {
    writeFileSync(path.join(packagePath, 'AGENTS.md'), `Revision ${n}.\n`);
    chain.push(await revisions.editSoulRevision(id, packagePath, { reason: `Edit ${n}`, now }));
  }
  const written = {
    turns: history ? history.appendSoulTurn(soulDir, { id: 'turn-1', kind: 'turn', startedAt: AT, endedAt: AT, harness: 'claude', outcome: 'ok' }) : null,
    journal: journal ? Boolean(journal.recordMigrationStep(soulDir, { id: 'space-into-soul', status: 'done', from: path.join(process.env.HOME, '.agent-space', 'compat-probe'), to: spacePath, at: AT, note: 'compat probe' })) : null,
  };
  coldWake.setColdWake(id, true, { now });
  return {
    id, soulDir, spacePath, row: row(id), revisions: chain.map((r) => r.revision), written,
    engineVersion: JSON.parse(readFileSync(path.join(engine, 'package.json'), 'utf8')).version,
  };
}

async function read(id) {
  const revisions = await load('soul-revisions.mjs');
  const coldWake = await load('cold-wake-settings.mjs');
  const dir = probe(() => population.soulDirectory(id, { readOnly: true }));
  return {
    row: probe(() => row(id)),
    rawRow: probe(() => rawRow(id)),
    revisions: probe(() => revisions.revisionHistory(id).map((r) => ({ revision: r.revision, parentRevision: r.parentRevision, reason: r.reason }))),
    coldWake: probe(() => coldWake.readColdWakeSettings()[id] ?? null),
    soulDir: dir,
    soulState: dir.ok ? digestTree(path.join(dir.value, '.soul-state')) : null,
    engineVersion: JSON.parse(readFileSync(path.join(engine, 'package.json'), 'utf8')).version,
  };
}

// A launch that turns the soul's comms off and then on again: each call
// rewrites the row through this engine's normalizeSoul, as the daemon does
// at a launch, so a key this engine does not keep is gone afterwards.
function touch(id) {
  const before = rawRow(id);
  population.recordSoulLaunch(id, { comms: false });
  population.recordSoulLaunch(id, { comms: true });
  const after = rawRow(id);
  const dropped = Object.keys(before).filter((key) => !(key in after));
  const changed = Object.keys(after).filter((key) => key in before && JSON.stringify(before[key]) !== JSON.stringify(after[key]));
  return { before, after, dropped, changed };
}

async function wake(id) {
  const coldWake = await load('cold-wake-settings.mjs');
  coldWake.setColdWake(id, false, { now });
  coldWake.setColdWake(id, true, { now });
  return { settings: JSON.parse(readFileSync(coldWake.coldWakeFile(), 'utf8')).settings };
}

const result = mode === 'write' ? await write() : mode === 'read' ? await read(agentId) : mode === 'wake' ? await wake(agentId) : touch(agentId);
process.stdout.write(`${JSON.stringify(result)}\n`);
