// The App guide (#287): the chapters Genius carries in its package
// (souls/starter.soul/docs/guide), imported by Vite from the same files at
// build time so the app and the soul never disagree. Pure: parsing and
// search take text and return data; the dialog renders it.

/** Where a paragraph's claim comes from: the shipped app, or a design not shipped yet. */
export type Provenance = 'observed' | 'design';

export interface GuideSection { tag: Provenance; text: string }
export interface GuideSource { label: string; url: string }
export interface GuideChapter {
  id: string;
  title: string;
  keywords: readonly string[];
  sections: readonly GuideSection[];
  /** Behind the "Technical details" disclosure. */
  technical: readonly string[];
  sources: readonly GuideSource[];
}

/** `index.json` beside the chapters: the draft date and the versions the guide was written for. */
export interface GuideMeta {
  draft: string;
  appVersion: string;
  components: Readonly<Record<string, string>>;
  chapters: readonly { id: string; file: string }[];
}

const CHAPTER_FILE = /(\d{2})-([a-z0-9-]+)\.md$/;

/**
 * One chapter from its Markdown: front matter (id, title, keywords,
 * sources), paragraphs tagged `observed:` or `design:`, and the optional
 * `## Technical details` list. Throws naming `name` on a malformed file,
 * which the build script also refuses, so the app never ships one.
 */
export function parseChapter(name: string, text: string): GuideChapter {
  const fail = (what: string): never => { throw new Error(`${name}: ${what}`); };
  const match = /^---\n([\s\S]*?)\n---\n([\s\S]*)$/.exec(text) ?? fail('missing front matter');
  const [, head = '', body = ''] = match;
  let id: string | null = null;
  let title: string | null = null;
  let keywords: string[] = [];
  const sources: GuideSource[] = [];
  let source: { label: string; url: string } | null = null;
  for (const line of head.split('\n')) {
    if (line.trim() === '') continue;
    let m: RegExpExecArray | null;
    if ((m = /^id: (\S+)$/.exec(line))) id = m[1] ?? null;
    else if ((m = /^title: (.+)$/.exec(line))) title = (m[1] ?? '').trim();
    else if ((m = /^keywords: \[(.*)\]$/.exec(line))) keywords = (m[1] ?? '').split(',').map((k) => k.trim()).filter(Boolean);
    else if (line === 'sources:') source = null;
    else if ((m = /^  - label: (.+)$/.exec(line))) { source = { label: (m[1] ?? '').trim(), url: '' }; sources.push(source); }
    else if ((m = /^    url: (\S+)$/.exec(line))) { if (!source) return fail('url without a source label'); source.url = m[1] ?? ''; }
    else fail(`unknown front matter line: ${line}`);
  }
  if (!id) return fail('missing id');
  if (!title) return fail('missing title');
  const slug = CHAPTER_FILE.exec(name)?.[2];
  if (slug && slug !== id) fail(`id ${id} does not match the file name`);
  for (const s of sources) if (!/^https:\/\//.test(s.url)) fail(`source ${s.label} has no https url`);
  const [main = '', ...rest] = body.split(/^## Technical details\n/m);
  const sections = main.split(/\n\s*\n/).map((p) => p.trim()).filter(Boolean).map((p): GuideSection => {
    const tagged = /^(observed|design):\s+([\s\S]+)$/.exec(p) ?? fail(`untagged paragraph: ${p.slice(0, 40)}`);
    return { tag: tagged[1] as Provenance, text: (tagged[2] ?? '').replace(/\s*\n\s*/g, ' ') };
  });
  if (sections.length === 0) fail('no paragraphs');
  const technical = (rest[0] ?? '').split('\n').map((l) => l.trim()).filter(Boolean)
    .map((l) => (l.startsWith('- ') ? l.slice(2).trim() : fail(`technical detail is not a list item: ${l.slice(0, 40)}`)));
  return { id, title, keywords, sections, technical, sources };
}

/**
 * The chapters in the index's order (a file the index does not list comes
 * last, in file order), from a map of file name to Markdown text.
 */
export function orderChapters(files: Readonly<Record<string, string>>, meta: Pick<GuideMeta, 'chapters'> | null): GuideChapter[] {
  const parsed = Object.keys(files).sort().map((path) => {
    const name = path.slice(path.lastIndexOf('/') + 1);
    return { name, chapter: parseChapter(name, files[path] ?? '') };
  });
  const rank = new Map((meta?.chapters ?? []).map((c, i) => [c.file, i]));
  return parsed
    .map((entry, i) => ({ ...entry, order: rank.get(entry.name) ?? rank.size + i }))
    .sort((a, b) => a.order - b.order)
    .map((entry) => entry.chapter);
}

/**
 * The chapters whose title, keywords, paragraphs or technical details hold
 * every word of `query` (case-insensitive); an empty query lists them all.
 */
export function searchGuide(query: string, chapters: readonly GuideChapter[]): GuideChapter[] {
  const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (terms.length === 0) return [...chapters];
  return chapters.filter((c) => {
    const hay = [c.title, ...c.keywords, ...c.sections.map((s) => s.text), ...c.technical].join(' ').toLowerCase();
    return terms.every((t) => hay.includes(t));
  });
}

/** The `index.json` shape, checked; null when the file is not what the build script writes. */
export function readGuideMeta(value: unknown): GuideMeta | null {
  if (typeof value !== 'object' || value === null) return null;
  const v = value as Record<string, unknown>;
  if (typeof v.draft !== 'string' || typeof v.appVersion !== 'string' || typeof v.components !== 'object' || v.components === null || !Array.isArray(v.chapters)) return null;
  const components: Record<string, string> = {};
  for (const [name, version] of Object.entries(v.components as Record<string, unknown>)) if (typeof version === 'string') components[name] = version;
  const chapters = v.chapters.flatMap((c: unknown) => {
    if (typeof c !== 'object' || c === null) return [];
    const { id, file } = c as Record<string, unknown>;
    return typeof id === 'string' && typeof file === 'string' ? [{ id, file }] : [];
  });
  return { draft: v.draft, appVersion: v.appVersion, components, chapters };
}

// The soul's own files, at build time. The glob is relative to this file.
const files = import.meta.glob('../../../souls/starter.soul/docs/guide/*.md', { query: '?raw', import: 'default', eager: true }) as Record<string, string>;
const indexes = import.meta.glob('../../../souls/starter.soul/docs/guide/index.json', { import: 'default', eager: true }) as Record<string, unknown>;

const manifests = import.meta.glob('../../../souls/starter.soul/soul.json', { import: 'default', eager: true }) as Record<string, { name?: unknown } | undefined>;
const manifestName = Object.values(manifests)[0]?.name;
/** The guide soul's template name, from its own manifest: the companion whose chat offers the guide. */
export const GUIDE_SOUL_NAME: string = typeof manifestName === 'string' ? manifestName : 'Genius';
/** Whether a companion with this display name is the guide: one made from the Genius template that kept its name. */
export const isGuideSoul = (name: string): boolean => name === GUIDE_SOUL_NAME;

/** The bundled guide's index; null only in a tree where the build script has not run. */
export const GUIDE_META: GuideMeta | null = readGuideMeta(Object.values(indexes)[0]);
/** The bundled chapters, in the index's order. */
export const GUIDE: readonly GuideChapter[] = orderChapters(files, GUIDE_META);
