#!/usr/bin/env node
// Release configuration for the Tauri updater (ADR-0004 decisions 6 and 8).
// The updater's public key and endpoint are repository variables, not code,
// so the repository can move without a code change; they reach the app as a
// generated `tauri build --config` file. With neither set the updater is off
// and the app runs without it. Only a Developer ID signed build produces
// updater artifacts: an unsigned build is never published as an update.
//
// usage:
//   SIGNED=true|false node scripts/updater.mjs config OUT.json >> "$GITHUB_OUTPUT"
//   node scripts/updater.mjs manifest VERSION URL SIGNATURE_FILE > latest.json

import { readFileSync, writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

// The universal bundle runs on both architectures, so one archive serves both
// keys. The updater looks up `{os}-{arch}-{installer}`, then `{os}-{arch}`.
export const MANIFEST_PLATFORMS = Object.freeze([
  'darwin-aarch64',
  'darwin-x86_64',
  'darwin-aarch64-app',
  'darwin-x86_64-app',
]);

function checkPubkey(pubkey) {
  // `tauri signer generate` prints the public key as base64 of a minisign
  // key file. Refuse the private key, which has the same shape.
  const text = Buffer.from(pubkey, 'base64').toString('utf8');
  if (!text.startsWith('untrusted comment:') || /secret key/i.test(text)) {
    throw new Error('GENIUSBAR_UPDATER_PUBKEY is not a Tauri updater public key');
  }
}

function checkHttps(name, value) {
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`${name} is not a URL`);
  }
  // The updater refuses plain HTTP unless told to be insecure.
  if (url.protocol !== 'https:') throw new Error(`${name} must be an https URL`);
}

export function updaterConfig(env = process.env, { signed = false } = {}) {
  const pubkey = String(env.GENIUSBAR_UPDATER_PUBKEY ?? '').trim();
  const endpoint = String(env.GENIUSBAR_UPDATER_ENDPOINT ?? '').trim();
  if (!pubkey && !endpoint) {
    return { enabled: false, artifacts: false, config: {} };
  }
  if (!pubkey || !endpoint) {
    const missing = pubkey ? 'GENIUSBAR_UPDATER_ENDPOINT' : 'GENIUSBAR_UPDATER_PUBKEY';
    throw new Error(`partial updater configuration; missing: ${missing}`);
  }
  checkPubkey(pubkey);
  checkHttps('GENIUSBAR_UPDATER_ENDPOINT', endpoint);
  const artifacts = signed;
  if (artifacts && !String(env.TAURI_SIGNING_PRIVATE_KEY ?? '').length) {
    throw new Error('a signed build with the updater enabled needs TAURI_SIGNING_PRIVATE_KEY');
  }
  return {
    enabled: true,
    artifacts,
    config: {
      bundle: { createUpdaterArtifacts: artifacts },
      plugins: { updater: { pubkey, endpoints: [endpoint] } },
    },
  };
}

export function updaterManifest({ version, url, signature, notes = '', pubDate = new Date() }) {
  if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(version)) throw new Error(`${version} is not a semver version`);
  checkHttps('the update URL', url);
  if (!signature.trim()) throw new Error('the update signature is empty');
  const entry = { signature: signature.trim(), url };
  return {
    version,
    notes,
    pub_date: pubDate.toISOString(),
    platforms: Object.fromEntries(MANIFEST_PLATFORMS.map((key) => [key, entry])),
  };
}

function main([command, ...args]) {
  if (command === 'config') {
    const [out] = args;
    if (!out) throw new Error('usage: updater.mjs config OUT.json');
    const result = updaterConfig(process.env, { signed: process.env.SIGNED === 'true' });
    writeFileSync(out, `${JSON.stringify(result.config, null, 2)}\n`);
    process.stdout.write(`enabled=${result.enabled}\nartifacts=${result.artifacts}\n`);
  } else if (command === 'manifest') {
    const [version, url, signatureFile] = args;
    if (!signatureFile) throw new Error('usage: updater.mjs manifest VERSION URL SIGNATURE_FILE');
    const manifest = updaterManifest({ version, url, signature: readFileSync(signatureFile, 'utf8') });
    process.stdout.write(`${JSON.stringify(manifest, null, 2)}\n`);
  } else {
    throw new Error('usage: updater.mjs config|manifest ...');
  }
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    main(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(`::error::${error.message}\n`);
    process.exitCode = 1;
  }
}
