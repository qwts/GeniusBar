#!/usr/bin/env node
// Exercises released component pairs against each other (GeniusBar #282,
// ADR-0282, docs/compatibility-matrix.md): state is written by the newer
// pinned engine in a scratch HOME, then read, and written once, by the older
// one, the way a downgrade or a move from a newer Homebrew install would.
// Each pinned release is materialized with fetch-components' own tag-and-
// commit check, so what runs is exactly what a GeniusBar release bundled.
//
// usage: node scripts/compat-check.mjs [--json] [--pair agent-bot:vNEW:vOLD]...
//          [--pair agent-comms:vNEW:vOLD]... [--record DIR]
//          [--engines DIR] [--comms-remote URL|PATH] [--bot-remote URL|PATH]
//
// --pair names a writer and a reader tag (both must be in PINS); without
// any, DEFAULT_PAIRS run. --record writes the newest engines' state into
// DIR as the committed fixtures bridge/compat.test.mjs replays with the
// currently pinned engines, with the scratch HOME replaced by __HOME__.
// --engines is the cache (default .cache/compat-engines); the remotes
// default to GitHub and accept a local mirror for offline runs.
//
// Nothing here touches the real HOME, state directories, keychain or
// services: every engine runs with HOME, XDG_* and AGENT_* pointed into a
// scratch directory that is removed afterwards.

import { createHash } from 'node:crypto';
import { execFile, spawn } from 'node:child_process';
import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { fetchComponent } from './fetch-components.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DRIVER = path.join(ROOT, 'scripts', 'compat-driver.mjs');

/** Released component commits by tag (verified against the tag on fetch). */
export const PINS = {
  'agent-comms': {
    'v0.3.8': '1304da90a7f0c32af36ac95eea3b93ad3c6bd5f8',
    'v0.3.11': 'b528b928b33d87112933d8113d838207cc398f1c',
    'v0.3.13': 'cc722edc6bdc54d3970ed6632dd33d8c67f4f67c',
    'v0.3.14': '429729652a37f4b84f8eea8c2d978bde38a8ae2d',
  },
  'agent-bot': {
    'v0.10.21': '9bef50a384c07e1d34cfc016463e5e65055fc706',
    'v0.10.26': '21ba24620878cf7e65092df6f136a8f465fd984d',
    'v0.10.37': 'fc10f70588428ab0f7434776a643006b4237854d',
    'v0.10.46': 'cbf361ddf23738145a695348b131ca2253c66ddc',
    'v0.10.50': 'a3783128bc51a0a2d66de5cb3638b624b74780b6',
    'v0.10.51': 'db6ed2dccd8a490e400a4220e916196a7922eb37',
    'v0.10.52': '633097d34942298cc59bfd4b3474a06fcab39c6f',
  },
};
const REPOS = { 'agent-comms': 'qwts/agent-comms', 'agent-bot': 'qwts/agent-bot-identity' };

/** Writer → reader pairs that stand for the published tuples (see the matrix). */
export const DEFAULT_PAIRS = [
  ['agent-bot', 'v0.10.51', 'v0.10.50'], // main → 0.1.60
  ['agent-bot', 'v0.10.50', 'v0.10.37'], // 0.1.60 → 0.1.42…0.1.48
  ['agent-bot', 'v0.10.50', 'v0.10.21'], // 0.1.60 → 0.1.20
  ['agent-bot', 'v0.10.26', 'v0.10.21'], // 0.1.25 → 0.1.20: the `sandbox` field
  ['agent-comms', 'v0.3.14', 'v0.3.13'], // 0.1.39+ → 0.1.35
  ['agent-comms', 'v0.3.14', 'v0.3.11'], // 0.1.39+ → 0.1.25…0.1.30
  ['agent-comms', 'v0.3.14', 'v0.3.8'], // 0.1.39+ → 0.1.20
];

const sha256 = (data) => createHash('sha256').update(data).digest('hex');

