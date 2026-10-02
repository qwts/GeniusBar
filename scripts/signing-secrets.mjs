#!/usr/bin/env node
// Chooses how a macOS package is signed (ADR-0004 decision 5), ported from
// cartograph: all five secrets mean Developer ID signing and notarization,
// none means an explicitly unsigned (ad-hoc) build, and a partial set fails
// so a missing secret never silently ships an unsigned app.
//
// usage: node scripts/signing-secrets.mjs >> "$GITHUB_OUTPUT"

import { pathToFileURL } from 'node:url';

export const SIGNING_SECRET_NAMES = Object.freeze([
  'CSC_LINK',
  'CSC_KEY_PASSWORD',
  'APPLE_API_KEY',
  'APPLE_API_KEY_ID',
  'APPLE_API_ISSUER',
]);

export function signingMode(env = process.env) {
  const present = SIGNING_SECRET_NAMES.filter((name) => String(env[name] ?? '').length > 0);

  if (present.length === 0) {
    return { mode: 'unsigned-dev', signed: false };
  }

  if (present.length !== SIGNING_SECRET_NAMES.length) {
    const missing = SIGNING_SECRET_NAMES.filter((name) => !present.includes(name));
    throw new Error(`partial Apple signing credential set; missing: ${missing.join(', ')}`);
  }

  return { mode: 'signed', signed: true };
}

function main() {
  try {
    const result = signingMode();
    process.stdout.write(`mode=${result.mode}\nsigned=${result.signed}\n`);
  } catch (error) {
    process.stderr.write(`::error::${error.message}\n`);
    process.exitCode = 1;
  }
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
