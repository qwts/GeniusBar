import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { GENIUSBAR, soulPackage } from './starter-soul.mjs';

const manifest = () => JSON.parse(readFileSync(path.join(GENIUSBAR, 'soul.json'), 'utf8'));
const skills = () => readdirSync(path.join(GENIUSBAR, 'skills'), { withFileTypes: true })
  .filter((entry) => entry.isDirectory()).map((entry) => entry.name);

test('the GeniusBar soul is a valid package whose revision is pinned', async () => {
  const { validateSoulPackage } = await soulPackage();
  assert.equal(validateSoulPackage(GENIUSBAR).formatVersion, 1);
});

test('the GeniusBar soul is a template named GeniusBar on claude, then codex', () => {
  const soul = manifest();
  assert.equal(soul.name, 'GeniusBar');
  assert.equal(soul.template, true);
  assert.deepEqual(soul.preferredHarnesses, ['claude', 'codex']);
  assert.ok(soul.description.trim().length > 0);
  assert.equal(soul.parentRevision, null);
});

test('the GeniusBar soul has the same manifest shape as Starter', () => {
  const starter = JSON.parse(readFileSync(path.join(GENIUSBAR, '..', 'starter.soul', 'soul.json'), 'utf8'));
  const extra = Object.keys(manifest()).filter((key) => !(key in starter));
  assert.deepEqual(extra, ['template']);
});

test('the GeniusBar soul carries every skill its brief names', () => {
  assert.deepEqual(skills().sort(), ['census', 'credentials', 'fleet', 'identities', 'sop', 'soul-packages', 'update-and-restart']);
  const brief = readFileSync(path.join(GENIUSBAR, 'AGENTS.md'), 'utf8');
  for (const name of skills()) assert.match(brief, new RegExp(`skills/${name}\\b`), `AGENTS.md names ${name}`);
});

test('every GeniusBar skill has SKILL.md with a title and pinned versions', () => {
  for (const name of skills()) {
    const file = path.join(GENIUSBAR, 'skills', name, 'SKILL.md');
    assert.ok(existsSync(file), `${name}/SKILL.md exists`);
    const text = readFileSync(file, 'utf8');
    assert.match(text, new RegExp(`^---\\nname: ${name}\\n`), `${name} front matter names it`);
    assert.match(text, /^# \S.*$/m, `${name} has a title`);
    assert.match(text, /agent-bot 0\.10\.23|agent-comms 0\.3\.8/, `${name} states the version it describes`);
  }
});

test('the GeniusBar soul pins the agent-bot and agent-comms GeniusBar bundles', () => {
  const pins = JSON.parse(readFileSync(path.join(GENIUSBAR, '..', '..', 'components.json'), 'utf8')).components;
  const brief = readFileSync(path.join(GENIUSBAR, 'AGENTS.md'), 'utf8');
  assert.match(brief, new RegExp(`agent-bot ${pins['agent-bot'].tag.slice(1).replaceAll('.', '\\.')}\\b`));
  assert.match(brief, new RegExp(`agent-comms ${pins['agent-comms'].tag.slice(1).replaceAll('.', '\\.')}\\b`));
});
