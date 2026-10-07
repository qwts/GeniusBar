#!/usr/bin/env node
// Chooses how a package is signed (ADR-0004 decision 5), ported from
// cartograph: the full secret set means a signed build, none means an
// explicitly unsigned build, and a partial set fails so a missing secret
// never silently ships an unsigned app. macOS takes the five Apple secrets
// (Developer ID signing and notarization); Windows (ADR-0046 decision 8)
// takes the six Azure ones, which become Tauri's `signCommand` running
// artifact-signing-cli (the Azure Trusted Signing client, which reads the
// tenant, client and secret from its environment).
//
// usage: node scripts/signing-secrets.mjs >> "$GITHUB_OUTPUT"
//        node scripts/signing-secrets.mjs windows OUT.json >> "$GITHUB_OUTPUT"
// The Windows form also writes a `tauri build --config` file: the sign
// command when signed, an empty object otherwise.

import { writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

export const SIGNING_SECRET_NAMES = Object.freeze([
  'CSC_LINK',
  'CSC_KEY_PASSWORD',
  'APPLE_API_KEY',
  'APPLE_API_KEY_ID',
  'APPLE_API_ISSUER',
]);

export const WINDOWS_SIGNING_SECRET_NAMES = Object.freeze([
  'AZURE_TENANT_ID',
  'AZURE_CLIENT_ID',
  'AZURE_CLIENT_SECRET',
  'AZURE_SIGNING_ENDPOINT',
  'AZURE_SIGNING_ACCOUNT',
  'AZURE_SIGNING_PROFILE',
]);

function modeFor(env, names, label) {
  const present = names.filter((name) => String(env[name] ?? '').length > 0);

  if (present.length === 0) {
    return { mode: 'unsigned-dev', signed: false };
  }

  if (present.length !== names.length) {
    const missing = names.filter((name) => !present.includes(name));
    throw new Error(`partial ${label} signing credential set; missing: ${missing.join(', ')}`);
  }

  return { mode: 'signed', signed: true };
}

export function signingMode(env = process.env) {
  return modeFor(env, SIGNING_SECRET_NAMES, 'Apple');
}

/**
 * The Windows signing mode, with the Tauri configuration that signs when
 * the Azure set is complete. The endpoint, account and profile are spliced
 * into a command line Tauri splits on whitespace, so each is checked for
 * the shape Azure gives it before it goes in.
 */
export function windowsSigningMode(env = process.env) {
  const result = modeFor(env, WINDOWS_SIGNING_SECRET_NAMES, 'Azure');
  if (!result.signed) return { ...result, config: {} };
  const endpoint = String(env.AZURE_SIGNING_ENDPOINT).trim();
  let url;
  try {
    url = new URL(endpoint);
  } catch {
    throw new Error('AZURE_SIGNING_ENDPOINT is not a URL');
  }
  if (url.protocol !== 'https:' || /\s/.test(endpoint)) throw new Error('AZURE_SIGNING_ENDPOINT must be an https URL');
  for (const name of ['AZURE_SIGNING_ACCOUNT', 'AZURE_SIGNING_PROFILE']) {
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(String(env[name]).trim())) throw new Error(`${name} is not an Azure resource name`);
  }
  const account = String(env.AZURE_SIGNING_ACCOUNT).trim();
  const profile = String(env.AZURE_SIGNING_PROFILE).trim();
  return {
    ...result,
    config: {
      bundle: {
        windows: {
          signCommand: `artifact-signing-cli -e ${endpoint} -a ${account} -c ${profile} -d GeniusBar %1`,
        },
      },
    },
  };
}

function main([platform, out]) {
  try {
    let result;
    if (platform === 'windows') {
      if (!out) throw new Error('usage: signing-secrets.mjs windows OUT.json');
      result = windowsSigningMode();
      writeFileSync(out, `${JSON.stringify(result.config, null, 2)}\n`);
    } else if (platform) {
      throw new Error('usage: signing-secrets.mjs [windows OUT.json]');
    } else {
      result = signingMode();
    }
    process.stdout.write(`mode=${result.mode}\nsigned=${result.signed}\n`);
  } catch (error) {
    process.stderr.write(`::error::${error.message}\n`);
    process.exitCode = 1;
  }
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2));
}
