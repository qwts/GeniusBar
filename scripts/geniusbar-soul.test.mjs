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

test('the GeniusBar soul has the same manifest shape as Genius, plus template', () => {
  const genius = JSON.parse(readFileSync(path.join(GENIUSBAR, '..', 'starter.soul', 'soul.json'), 'utf8'));
  const extra = Object.keys(manifest()).filter((key) => !(key in genius));
  assert.deepEqual(extra, ['template']);
  // Genius alone remembers its old name; both maintain the guide (#287).
  assert.deepEqual(Object.keys(genius).filter((key) => !(key in manifest())), ['previousNames']);
  assert.deepEqual(manifest().maintained, ['docs/guide/', 'skills/']);
});

test('the GeniusBar soul carries the same guide as Genius and its brief points at it (#287)', () => {
  const guide = path.join(GENIUSBAR, 'docs', 'guide');
  const source = path.join(GENIUSBAR, '..', 'starter.soul', 'docs', 'guide');
  assert.deepEqual(readdirSync(guide).sort(), readdirSync(source).sort());
  for (const name of readdirSync(guide)) assert.equal(readFileSync(path.join(guide, name), 'utf8'), readFileSync(path.join(source, name), 'utf8'), name);
  assert.match(readFileSync(path.join(GENIUSBAR, 'AGENTS.md'), 'utf8'), /docs\/guide\/index\.json/);
});

test('the GeniusBar soul carries every skill its brief names', () => {
  assert.deepEqual(skills().sort(), ['census', 'credentials', 'fleet', 'fleet-configuration', 'identities', 'sop', 'soul-packages', 'update-and-restart']);
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
    assert.match(text, /agent-bot 0\.10\.33|agent-comms 0\.3\.13/, `${name} states the version it describes`);
  }
});

test('the GeniusBar soul pins the agent-bot and agent-comms GeniusBar bundles', () => {
  const pins = JSON.parse(readFileSync(path.join(GENIUSBAR, '..', '..', 'components.json'), 'utf8')).components;
  const brief = readFileSync(path.join(GENIUSBAR, 'AGENTS.md'), 'utf8');
  assert.match(brief, new RegExp(`agent-bot ${pins['agent-bot'].tag.slice(1).replaceAll('.', '\\.')}\\b`));
  assert.match(brief, new RegExp(`agent-comms ${pins['agent-comms'].tag.slice(1).replaceAll('.', '\\.')}\\b`));
});