/** The environment an engine runs with: everything under `home`, nothing real. */
export function scratchEnv(home) {
  const state = path.join(home, '.local', 'state');
  return {
    PATH: process.env.PATH,
    HOME: home,
    TMPDIR: path.join(home, 'tmp'),
    XDG_STATE_HOME: state,
    XDG_CONFIG_HOME: path.join(home, '.config'),
    XDG_DATA_HOME: path.join(home, '.local', 'share'),
    XDG_CACHE_HOME: path.join(home, '.cache'),
    AGENT_BOT_SOULS_HOME: path.join(home, 'souls'),
    AGENT_COMMS_SHARED_DIR: path.join(home, 'comms'),
    AGENT_COMMS_BROKER_STATE_DIR: path.join(state, 'agent-comms-broker'),
    AGENT_COMMS_CLIENT_STATE_DIR: path.join(state, 'agent-comms'),
    AGENT_COMMS_LOG_DIR: path.join(home, 'logs'),
    AGENT_COMMS_NO_KEYCHAIN: '1',
    // GeniusBar's own names (src-tauri/src/bridge.rs HOST_ENV).
    AGENT_COMMS_SERVICE_LABEL: 'app.geniusbar.broker',
    AGENT_COMMS_CREDENTIAL_NAME: 'app.geniusbar.principal',
    AGENT_BOT_SERVICE_LABEL: 'app.geniusbar.agent-bot',
    AGENT_BOT_KEYD_SERVICE_LABEL: 'app.geniusbar.keyd',
    AGENT_BOT_EXECUTOR: '1',
  };
}

export function scratchHome() {
  // A Unix socket path is capped at 104 bytes on macOS, and the broker's
  // lives under the HOME; the runner's $TMPDIR alone is longer than that,
  // so the scratch HOME goes under /tmp where it exists.
  const base = existsSync('/tmp') ? '/tmp' : tmpdir();
  const home = mkdtempSync(path.join(base, 'gbc-'));
  for (const dir of ['tmp', 'logs', 'souls']) mkdirSync(path.join(home, dir), { recursive: true, mode: 0o700 });
  return home;
}

/** Every regular file below `dir` with its SHA-256, locks and sockets left out. */
export function digestTree(dir, { skip = /(^|\/)[^/]*\.lock$|\.sock$|(^|\/)logs\//, } = {}) {
  const out = {};
  const walk = (current) => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const file = path.join(current, entry.name);
      const rel = path.relative(dir, file);
      if (skip.test(rel)) continue;
      if (entry.isDirectory()) walk(file);
      else if (entry.isFile()) out[rel] = sha256(readFileSync(file));
    }
  };
  if (existsSync(dir) && statSync(dir).isDirectory()) walk(dir);
  return out;
}

export function treeDiff(before, after) {
  const changed = Object.keys(after).filter((k) => k in before && before[k] !== after[k]);
  const added = Object.keys(after).filter((k) => !(k in before));
  const removed = Object.keys(before).filter((k) => !(k in after));
  return { changed, added, removed };
}

export function run(args, env, { input } = {}) {
  return new Promise((resolve) => {
    const child = execFile(process.execPath, args, { env, maxBuffer: 16 * 1024 * 1024 }, (error, stdout, stderr) => {
      let json = null;
      try { json = JSON.parse(stdout); } catch { /* not JSON */ }
      resolve({ exit: error?.code ?? 0, stdout: String(stdout), stderr: String(stderr), json });
    });
    if (input !== undefined) child.stdin.end(input);
  });
}

export function engineDir(cache, name, tag, remotes = {}) {
  const ref = PINS[name]?.[tag];
  if (!ref) throw new Error(`${name} ${tag} is not a pin this script knows`);
  return fetchComponent(name, { repo: REPOS[name], tag, ref }, {
    resources: path.join(cache, tag),
    ...(remotes[name] ? { remote: remotes[name] } : {}),
  });
}

const bot = (engine) => path.join(engine, 'agent-bot.mjs');
const comms = (engine) => path.join(engine, 'bin', 'agent-comms.mjs');

/**
 * agent-bot pair: the newer engine writes a soul (census row, revision
 * chain, cold wake, `.soul-state`); the older reads it, and then writes
 * once as the daemon would at a launch.
 */
