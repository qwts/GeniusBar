#!/usr/bin/env node
// First-run setup (#9, ADR-0004 decision 4), run only when the owner asks.
// It uses the bundled agent-comms CLI to make sure a broker is answering,
// pair and approve this account, and pair and approve GeniusBar as a
// principal, then the bundled agent-bot to make sure an identity daemon is
// running and paired with the broker, and that agent-bot-keyd, which keeps
// souls' GitHub App keys (agent-bot-identity #397), runs beside it. Approval is the owner's authority,
// used here on the owner's click; the long-lived bridge never approves
// anything.
//
// Progress goes to stdout as JSON lines: {step, state, detail?}, then
// {done: true} or {done: false, code, message}.
//
// usage: node setup.mjs AGENT_COMMS_DIR AGENT_BOT_DIR

import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

export const PRINCIPAL_NAME = 'GeniusBar';
const BROKER_WAIT_MS = 15_000;
const DAEMON_WAIT_MS = 15_000;

/** The CLI prints an optional hint line, then one JSON document. */
export function parseOutput(text) {
  const start = text.indexOf('{');
  if (start < 0) return null;
  // The error form also echoes a plain message after the JSON.
  for (let end = text.lastIndexOf('}'); end > start; end = text.lastIndexOf('}', end - 1)) {
    try { return JSON.parse(text.slice(start, end + 1)); } catch { /* shorter */ }
  }
  return null;
}

/** agent-bot-keyd beside the bundled Node in GeniusBar.app/Contents/MacOS, if any. */
export function bundledKeyd(node = process.execPath) {
  const keyd = path.join(path.dirname(node), 'agent-bot-keyd');
  return existsSync(keyd) ? keyd : null;
}

export class SetupError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

function failed(result, fallback) {
  const error = result?.error;
  return new SetupError(error?.code ?? fallback, error?.message ?? `${fallback}`);
}

