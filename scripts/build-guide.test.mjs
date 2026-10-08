import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { build, buildIndex, GUIDE_COPY, GUIDE_DIR, INDEX_FILE, parseChapter, readChapters, readVersions, staleness } from './build-guide.mjs';

const ROOT = path.dirname(path.dirname(new URL(import.meta.url).pathname));

test('the bundled guide is generated and copied for the current versions', () => {
  // A release bump or a component pin without `node scripts/build-guide.mjs` fails here.
  assert.deepEqual(staleness(), []);
  const index = JSON.parse(readFileSync(path.join(GUIDE_DIR, INDEX_FILE), 'utf8'));
  const versions = readVersions();
  assert.equal(index.appVersion, versions.appVersion);
  assert.deepEqual(index.components, versions.components);
  assert.match(index.draft, /^\d{4}-\d{2}-\d{2}$/);
  assert.deepEqual(index.chapters.map((c) => c.file), readChapters().map((c) => c.file));
  assert.deepEqual(JSON.parse(readFileSync(path.join(GUIDE_COPY, INDEX_FILE), 'utf8')), index);
});

test('every chapter parses, is tagged observed or design, and names no machine path', () => {
  const chapters = readChapters();
  assert.ok(chapters.length >= 14);
  const ids = new Set(chapters.map((c) => c.id));
  for (const required of ['getting-started', 'fleet-and-desktop', 'windows-and-popouts', 'companion-tabs', 'launching-souls',
    'harness-model-parent', 'sandbox-and-accounts', 'permissions-and-modes', 'computer-use-wake-pause', 'customize-revisions-skills',
    'environment-memory-history', 'archive-vs-delete', 'updates-services-about', 'command-line-tools', 'troubleshooting', 'genius-and-the-lead']) {
    assert.ok(ids.has(required), `chapter ${required}`);
  }
  for (const chapter of chapters) {
    assert.ok(chapter.sections.length > 0);
    for (const section of chapter.sections) assert.ok(['observed', 'design'].includes(section.tag), `${chapter.id} tag ${section.tag}`);
    const text = readFileSync(path.join(GUIDE_DIR, chapter.file), 'utf8');
    assert.doesNotMatch(text, /\/Users\/|\/Volumes\/|\/private\/tmp|simulator/i, `${chapter.id} has no machine path or simulator talk`);
    assert.ok(chapter.sections.some((s) => s.tag === 'observed'), `${chapter.id} says something observed`);
  }
  // Every design paragraph names the GitHub issue it comes from.
  for (const chapter of chapters) {
    for (const section of chapter.sections.filter((s) => s.tag === 'design')) {
      assert.match(section.text, /#\d+|agent-bot/, `${chapter.id}: design paragraph names an issue: ${section.text.slice(0, 50)}`);
    }
  }
});

test('the parser refuses an untagged paragraph, a bad id and a source without a url', () => {
  const ok = '---\nid: a\ntitle: A\nkeywords: [x, y]\nsources:\n  - label: L\n    url: https://example.test/1\n---\nobserved: one.\n\ndesign: two (#1).\n\n## Technical details\n- t\n';
  const chapter = parseChapter('01-a.md', ok);
  assert.deepEqual(chapter.keywords, ['x', 'y']);
  assert.deepEqual(chapter.sections, [{ tag: 'observed', text: 'one.' }, { tag: 'design', text: 'two (#1).' }]);
  assert.deepEqual(chapter.technical, ['t']);
  assert.deepEqual(chapter.sources, [{ label: 'L', url: 'https://example.test/1' }]);
  assert.throws(() => parseChapter('01-a.md', ok.replace('observed: one.', 'one.')), /untagged paragraph/);
  assert.throws(() => parseChapter('01-b.md', ok), /does not match the file name/);
  assert.throws(() => parseChapter('01-a.md', ok.replace('    url: https://example.test/1\n', '')), /no https url/);
  assert.throws(() => parseChapter('01-a.md', ok.replace('- t', 't')), /not a list item/);
});

test('--check reports a stale index and a stale copy, and build repairs them', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'guide-'));
  try {
    mkdirSync(path.join(root, 'src-tauri'), { recursive: true });
    writeFileSync(path.join(root, 'src-tauri', 'tauri.conf.json'), JSON.stringify({ version: '9.9.9' }));
    writeFileSync(path.join(root, 'components.json'), JSON.stringify({ components: { 'agent-bot': { tag: 'v1.2.3' }, 'agent-comms': { tag: 'v4.5.6' } } }));
    const dir = path.join(root, 'guide');
    const copy = path.join(root, 'copy');
    mkdirSync(dir);
    writeFileSync(path.join(dir, '01-a.md'), readFileSync(path.join(GUIDE_DIR, '01-overview.md'), 'utf8').replace('id: overview', 'id: a'));
    assert.match(staleness({ dir, copy, root })[0], /index\.json is missing/);
    build({ dir, copy, root });
    assert.deepEqual(staleness({ dir, copy, root }), []);
    const index = JSON.parse(readFileSync(path.join(dir, INDEX_FILE), 'utf8'));
    assert.equal(index.appVersion, '9.9.9');
    assert.deepEqual(index.components, { 'agent-bot': '1.2.3', 'agent-comms': '4.5.6' });
    assert.deepEqual(index, buildIndex(readChapters(dir), readVersions(root)));
    // A version bump without a rebuild.
    writeFileSync(path.join(root, 'src-tauri', 'tauri.conf.json'), JSON.stringify({ version: '9.9.10' }));
    assert.match(staleness({ dir, copy, root })[0], /index\.json is out of date/);
    build({ dir, copy, root });
    // A copy that drifted, and a stray file in it.
    writeFileSync(path.join(copy, '01-a.md'), 'changed');
    writeFileSync(path.join(copy, 'notes.md'), 'mine');
    const problems = staleness({ dir, copy, root });
    assert.ok(problems.some((p) => /01-a\.md differs/.test(p)));
    assert.ok(problems.some((p) => /notes\.md is not in the source/.test(p)));
    build({ dir, copy, root });
    assert.deepEqual(staleness({ dir, copy, root }), []);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
  assert.ok(ROOT);
});