export async function checkBotPair(newer, older, { keep = false } = {}) {
  const home = scratchHome();
  const env = scratchEnv(home);
  try {
    const written = await run([DRIVER, 'write', newer], env);
    if (written.exit !== 0 || !written.json) throw new Error(`writer failed: ${written.stderr}`);
    const { id } = written.json;
    const before = digestTree(home);
    const reads = {
      populationShow: await run([bot(older), 'population', 'show', id, '--json'], env),
      // Every revision command prints JSON; `--json` as a spelling came later.
      revisionHistory: await run([bot(older), 'soul', 'revision', 'history', id], env),
      soulDir: await run([bot(older), 'soul', 'dir', id], env),
      driver: await run([DRIVER, 'read', older, id], env),
    };
    const afterReads = treeDiff(before, digestTree(home));
    const touch = await run([DRIVER, 'touch', older, id], env);
    const afterTouch = treeDiff(before, digestTree(home));
    const soulState = Object.keys(afterTouch.changed).concat(afterTouch.removed).filter((f) => f.includes('.soul-state'));
    const dropped = touch.json?.dropped ?? null;
    const cli = Object.fromEntries(Object.entries(reads).filter(([k]) => k !== 'driver')
      .map(([k, r]) => [k, { exit: r.exit, error: r.exit === 0 ? null : (r.json?.error?.message ?? r.json?.message ?? r.stderr.trim().split('\n').at(-1)) }]));
    const probes = reads.driver.json ?? { error: reads.driver.stderr.trim() };
    const readFailures = Object.entries(probes).filter(([, v]) => v && typeof v === 'object' && v.ok === false).map(([k, v]) => `${k}: ${v.error}`);
    const verdict = touch.exit !== 0 ? 'refused-write'
      : dropped?.length ? 'silent-loss'
        : readFailures.length || Object.values(cli).some((c) => c.exit !== 0) ? 'degraded' : 'supported';
    return {
      component: 'agent-bot', writer: written.json.engineVersion, reader: probes.engineVersion ?? null, id,
      rowKeys: Object.keys(written.json.row), written: written.json.written,
      cli, readFailures, filesChangedByReads: afterReads.changed.concat(afterReads.removed),
      touch: touch.exit === 0 ? { dropped, changed: touch.json.changed } : { refused: touch.stderr.trim().split('\n').at(-1) },
      soulStateChangedByTouch: soulState, verdict, home: keep ? home : null,
    };
  } finally {
    if (!keep) rmSync(home, { recursive: true, force: true });
  }
}

/** Starts `broker run --single-account` and resolves once it answers, or with its exit. */
export function startBroker(engine, env, { timeoutMs = 15_000 } = {}) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [comms(engine), 'broker', 'run', '--single-account'], { env, stdio: ['ignore', 'pipe', 'pipe'] });
    let stderr = '';
    let settled = false;
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    const settle = (value) => { if (!settled) { settled = true; resolve(value); } };
    child.on('exit', (code, signal) => settle({ started: false, exit: code ?? signal, stderr, child }));
    const stop = () => new Promise((done) => {
      if (child.exitCode !== null || child.signalCode !== null) return done();
      child.once('exit', () => done());
      child.kill('SIGTERM');
    });
    const deadline = Date.now() + timeoutMs;
    const poll = async () => {
      if (settled) return;
      const answer = await run([comms(engine), 'broker', 'pairings'], env);
      if (answer.exit === 0) return settle({ started: true, stop, stderr: () => stderr, child });
      if (Date.now() > deadline) { await stop(); return settle({ started: false, exit: 'timeout', stderr, child }); }
      setTimeout(poll, 200);
    };
    setTimeout(poll, 200);
  });
}

// Two souls with well-formed Agent IDs (agent-bot's `agent_<uuid>` shape).
const ALICE = 'agent_1f3c6a0e-5b2d-4c8e-9a71-0000000000a1';
const BOB = 'agent_1f3c6a0e-5b2d-4c8e-9a71-0000000000b2';

const RECORD_TYPES = (log) => log.split('\n').filter(Boolean).map((line) => JSON.parse(line).t);

/**
 * agent-comms pair: the newer broker records pairing, two souls, a message,
 * an ack and a principal; the older broker replays that log. Then one
 * record the older reader does not know is appended, and finally one no
 * released reader knows, to see what each does with a future record.
 */
