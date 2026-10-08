#!/usr/bin/env node
// The App guide (#287): one canonical set of Markdown chapters in
// souls/starter.soul/docs/guide, packaged at build time. This script
// generates the chapter index (index.json, with the GeniusBar version and
// the bundled component versions the chapters were written for) and copies
// the whole folder into the GeniusBar lead's package, so both bundled souls
// carry the same guide. The UI imports the same chapter files with Vite.
//   node scripts/build-guide.mjs          # regenerate
//   node scripts/build-guide.mjs --check  # fail when anything is stale
// A release bump changes src-tauri/tauri.conf.json (and components.json for
// a component pin), so it must run this script again; CI runs --check.
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
export const GUIDE_DIR = path.join(ROOT, 'souls', 'starter.soul', 'docs', 'guide');
export const GUIDE_COPY = path.join(ROOT, 'souls', 'geniusbar.soul', 'docs', 'guide');
export const INDEX_FILE = 'index.json';
/** The guide draft: the date its content was last revised. */
export const GUIDE_DRAFT = '2026-10-07';
export const PROVENANCE = ['observed', 'design'];
const CHAPTER_FILE = /^(\d{2})-([a-z0-9-]+)\.md$/;

/** The chapter files of `dir`, in their numbered order. */
export function chapterFiles(dir = GUIDE_DIR) {
  return readdirSync(dir).filter((name) => CHAPTER_FILE.test(name)).sort();
}

/**
 * One chapter's front matter and body, checked: `id` (which must match the
 * file's slug), `title`, `keywords` (a bracketed list), `sources` (label
 * and url pairs), then paragraphs each tagged `observed:` or `design:`,
 * and an optional `## Technical details` bullet list. Throws naming the
 * file and the fault.
 */
