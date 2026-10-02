import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
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