export async function checkCommsPair(newer, older, { keep = false } = {}) {
  const home = scratchHome();
  const env = scratchEnv(home);
  const alice = { ...env, QWTS_AGENT_ID: ALICE };
  const bobEnv = { ...env, QWTS_AGENT_ID: BOB };
  const logFile = path.join(env.AGENT_COMMS_BROKER_STATE_DIR, 'events.jsonl');
  const steps = [];
  const must = async (name, promise) => {
    const r = await promise;
    steps.push({ name, exit: r.exit });
    if (r.exit !== 0) throw new Error(`${name} failed: ${r.stderr || r.stdout}`);
    return r.json;
  };
  try {
    const writer = await startBroker(newer, env);
    if (!writer.started) throw new Error(`newer broker did not start: ${writer.stderr}`);
    try {
      const paired = await must('account pair', run([comms(newer), 'account', 'pair'], alice));
      await must('broker approve', run([comms(newer), 'broker', 'approve', paired.code], env));
      await must('join alice', run([comms(newer), 'join', '--name', 'alice', '--harness', 'claude'], alice));
      await must('join bob', run([comms(newer), 'join', '--name', 'bob', '--harness', 'codex'], bobEnv));
      await must('send', run([comms(newer), 'send', BOB, '--body', 'hello from the compatibility check'], alice));
      const inbox = await must('inbox read', run([comms(newer), 'inbox', 'read'], bobEnv));
      const ids = (inbox.messages ?? inbox).map?.((m) => m.id).filter(Boolean) ?? [];
      if (ids.length) await must('inbox ack', run([comms(newer), 'inbox', 'ack', ...ids], bobEnv));
      const principal = await must('principal pair', run([comms(newer), 'principal', 'pair', '--name', 'GeniusBar'], env));
      await must('principal approve', run([comms(newer), 'admin', 'principal-approve', principal.code], env));
    } finally {
      await writer.stop();
    }
    const log = readFileSync(logFile);
    const types = RECORD_TYPES(log.toString('utf8'));

    const replay = async (engine) => {
      const broker = await startBroker(engine, env);
      if (!broker.started) return { started: false, diagnostic: broker.stderr.trim().split('\n').filter((l) => /error|unknown|corrupt/i.test(l)).at(-1) ?? broker.stderr.trim() };
      try {
        const peers = await run([comms(engine), 'peers'], alice);
        const pairings = await run([comms(engine), 'broker', 'pairings'], env);
        return { started: true, peers: peers.json?.peers?.length ?? peers.json?.length ?? null, pairings: pairings.json?.pairings?.length ?? pairings.json?.length ?? null };
      } finally { await broker.stop(); }
    };
    const olderReplay = await replay(older);
    const afterOlder = readFileSync(logFile);

    // A record the older release cannot know (launch-progress, agent-comms
    // v0.3.13), shaped as lib/broker/launch.mjs writes it.
    const progress = JSON.stringify({ t: 'launch-progress', requestId: 'launch_compat', account: ALICE, stage: 'installing', at: new Date('2026-10-07T12:00:00Z').toISOString() });
    writeFileSync(logFile, Buffer.concat([log, Buffer.from(`${progress}\n`)]));
    const withProgress = readFileSync(logFile);
    const olderProgress = await replay(older);
    const olderProgressBytes = readFileSync(logFile).equals(withProgress);
    const newerProgress = await replay(newer);

    // A record no released broker knows: what the pinned reader does with
    // the next format change (agent-comms #122 retention is the candidate).
    const future = JSON.stringify({ t: 'mailbox-checkpoint', seq: 99, at: new Date('2026-10-07T12:00:00Z').toISOString() });
    writeFileSync(logFile, Buffer.concat([log, Buffer.from(`${future}\n`)]));
    const withFuture = readFileSync(logFile);
    const newerFuture = await replay(newer);
    const newerFutureBytes = readFileSync(logFile).equals(withFuture);

    const version = (engine) => JSON.parse(readFileSync(path.join(engine, 'package.json'), 'utf8')).version;
    return {
      component: 'agent-comms', writer: version(newer), reader: version(older), recordTypes: [...new Set(types)], records: types.length,
      olderReplay: { ...olderReplay, bytesUnchanged: afterOlder.equals(log) },
      olderWithLaunchProgress: { ...olderProgress, bytesUnchanged: olderProgressBytes },
      newerWithLaunchProgress: newerProgress,
      newerWithFutureRecord: { ...newerFuture, bytesUnchanged: newerFutureBytes },
      verdict: olderReplay.started && afterOlder.equals(log) ? 'supported' : 'refused',
      home: keep ? home : null,
    };
  } finally {
    if (!keep) rmSync(home, { recursive: true, force: true });
  }
}