export function parseChapter(name, text) {
  const fail = (what) => { throw new Error(`${name}: ${what}`); };
  const match = /^---\n([\s\S]*?)\n---\n([\s\S]*)$/.exec(text) ?? fail('missing front matter');
  const [, head, body] = match;
  const meta = { id: null, title: null, keywords: [], sources: [] };
  let source = null;
  for (const line of head.split('\n')) {
    if (line.trim() === '') continue;
    let m;
    if ((m = /^id: (\S+)$/.exec(line))) meta.id = m[1];
    else if ((m = /^title: (.+)$/.exec(line))) meta.title = m[1].trim();
    else if ((m = /^keywords: \[(.*)\]$/.exec(line))) meta.keywords = m[1].split(',').map((k) => k.trim()).filter(Boolean);
    else if (line === 'sources:') source = null;
    else if ((m = /^  - label: (.+)$/.exec(line))) { source = { label: m[1].trim(), url: null }; meta.sources.push(source); }
    else if ((m = /^    url: (\S+)$/.exec(line))) { if (!source) fail('url without a source label'); source.url = m[1]; }
    else fail(`unknown front matter line: ${line}`);
  }
  if (!meta.id) fail('missing id');
  const slug = CHAPTER_FILE.exec(name)?.[2];
  if (slug && slug !== meta.id) fail(`id ${meta.id} does not match the file name`);
  if (!meta.title) fail('missing title');
  if (meta.keywords.length === 0) fail('missing keywords');
  for (const s of meta.sources) if (!s.url || !/^https:\/\//.test(s.url)) fail(`source ${s.label} has no https url`);
  const [main, ...rest] = body.split(/^## Technical details\n/m);
  if (rest.length > 1) fail('more than one Technical details section');
  const sections = main.split(/\n\s*\n/).map((p) => p.trim()).filter(Boolean).map((p) => {
    const tagged = /^(observed|design):\s+([\s\S]+)$/.exec(p) ?? fail(`untagged paragraph: ${p.slice(0, 40)}…`);
    return { tag: tagged[1], text: tagged[2].replace(/\s*\n\s*/g, ' ') };
  });
  if (sections.length === 0) fail('no paragraphs');
  const technical = rest.length === 0 ? [] : rest[0].split('\n').map((l) => l.trim()).filter(Boolean).map((l) => {
    if (!l.startsWith('- ')) fail(`technical detail is not a list item: ${l.slice(0, 40)}`);
    return l.slice(2).trim();
  });
  return { ...meta, file: name, sections, technical };
}

/** Every chapter of `dir`, parsed, in order. */
export function readChapters(dir = GUIDE_DIR) {
  const chapters = chapterFiles(dir).map((name) => parseChapter(name, readFileSync(path.join(dir, name), 'utf8')));
  const ids = new Set();
  for (const chapter of chapters) {
    if (ids.has(chapter.id)) throw new Error(`${chapter.file}: duplicate chapter id ${chapter.id}`);
    ids.add(chapter.id);
  }
  return chapters;
}

/** The versions the guide is written for: the app's and the bundled components'. */
export function readVersions(root = ROOT) {
  const appVersion = JSON.parse(readFileSync(path.join(root, 'src-tauri', 'tauri.conf.json'), 'utf8')).version;
  const pins = JSON.parse(readFileSync(path.join(root, 'components.json'), 'utf8')).components;
  const components = Object.fromEntries(['agent-bot', 'agent-comms'].map((name) => [name, pins[name].tag.replace(/^v/, '')]));
  return { appVersion, components };
}

/** The index as it should be, from the chapters and the versions. */
export function buildIndex(chapters, versions, draft = GUIDE_DRAFT) {
  return {
    draft,
    appVersion: versions.appVersion,
    components: versions.components,
    chapters: chapters.map(({ id, title, keywords, file }) => ({ id, title, keywords, file })),
  };
}

const serialize = (index) => `${JSON.stringify(index, null, 2)}\n`;

/** The files the lead's copy should hold: every chapter and the index, by name. */
function wanted(dir) {
  const files = new Map();
  for (const name of chapterFiles(dir)) files.set(name, readFileSync(path.join(dir, name), 'utf8'));
  files.set(INDEX_FILE, readFileSync(path.join(dir, INDEX_FILE), 'utf8'));
  return files;
}

/** What is stale: the index, or the copy; empty when nothing is. */
export function staleness({ dir = GUIDE_DIR, copy = GUIDE_COPY, root = ROOT } = {}) {
  const problems = [];
  const index = serialize(buildIndex(readChapters(dir), readVersions(root)));
  const indexPath = path.join(dir, INDEX_FILE);
  if (!existsSync(indexPath)) problems.push(`${path.relative(root, indexPath)} is missing`);
  else if (readFileSync(indexPath, 'utf8') !== index) problems.push(`${path.relative(root, indexPath)} is out of date (versions or chapters changed)`);
  if (problems.length === 0) {
    const source = wanted(dir);
    const present = existsSync(copy) ? new Set(readdirSync(copy)) : new Set();
    for (const [name, text] of source) {
      const file = path.join(copy, name);
      if (!present.has(name)) problems.push(`${path.relative(root, file)} is missing`);
      else if (readFileSync(file, 'utf8') !== text) problems.push(`${path.relative(root, file)} differs from the source`);
    }
    for (const name of present) if (!source.has(name)) problems.push(`${path.relative(root, path.join(copy, name))} is not in the source`);
  }
  return problems;
}

/** Writes the index and the lead's copy. */
export function build({ dir = GUIDE_DIR, copy = GUIDE_COPY, root = ROOT } = {}) {
  const chapters = readChapters(dir);
  writeFileSync(path.join(dir, INDEX_FILE), serialize(buildIndex(chapters, readVersions(root))));
  rmSync(copy, { recursive: true, force: true });
  mkdirSync(copy, { recursive: true });
  for (const [name, text] of wanted(dir)) writeFileSync(path.join(copy, name), text);
  return chapters;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const check = process.argv.includes('--check');
  try {
    if (check) {
      const problems = staleness();
      if (problems.length > 0) {
        process.stderr.write(`${problems.map((p) => `guide: ${p}`).join('\n')}\nguide: run node scripts/build-guide.mjs\n`);
        process.exit(1);
      }
      process.stdout.write('guide: up to date\n');
    } else {
      const chapters = build();
      process.stdout.write(`guide: ${chapters.length} chapters indexed and copied to ${path.relative(ROOT, GUIDE_COPY)}\n`);
    }
  } catch (error) {
    process.stderr.write(`guide: ${error.message}\n`);
    process.exit(1);
  }
}
