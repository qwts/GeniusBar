#!/usr/bin/env node
// The souls GeniusBar ships: Starter (R4), the package a first launch uses,
// and GeniusBar (#73), the built-in lead that configures the fleet. Each
// revision must match its content, so after editing a package run
//   node scripts/starter-soul.mjs pin
// which rewrites every bundled soul.json's revision with the bundled agent-bot.
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
export const STARTER = path.join(ROOT, 'souls', 'starter.soul');
export const GENIUSBAR = path.join(ROOT, 'souls', 'geniusbar.soul');
export const BUNDLED_SOULS = [STARTER, GENIUSBAR];
const SOUL_PACKAGE = path.join(ROOT, 'src-tauri', 'resources', 'components', 'agent-bot', 'soul-package.mjs');

/** agent-bot's own package module, so the revision rules are never copied. */
export function soulPackage() {
  return import(pathToFileURL(SOUL_PACKAGE).href);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  if (process.argv[2] !== 'pin') {
    process.stderr.write('usage: starter-soul.mjs pin\n');
    process.exit(2);
  }
  const { computePackageRevision } = await soulPackage();
  for (const soul of BUNDLED_SOULS) {
    const file = path.join(soul, 'soul.json');
    const manifest = JSON.parse(readFileSync(file, 'utf8'));
    manifest.revision = computePackageRevision(soul);
    writeFileSync(file, `${JSON.stringify(manifest, null, 2)}\n`);
    process.stdout.write(`${path.basename(soul)} ${manifest.revision}\n`);
  }
}