/**
 * Copies a scratch HOME into `dest` as a relocatable fixture: text files
 * get `__HOME__` for the scratch path; sockets, locks, logs and the
 * scratch tmp are left out.
 */
export function recordFixture(home, dest, manifest) {
  rmSync(dest, { recursive: true, force: true });
  // The broker's client credentials (pairing and principal secrets of the
  // throwaway broker) never leave the scratch HOME; the test needs none.
  const skip = /(^|\/)[^/]*\.lock$|\.sock$|^(logs|tmp|\.cache)(\/|$)|^\.local\/state\/agent-comms(\/|$)/;
  const copy = (from, to) => {
    for (const entry of readdirSync(from, { withFileTypes: true })) {
      const source = path.join(from, entry.name);
      const rel = path.relative(home, source);
      if (skip.test(rel)) continue;
      const target = path.join(to, entry.name);
      if (entry.isDirectory()) { mkdirSync(target, { recursive: true }); copy(source, target); }
      else if (entry.isFile()) {
        const bytes = readFileSync(source);
        const text = bytes.toString('utf8');
        writeFileSync(target, Buffer.from(text, 'utf8').equals(bytes) ? text.replaceAll(home, '__HOME__') : bytes);
      }
    }
  };
  mkdirSync(path.join(dest, 'home'), { recursive: true });
  copy(home, path.join(dest, 'home'));
  writeFileSync(path.join(dest, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
}

/**
 * Restores a recorded fixture into a fresh scratch HOME, with the private
 * modes the engines' custody checks expect (git keeps no 0600/0700).
 */
export function restoreFixture(fixture, home) {
  const from = path.join(fixture, 'home');
  cpSync(from, home, { recursive: true });
  const fix = (dir) => {
    chmodSync(dir, 0o700);
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const file = path.join(dir, entry.name);
      if (entry.isDirectory()) fix(file);
      else if (entry.isFile()) {
        chmodSync(file, 0o600);
        const bytes = readFileSync(file);
        const text = bytes.toString('utf8');
        if (Buffer.from(text, 'utf8').equals(bytes) && text.includes('__HOME__')) writeFileSync(file, text.replaceAll('__HOME__', home));
      }
    }
  };
  fix(home);
  return JSON.parse(readFileSync(path.join(fixture, 'manifest.json'), 'utf8'));
}

function parseArgs(argv) {
  const options = { json: false, pairs: [], record: null, engines: path.join(ROOT, '.cache', 'compat-engines'), remotes: {} };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--json') options.json = true;
    else if (arg === '--pair') options.pairs.push(argv[++i].split(':'));
    else if (arg === '--record') options.record = path.resolve(argv[++i]);
    else if (arg === '--engines') options.engines = path.resolve(argv[++i]);
    else if (arg === '--comms-remote') options.remotes['agent-comms'] = argv[++i];
    else if (arg === '--bot-remote') options.remotes['agent-bot'] = argv[++i];
    else throw new Error(`unknown argument ${arg}`);
  }
  return options;
}

