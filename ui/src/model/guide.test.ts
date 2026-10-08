import { describe, expect, it } from 'vitest';
import { GUIDE, GUIDE_META, orderChapters, parseChapter, readGuideMeta, searchGuide } from './guide';

const chapter = (id: string, title: string, keywords: string, body: string) =>
  `---\nid: ${id}\ntitle: ${title}\nkeywords: [${keywords}]\nsources:\n  - label: GeniusBar #1 — one\n    url: https://github.com/qwts/GeniusBar/issues/1\n---\n${body}`;

describe('guide chapters (#287)', () => {
  it('parses front matter, tagged paragraphs and technical details', () => {
    const text = chapter('archive', 'Archive versus deletion', 'archive, delete', 'observed: Remove… archives.\nAcross lines.\n\ndesign: A team scope (#283).\n\n## Technical details\n- `agent-bot soul remove`\n- nothing deleted\n');
    expect(parseChapter('13-archive.md', text)).toEqual({
      id: 'archive', title: 'Archive versus deletion', keywords: ['archive', 'delete'],
      sections: [{ tag: 'observed', text: 'Remove… archives. Across lines.' }, { tag: 'design', text: 'A team scope (#283).' }],
      technical: ['`agent-bot soul remove`', 'nothing deleted'],
      sources: [{ label: 'GeniusBar #1 — one', url: 'https://github.com/qwts/GeniusBar/issues/1' }],
    });
  });

  it('refuses a paragraph without a provenance tag, a mismatched id and a non-https source', () => {
    expect(() => parseChapter('01-a.md', chapter('a', 'A', 'x', 'Plain text.\n'))).toThrow(/untagged paragraph/);
    expect(() => parseChapter('01-b.md', chapter('a', 'A', 'x', 'observed: ok\n'))).toThrow(/does not match/);
    expect(() => parseChapter('01-a.md', chapter('a', 'A', 'x', 'observed: ok\n').replace('https://', 'http://'))).toThrow(/https/);
    expect(() => parseChapter('01-a.md', '# no front matter')).toThrow(/front matter/);
  });

  it('orders chapters as the index says and appends files the index does not list', () => {
    const files = {
      '/g/02-b.md': chapter('b', 'B', 'b', 'observed: b\n'),
      '/g/01-a.md': chapter('a', 'A', 'a', 'observed: a\n'),
      '/g/03-c.md': chapter('c', 'C', 'c', 'observed: c\n'),
    };
    expect(orderChapters(files, { chapters: [{ id: 'b', file: '02-b.md' }, { id: 'a', file: '01-a.md' }] }).map((c) => c.id)).toEqual(['b', 'a', 'c']);
    expect(orderChapters(files, null).map((c) => c.id)).toEqual(['a', 'b', 'c']);
  });

  it('searches title, keywords, text and technical details, every term, case-insensitively', () => {
    const chapters = orderChapters({
      '/g/01-a.md': chapter('a', 'Archive versus deletion', 'retire', 'observed: The folder moves to .archive.\n\n## Technical details\n- `soul remove`\n'),
      '/g/02-b.md': chapter('b', 'Launching', 'template, custom soul', 'design: A parent choice (#261).\n'),
    }, null);
    expect(searchGuide('', chapters).map((c) => c.id)).toEqual(['a', 'b']);
    expect(searchGuide('ARCHIVE', chapters).map((c) => c.id)).toEqual(['a']);
    expect(searchGuide('retire', chapters).map((c) => c.id)).toEqual(['a']);
    expect(searchGuide('soul remove', chapters).map((c) => c.id)).toEqual(['a']);
    expect(searchGuide('parent', chapters).map((c) => c.id)).toEqual(['b']);
    expect(searchGuide('soul', chapters).map((c) => c.id)).toEqual(['a', 'b']);
    expect(searchGuide('archive parent', chapters)).toEqual([]);
  });

  it('reads the index shape and rejects anything else', () => {
    expect(readGuideMeta({ draft: '2026-10-07', appVersion: '0.1.60', components: { 'agent-bot': '0.10.51', x: 1 }, chapters: [{ id: 'a', file: '01-a.md' }, 'junk'] }))
      .toEqual({ draft: '2026-10-07', appVersion: '0.1.60', components: { 'agent-bot': '0.10.51' }, chapters: [{ id: 'a', file: '01-a.md' }] });
    expect(readGuideMeta(null)).toBeNull();
    expect(readGuideMeta({ draft: 1 })).toBeNull();
  });

  it('bundles the soul’s own chapters in the index’s order, with the app and component versions', () => {
    expect(GUIDE_META).not.toBeNull();
    expect(GUIDE_META?.appVersion).toMatch(/^\d+\.\d+\.\d+$/);
    expect(Object.keys(GUIDE_META?.components ?? {})).toEqual(['agent-bot', 'agent-comms']);
    expect(GUIDE.map((c) => c.id)).toEqual(GUIDE_META?.chapters.map((c) => c.id));
    expect(GUIDE.length).toBeGreaterThanOrEqual(14);
    for (const c of GUIDE) expect(c.sections.some((s) => s.tag === 'observed'), c.id).toBe(true);
    expect(searchGuide('archive', GUIDE).map((c) => c.id)).toContain('archive-vs-delete');
    expect(searchGuide('parent', GUIDE).map((c) => c.id)).toContain('harness-model-parent');
  });
});
