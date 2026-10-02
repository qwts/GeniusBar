#!/usr/bin/env node
// The starter soul GeniusBar ships (R4): the package a first launch uses.
// Its revision must match the content, so after editing the package run
//   node scripts/starter-soul.mjs pin
// which rewrites soul.json's revision with the bundled agent-bot.
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
export const STARTER = path.join(ROOT, 'souls', 'starter.soul');
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
  const file = path.join(STARTER, 'soul.json');
  const manifest = JSON.parse(readFileSync(file, 'utf8'));
  manifest.revision = computePackageRevision(STARTER);
  writeFileSync(file, `${JSON.stringify(manifest, null, 2)}\n`);
  process.stdout.write(`${manifest.revision}\n`);
}