function table(results) {
  const lines = ['| component | writer | reader | verdict | detail |', '| --- | --- | --- | --- | --- |'];
  for (const r of results) {
    const detail = r.component === 'agent-bot'
      ? [r.touch.dropped?.length ? `dropped ${r.touch.dropped.join(', ')}` : r.touch.refused ? `write refused: ${r.touch.refused}` : 'row intact',
        r.readFailures.length ? `read errors: ${r.readFailures.join('; ')}` : 'reads ok',
        r.filesChangedByReads.length ? `reads changed ${r.filesChangedByReads.join(', ')}` : 'reads wrote nothing',
        r.soulStateChangedByTouch.length ? `.soul-state changed ${r.soulStateChangedByTouch.join(', ')}` : '.soul-state untouched'].join('; ')
      : [`${r.records} records (${r.recordTypes.join(', ')})`,
        r.olderReplay.started ? `older replays, ${r.olderReplay.peers} peers` : `older refuses: ${r.olderReplay.diagnostic}`,
        r.olderWithLaunchProgress.started ? 'older accepts launch-progress' : `older + launch-progress: ${r.olderWithLaunchProgress.diagnostic}${r.olderWithLaunchProgress.bytesUnchanged ? ' (log unchanged)' : ' (LOG CHANGED)'}`,
        r.newerWithFutureRecord.started ? 'newer accepts future record' : `newer + future record: ${r.newerWithFutureRecord.diagnostic}${r.newerWithFutureRecord.bytesUnchanged ? ' (log unchanged)' : ' (LOG CHANGED)'}`].join('; ');
    lines.push(`| ${r.component} | ${r.writer} | ${r.reader} | ${r.verdict} | ${detail} |`);
  }
  return lines.join('\n');
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const pairs = options.pairs.length ? options.pairs : DEFAULT_PAIRS;
  const results = [];
  for (const [name, newerTag, olderTag] of pairs) {
    const newer = engineDir(options.engines, name, newerTag, options.remotes);
    const older = engineDir(options.engines, name, olderTag, options.remotes);
    process.stderr.write(`${name} ${newerTag} -> ${olderTag}\n`);
    results.push(name === 'agent-bot' ? await checkBotPair(newer, older) : await checkCommsPair(newer, older));
  }
  if (options.record) {
    const botTag = 'v0.10.51';
    const commsTag = 'v0.3.14';
    const home = scratchHome();
    try {
      const env = scratchEnv(home);
      const engine = engineDir(options.engines, 'agent-bot', botTag, options.remotes);
      const written = await run([DRIVER, 'write', engine], env);
      if (written.exit !== 0) throw new Error(`fixture writer failed: ${written.stderr}`);
      const brokerEngine = engineDir(options.engines, 'agent-comms', commsTag, options.remotes);
      const alice = { ...env, QWTS_AGENT_ID: ALICE };
      const bobEnv = { ...env, QWTS_AGENT_ID: BOB };
      const broker = await startBroker(brokerEngine, env);
      if (!broker.started) throw new Error(`fixture broker did not start: ${broker.stderr}`);
      try {
        const paired = await run([comms(brokerEngine), 'account', 'pair'], alice);
        await run([comms(brokerEngine), 'broker', 'approve', paired.json.code], env);
        await run([comms(brokerEngine), 'join', '--name', 'alice', '--harness', 'claude'], alice);
        await run([comms(brokerEngine), 'join', '--name', 'bob', '--harness', 'codex'], bobEnv);
        await run([comms(brokerEngine), 'send', BOB, '--body', 'hello from the compatibility fixture'], alice);
        const inbox = await run([comms(brokerEngine), 'inbox', 'read'], bobEnv);
        const ids = (inbox.json?.messages ?? inbox.json ?? []).map?.((m) => m.id).filter(Boolean) ?? [];
        if (ids.length) await run([comms(brokerEngine), 'inbox', 'ack', ...ids], bobEnv);
        const principal = await run([comms(brokerEngine), 'principal', 'pair', '--name', 'GeniusBar'], env);
        await run([comms(brokerEngine), 'admin', 'principal-approve', principal.json.code], env);
      } finally { await broker.stop(); }
      recordFixture(home, options.record, {
        writtenBy: { 'agent-bot': `${botTag}@${PINS['agent-bot'][botTag]}`, 'agent-comms': `${commsTag}@${PINS['agent-comms'][commsTag]}` },
        agentId: written.json.id, revisions: written.json.revisions, rowKeys: Object.keys(written.json.row),
        brokerRecordTypes: [...new Set(RECORD_TYPES(readFileSync(path.join(env.AGENT_COMMS_BROKER_STATE_DIR, 'events.jsonl'), 'utf8')))],
        recordedAt: new Date().toISOString(),
      });
      process.stderr.write(`fixture recorded at ${options.record}\n`);
    } finally { rmSync(home, { recursive: true, force: true }); }
  }
  process.stdout.write(options.json ? `${JSON.stringify(results, null, 2)}\n` : `${table(results)}\n`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) await main();