// `principal` asks the broker as GeniusBar's own principal, the credential the
// bridge will load (#56). The CLI's census is not that question: it answers
// as whichever principal the CLI's credential file holds, which on a Mac moved
// over from Homebrew is the owner's, not GeniusBar's.
export async function runSetup({ cli, bot, report, keyd = null, principal = () => cli(['census']), sleep = (ms) => new Promise((r) => setTimeout(r, ms)), now = Date.now }) {
  // 1. A broker. Use whichever one already answers on the shared socket;
  // install ours only when none does, so two brokers never compete. A
  // socket file proves nothing (a crashed broker leaves one), so ask the
  // broker itself; any answer other than unreachable stops setup rather
  // than reinstalling over a broker it cannot vouch for.
  report({ step: 'broker', state: 'running' });
  let probe = await cli(['broker', 'pairings']);
  if (probe?.error?.code === 'broker-unreachable') {
    const installed = await cli(['broker', 'install']);
    if (installed?.ok === false) throw failed(installed, 'broker-install-failed');
    const deadline = now() + BROKER_WAIT_MS;
    while (probe?.error?.code === 'broker-unreachable') {
      if (now() > deadline) throw new SetupError('broker-not-ready', 'the broker did not start');
      await sleep(250);
      probe = await cli(['broker', 'pairings']);
    }
  }
  if (!probe?.ok) throw failed(probe, 'broker-unavailable');
  report({ step: 'broker', state: 'done' });

  // 2. This account, paired and approved.
  report({ step: 'account', state: 'running' });
  let account = await cli(['account', 'status']);
  if (account?.error?.code === 'unpaired') {
    const paired = await cli(['account', 'pair']);
    if (!paired?.ok) throw failed(paired, 'account-pair-failed');
    account = { ok: true, account: paired.account, state: paired.state ?? 'pending', code: paired.code };
  }
  if (!account?.ok) throw failed(account, 'account-status-failed');
  if (account.state === 'pending') {
    const code = account.code ?? (await cli(['broker', 'pairings']))?.pairings
      ?.find((p) => p.account === account.account && p.state === 'pending')?.code;
    if (!code) throw new SetupError('account-code-missing', 'no pending pairing code for this account');
    const approved = await cli(['broker', 'approve', code]);
    if (approved?.state !== 'approved') throw failed(approved, 'account-approve-failed');
  } else if (account.state !== 'approved') {
    throw new SetupError('account-not-approved', `this account is ${account.state}`);
  }
  report({ step: 'account', state: 'done' });

  // 3. GeniusBar as a principal, paired and approved.
  report({ step: 'principal', state: 'running' });
  const census = await principal();
  if (!census?.ok) {
    const paired = await cli(['principal', 'pair', '--name', PRINCIPAL_NAME]);
    if (!paired?.ok || !paired.code) throw failed(paired, 'principal-pair-failed');
    const approved = await cli(['admin', 'principal-approve', paired.code]);
    if (approved?.state !== 'approved') throw failed(approved, 'principal-approve-failed');
  }
  report({ step: 'principal', state: 'done' });

  // 4. An identity daemon, paired with the broker so it can carry out
  // launches. A daemon that already runs (say, from a Homebrew agent-bot) is
  // used as it is; GeniusBar registers its own only when none runs. Pairing
  // comes first: a running daemon picks the credential up on its next retry.
  report({ step: 'daemon', state: 'running' });
  let daemon = await bot(['daemon', 'status', '--json']);
  if (!daemon?.comms?.paired) {
    const paired = await bot(['daemon', 'pair-comms', '--json']);
    if (!paired?.code && paired?.state !== 'approved') throw failed(paired, 'daemon-pair-failed');
    if (paired.state !== 'approved') {
      const approved = await cli(['broker', 'approve', paired.code]);
      if (approved?.state !== 'approved') throw failed(approved, 'daemon-approve-failed');
    }
  }
  if (!daemon?.running) {
    const installed = await bot(['daemon', 'install', '--json']);
    if (!installed?.label) throw failed(installed, 'daemon-install-failed');
    const deadline = now() + DAEMON_WAIT_MS;
    do {
      if (now() > deadline) throw new SetupError('daemon-not-ready', 'the identity daemon did not start');
      await sleep(250);
      daemon = await bot(['daemon', 'status', '--json']);
    } while (!daemon?.running);
  }
  // The key custodian GeniusBar ships. agent-bot owns its unit; a bundled
  // agent-bot without `keyd` leaves keys where they are, so it never fails
  // setup.
  if (keyd) {
    const installed = await bot(['keyd', 'install', '--bin', keyd, '--json']);
    report({ step: 'daemon', state: 'running', detail: installed?.label ? 'agent-bot-keyd is running' : 'agent-bot-keyd was not set up' });
  }
  report({ step: 'daemon', state: 'done' });
}

async function main() {
  const [commsDir, botDir] = process.argv.slice(2);
  if (!commsDir || !botDir) {
    process.stderr.write('usage: setup.mjs AGENT_COMMS_DIR AGENT_BOT_DIR\n');
    process.exit(2);
  }
  // The CLIs exit non-zero on errors but still print their JSON.
  const runner = (bin) => (args) => new Promise((resolve) => {
    execFile(process.execPath, [bin, ...args], { timeout: 30_000 }, (_error, stdout) => resolve(parseOutput(String(stdout))));
  });
  const cli = runner(path.join(commsDir, 'bin', 'agent-comms.mjs'));
  const bot = runner(path.join(botDir, 'agent-bot.mjs'));
  // The same load the bridge does: GeniusBar's credential name (from its
  // environment), the keychain on macOS. Any failure means not set up yet.
  const principal = async () => {
    try {
      const { createPrincipalClient } = await import(pathToFileURL(path.join(commsDir, 'lib', 'principal-client.mjs')).href);
      const census = await createPrincipalClient().census();
      return census?.ok === false ? census : { ok: true };
    } catch (error) {
      return { ok: false, error: { code: error?.code ?? 'principal-unavailable', message: String(error?.message ?? error) } };
    }
  };
  const write = (message) => process.stdout.write(`${JSON.stringify(message)}\n`);
  try {
    await runSetup({ cli, bot, principal, report: write, keyd: bundledKeyd() });
    write({ done: true });
  } catch (error) {
    write({ done: false, code: error.code ?? 'setup-failed', message: String(error.message ?? error) });
    process.exitCode = 1;
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) await main();
