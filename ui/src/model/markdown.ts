// A small, safe Markdown subset for chat bodies (#117). Pure: it turns text
// into a tree that the UI renders as React elements, never as HTML, so a
// body cannot inject markup. Covered: paragraphs (line breaks kept),
// headings, bullet and numbered lists, block quotes, fenced code, inline
// code, bold, italic and links. Links are not followed: the UI shows their
// text and address as plain text, since GeniusBar has no external-link path.

export type Inline =
  | { type: 'text'; text: string }
  | { type: 'code'; text: string }
  | { type: 'strong'; children: Inline[] }
  | { type: 'em'; children: Inline[] }
  | { type: 'link'; children: Inline[]; href: string };

export type Block =
  | { type: 'paragraph'; children: Inline[] }
  | { type: 'heading'; level: number; children: Inline[] }
  | { type: 'list'; ordered: boolean; start: number; items: Inline[][] }
  | { type: 'quote'; children: Inline[] }
  | { type: 'code'; text: string };

const ESCAPABLE = /[\\`*_[\]()#+\-.!>]/;
const STRONG = /^(\*\*|__)(?!\s)([\s\S]+?)(?<!\s)\1/;
const EM_STAR = /^\*(?!\s)([^*\n]+?)(?<!\s)\*(?!\*)/;
const EM_UNDERSCORE = /^_(?!\s)([^_\n]+?)(?<!\s)_(?!\w)/;
const LINK = /^\[([^\]\n]+)\]\(([^()\s]+)\)/;

/** Inline Markdown in `src`, as a tree of text runs. */
export function parseInline(src: string): Inline[] {
  const out: Inline[] = [];
  let text = '';
  const flush = () => {
    if (text) out.push({ type: 'text', text });
    text = '';
  };
  let i = 0;
  while (i < src.length) {
    const ch = src[i];
    const rest = src.slice(i);
    if (ch === '\\' && i + 1 < src.length && ESCAPABLE.test(src[i + 1])) {
      text += src[i + 1];
      i += 2;
      continue;
    }
    if (ch === '`') {
      const end = src.indexOf('`', i + 1);
      if (end > i + 1) {
        flush();
        out.push({ type: 'code', text: src.slice(i + 1, end) });
        i = end + 1;
        continue;
      }
    }
    if (ch === '*' || ch === '_') {
      // Intraword underscores (snake_case ids) stay literal.
      const wordBefore = ch === '_' && /\w/.test(src[i - 1] ?? '');
      const strong = wordBefore ? null : STRONG.exec(rest);
      if (strong) {
        flush();
        out.push({ type: 'strong', children: parseInline(strong[2]) });
        i += strong[0].length;
        continue;
      }
      const em = wordBefore ? null : (ch === '*' ? EM_STAR : EM_UNDERSCORE).exec(rest);
      if (em) {
        flush();
        out.push({ type: 'em', children: parseInline(em[1]) });
        i += em[0].length;
        continue;
      }
    }
    if (ch === '[') {
      const link = LINK.exec(rest);
      if (link) {
        flush();
        out.push({ type: 'link', children: parseInline(link[1]), href: link[2] });
        i += link[0].length;
        continue;
      }
    }
    text += ch;
    i += 1;
  }
  flush();
  return out;
}

const FENCE = /^\s{0,3}(```|~~~)/;
const HEADING = /^\s{0,3}(#{1,6})\s+(.*?)\s*#*\s*$/;
const BULLET = /^\s{0,3}[-*+]\s+(.*)$/;
const NUMBERED = /^\s{0,3}(\d{1,9})[.)]\s+(.*)$/;
const QUOTE = /^\s{0,3}>\s?(.*)$/;
const RULE = /^\s{0,3}([-*_])(\s*\1){2,}\s*$/;

/** Block-level Markdown in `src`. */
export function parseMarkdown(src: string): Block[] {
  const lines = src.replace(/\r\n?/g, '\n').split('\n');
  const blocks: Block[] = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (line.trim() === '') {
      i += 1;
      continue;
    }
    const fence = FENCE.exec(line);
    if (fence) {
      const body: string[] = [];
      i += 1;
      while (i < lines.length && !lines[i].trimStart().startsWith(fence[1])) body.push(lines[i++]);
      i += 1; // the closing fence, or past the end when unclosed
      blocks.push({ type: 'code', text: body.join('\n') });
      continue;
    }
    const heading = HEADING.exec(line);
    if (heading) {
      blocks.push({ type: 'heading', level: heading[1].length, children: parseInline(heading[2]) });
      i += 1;
      continue;
    }
    if (RULE.test(line)) {
      i += 1;
      continue;
    }
    const ordered = NUMBERED.exec(line);
    if (ordered || BULLET.test(line)) {
      const pattern = ordered ? NUMBERED : BULLET;
      const items: string[] = [];
      while (i < lines.length && lines[i].trim() !== '') {
        const m = pattern.exec(lines[i]);
        if (m) items.push(m[m.length - 1]);
        else if (items.length > 0 && /^\s+\S/.test(lines[i])) items[items.length - 1] += `\n${lines[i].trim()}`;
        else break;
        i += 1;
      }
      blocks.push({
        type: 'list',
        ordered: Boolean(ordered),
        start: ordered ? Number(ordered[1]) : 1,
        items: items.map(parseInline),
      });
      continue;
    }
    if (QUOTE.test(line)) {
      const body: string[] = [];
      let m: RegExpExecArray | null;
      while (i < lines.length && (m = QUOTE.exec(lines[i]))) {
        body.push(m[1]);
        i += 1;
      }
      blocks.push({ type: 'quote', children: parseInline(body.join('\n')) });
      continue;
    }
    // A paragraph runs to a blank line or the start of another block.
    const body: string[] = [];
    while (i < lines.length && lines[i].trim() !== '' && (body.length === 0 || !startsBlock(lines[i]))) {
      body.push(lines[i]);
      i += 1;
    }
    blocks.push({ type: 'paragraph', children: parseInline(body.join('\n')) });
  }
  return blocks;
}

function startsBlock(line: string): boolean {
  return FENCE.test(line) || HEADING.test(line) || BULLET.test(line) || NUMBERED.test(line) || QUOTE.test(line);
}
