#!/usr/bin/env node
// GeniusBar's bridge (ADR-0004 decision 3): runs in the bundled Node and
// answers the shell's newline-delimited JSON requests with the bundled
// agent-comms principal client. Requests are {id, method, params}; replies
// are {id, ok: true, result} or {id, ok: false, error: {code, message}}.
//
// The principal credential stays inside this process: the client never
// exposes its secret, and only results and error codes go back to the shell.
//
// usage: node bridge.mjs AGENT_COMMS_DIR

import { createInterface } from 'node:readline';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

// The only operations the web view can reach. Each takes plain data and
// rebuilds the argument object, so no caller field passes through unchecked.
export const METHODS = {
  census: (client) => client.census(),
  send: (client, { to, body, key, kind, refs, correlation, replyTo }) =>
    client.send({ to, body, key, kind, refs, correlation, replyTo }),
  inbox: (client, { after, limit }) => client.inbox({ after, limit }),
  ack: (client, { ids }) => client.ack(ids),
  // `brief` (#120) goes through only as a string; older agent-comms ignore it.
  launch: (client, { account, soul, package: packagePath, harness, name, comms, model, brief }) =>
    client.launch({ account, soul, package: packagePath, harness, name, comms, ...(model === undefined ? {} : { model }),
      ...(typeof brief === 'string' ? { brief } : {}) }),
  launchStatus: (client, { requestId }) => client.launchStatus(requestId),
};

// A client is rebuilt after these, so pairing or rotating the credential
// takes effect without restarting the app.
const RELOAD = new Set(['credential-invalid', 'keychain-read-failed', 'unauthenticated', 'not-approved']);

export function createBridge({ loadClient, write }) {
  let client = null;
  const reply = (message) => write(`${JSON.stringify(message)}\n`);
  return async function handle(line) {
    let request;
    try {
      request = JSON.parse(line);
    } catch {
      return reply({ id: null, ok: false, error: { code: 'bad-request', message: 'request is not JSON' } });
    }
    const id = Number.isSafeInteger(request?.id) ? request.id : null;
    const method = Object.hasOwn(METHODS, request?.method) ? METHODS[request.method] : null;
    if (id === null || !method) {
      return reply({ id, ok: false, error: { code: 'bad-request', message: 'unknown request' } });
    }
    const params = request.params && typeof request.params === 'object' && !Array.isArray(request.params)
      ? request.params : {};
    try {
      client ??= loadClient();
      return reply({ id, ok: true, result: await method(client, params) });
    } catch (error) {
      const code = typeof error?.code === 'string' ? error.code : 'bridge-error';
      if (RELOAD.has(code)) client = null;
      return reply({ id, ok: false, error: { code, message: String(error?.message ?? error) } });
    }
  };
}

async function main() {
  const [commsDir] = process.argv.slice(2);
  if (!commsDir) {
    process.stderr.write('usage: bridge.mjs AGENT_COMMS_DIR\n');
    process.exit(2);
  }
  const url = pathToFileURL(path.join(commsDir, 'lib', 'principal-client.mjs'));
  const { createPrincipalClient } = await import(url);
  const handle = createBridge({
    loadClient: () => createPrincipalClient(),
    write: (text) => process.stdout.write(text),
  });
  // Requests run concurrently; replies carry the request id.
  createInterface({ input: process.stdin, crlfDelay: Infinity }).on('line', (line) => { handle(line); });
  // The shell closes stdin to stop the bridge.
  process.stdin.on('end', () => process.exit(0));
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) await main();
