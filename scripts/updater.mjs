#!/usr/bin/env node
// Release configuration for the Tauri updater (ADR-0004 decisions 6 and 8).
// The updater's public key and endpoint are repository variables, not code,
// so the repository can move without a code change; they reach the app as a
// generated `tauri build --config` file. With neither set the updater is off
// and the app runs without it. Only a Developer ID signed build produces
// updater artifacts: an unsigned build is never published as an update.
//
// GENIUSBAR_UPDATER_INSECURE=1 is the local-test escape hatch (#34): on an
// unsigned build it allows an http:// endpoint and archive URL and emits
// updater artifacts, so a dev build can update against a local latest.json.
// A signed build with it set fails rather than ship an insecure updater.
//
// usage:
//   SIGNED=true|false node scripts/updater.mjs config OUT.json >> "$GITHUB_OUTPUT"
//   node scripts/updater.mjs manifest VERSION URL SIGNATURE_FILE \
//     [--windows URL SIGNATURE_FILE] > latest.json
// The Windows entry (ADR-0046 decision 8) is the signed NSIS installer and
// its signature, in the same manifest, so a Windows install updates from
// the same feed; it is present only when a signed Windows build exists.

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

// The Windows installer serves the one Windows build there is (x64).
export const WINDOWS_MANIFEST_PLATFORMS = Object.freeze(['windows-x86_64']);

function checkPubkey(pubkey) {
  // `tauri signer generate` prints the public key as base64 of a minisign
  // key file. Refuse the private key, which has the same shape.
  const text = Buffer.from(pubkey, 'base64').toString('utf8');
  if (!text.startsWith('untrusted comment:') || /secret key/i.test(text)) {
    throw new Error('GENIUSBAR_UPDATER_PUBKEY is not a Tauri updater public key');
  }
}

function checkEndpoint(name, value, insecure = false) {
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`${name} is not a URL`);
  }
  // The updater refuses plain HTTP unless the build opted into it.
  if (url.protocol !== 'https:' && !(insecure && url.protocol === 'http:')) {
    throw new Error(`${name} must be an https URL`);
  }
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
  const insecure = env.GENIUSBAR_UPDATER_INSECURE === '1';
  if (insecure && signed) {
    throw new Error('GENIUSBAR_UPDATER_INSECURE is for unsigned local builds only');
  }
  checkPubkey(pubkey);
  checkEndpoint('GENIUSBAR_UPDATER_ENDPOINT', endpoint, insecure);
  // An insecure local build produces artifacts too: the test update is a
  // tarball and signature exactly like a release's, signed with a throwaway
  // TAURI_SIGNING_PRIVATE_KEY.
  const artifacts = signed || insecure;
  if (artifacts && !String(env.TAURI_SIGNING_PRIVATE_KEY ?? '').length) {
    throw new Error('a build that produces updater artifacts needs TAURI_SIGNING_PRIVATE_KEY');
  }
  return {
    enabled: true,
    artifacts,
    config: {
      bundle: { createUpdaterArtifacts: artifacts },
      plugins: {
        updater: {
          pubkey,
          endpoints: [endpoint],
          ...(insecure ? { dangerousInsecureTransportProtocol: true } : {}),
        },
      },
    },
  };
}

function manifestEntry(what, url, signature, insecure) {
  checkEndpoint(`the ${what} URL`, url, insecure);
  if (!signature.trim()) throw new Error(`the ${what} signature is empty`);
  return { signature: signature.trim(), url };
}

export function updaterManifest({ version, url, signature, windows = null, notes = '', pubDate = new Date() },
  { insecure = false } = {}) {
  if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(version)) throw new Error(`${version} is not a semver version`);
  const entry = manifestEntry('update', url, signature, insecure);
  const platforms = Object.fromEntries(MANIFEST_PLATFORMS.map((key) => [key, entry]));
  if (windows) {
    const installer = manifestEntry('Windows update', windows.url, windows.signature, insecure);
    for (const key of WINDOWS_MANIFEST_PLATFORMS) platforms[key] = installer;
  }
  return {
    version,
    notes,
    pub_date: pubDate.toISOString(),
    platforms,
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
    const [version, url, signatureFile, ...rest] = args;
    const usage = 'usage: updater.mjs manifest VERSION URL SIGNATURE_FILE [--windows URL SIGNATURE_FILE]';
    if (!signatureFile) throw new Error(usage);
    let windows = null;
    if (rest.length) {
      const [flag, windowsUrl, windowsSignatureFile, ...extra] = rest;
      if (flag !== '--windows' || !windowsSignatureFile || extra.length) throw new Error(usage);
      windows = { url: windowsUrl, signature: readFileSync(windowsSignatureFile, 'utf8') };
    }
    const manifest = updaterManifest({ version, url, signature: readFileSync(signatureFile, 'utf8'), windows },
      { insecure: process.env.GENIUSBAR_UPDATER_INSECURE === '1' });
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
