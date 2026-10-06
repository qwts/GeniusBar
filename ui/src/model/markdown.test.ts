import { describe, expect, it } from 'vitest';
import { parseInline, parseMarkdown } from './markdown';

describe('parseInline', () => {
  it('reads bold, italic, code and links', () => {
    expect(parseInline('**Starter** is `agent_550fe` and *new*')).toEqual([
      { type: 'strong', children: [{ type: 'text', text: 'Starter' }] },
      { type: 'text', text: ' is ' },
      { type: 'code', text: 'agent_550fe' },
      { type: 'text', text: ' and ' },
      { type: 'em', children: [{ type: 'text', text: 'new' }] },
    ]);
    expect(parseInline('see [the docs](https://example.com/a)')).toEqual([
      { type: 'text', text: 'see ' },
      { type: 'link', children: [{ type: 'text', text: 'the docs' }], href: 'https://example.com/a' },
    ]);
  });

  it('leaves snake_case, lone markers and HTML as text', () => {
    expect(parseInline('agent_bot and soul_key')).toEqual([{ type: 'text', text: 'agent_bot and soul_key' }]);
    expect(parseInline('2 * 3 * 4')).toEqual([{ type: 'text', text: '2 * 3 * 4' }]);
    expect(parseInline('<b>x</b> <script>')).toEqual([{ type: 'text', text: '<b>x</b> <script>' }]);
    expect(parseInline('a `` b')).toEqual([{ type: 'text', text: 'a `` b' }]);
  });

  it('honours backslash escapes and nesting', () => {
    expect(parseInline('\\*not em\\*')).toEqual([{ type: 'text', text: '*not em*' }]);
    expect(parseInline('**bold `code`**')).toEqual([
      { type: 'strong', children: [{ type: 'text', text: 'bold ' }, { type: 'code', text: 'code' }] },
    ]);
  });
});

describe('parseMarkdown', () => {
  it('splits paragraphs on blank lines and keeps line breaks', () => {
    expect(parseMarkdown('one\ntwo\n\nthree')).toEqual([
      { type: 'paragraph', children: [{ type: 'text', text: 'one\ntwo' }] },
      { type: 'paragraph', children: [{ type: 'text', text: 'three' }] },
    ]);
  });

  it('reads bullet and numbered lists, headings, quotes and fenced code', () => {
    const blocks = parseMarkdown('# Plan\n1. first\n2. second\n\n- a\n- b\n  more\n\n> quoted\n\n```ts\nconst x = 1;\n```');
    expect(blocks.map((b) => b.type)).toEqual(['heading', 'list', 'list', 'quote', 'code']);
    expect(blocks[1]).toMatchObject({ ordered: true, start: 1, items: [[{ text: 'first' }], [{ text: 'second' }]] });
    expect(blocks[2]).toMatchObject({ ordered: false, items: [[{ text: 'a' }], [{ text: 'b\nmore' }]] });
    expect(blocks[4]).toEqual({ type: 'code', text: 'const x = 1;' });
  });

  it('starts a list right after a paragraph line and keeps an unclosed fence', () => {
    expect(parseMarkdown('Steps:\n3. go').map((b) => b.type)).toEqual(['paragraph', 'list']);
    expect(parseMarkdown('Steps:\n3. go')[1]).toMatchObject({ start: 3 });
    expect(parseMarkdown('```\nopen')).toEqual([{ type: 'code', text: 'open' }]);
  });

  it('returns nothing for blank text', () => {
    expect(parseMarkdown('  \n\n')).toEqual([]);
  });
});
