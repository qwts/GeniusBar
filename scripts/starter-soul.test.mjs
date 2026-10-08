import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { STARTER, soulPackage } from './starter-soul.mjs';

test('the starter soul is a valid package whose revision is pinned', async () => {
  const { validateSoulPackage } = await soulPackage();
  assert.equal(validateSoulPackage(STARTER).formatVersion, 1);
});

test('the starter soul names the harnesses it prefers', () => {
  const manifest = JSON.parse(readFileSync(path.join(STARTER, 'soul.json'), 'utf8'));
  assert.ok(manifest.preferredHarnesses.length > 0);
});

test('the starter package is Genius, remembers Starter, and maintains its guide (#287)', () => {
  const manifest = JSON.parse(readFileSync(path.join(STARTER, 'soul.json'), 'utf8'));
  assert.equal(manifest.name, 'Genius');
  assert.deepEqual(manifest.previousNames, ['Starter']);
  assert.deepEqual(manifest.maintained, ['docs/guide/']);
  assert.equal(manifest.displaySeed, 'starter');
  assert.deepEqual(manifest.preferredHarnesses, ['claude', 'codex']);
  const brief = readFileSync(path.join(STARTER, 'AGENTS.md'), 'utf8');
  assert.match(brief, /^# Genius/);
  assert.match(brief, /docs\/guide\/index\.json/);
  assert.match(brief, /[Nn]ever claim an action happened/);
  assert.match(brief, /[Kk]nowing how never grants permission/);
  assert.ok(existsSync(path.join(STARTER, 'docs', 'guide', 'index.json')));
});
