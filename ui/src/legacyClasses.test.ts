import { describe, expect, it } from 'vitest';

// Every component's source, to check the pass 6 sweep stays done.
const sources = import.meta.glob(['./**/*.tsx', '!./**/*.test.tsx'], { query: '?raw', import: 'default', eager: true }) as Record<string, string>;

/** The pre-redesign shared classes the Lovable tokens replaced (styles.css no longer defines them). */
const LEGACY = ['error', 'small', 'muted', 'link', 'panel', 'detail-actions', 'confirm', 'update', 'first-launch'];

function legacyIn(source: string): string[] {
  const found: string[] = [];
  // className="…", className={`…`} and the string branches inside them.
  for (const match of source.matchAll(/className=(?:"([^"]*)"|\{`([^`]*)`\}|\{'([^']*)'\})/g)) {
    const text = match.slice(1).filter(Boolean).join(' ');
    const tokens = text.split(/[\s${}'"?:()]+/);
    for (const token of tokens) if (LEGACY.includes(token)) found.push(token);
  }
  return found;
}

describe('the legacy class sweep (Lovable pass 6)', () => {
  it('reads the component sources', () => {
    expect(Object.keys(sources).length).toBeGreaterThan(30);
  });

  it('leaves no component on the old text and panel classes', () => {
    const left = Object.entries(sources).flatMap(([file, source]) => legacyIn(source).map((token) => `${file}: ${token}`));
    expect(left).toEqual([]);
  });
});
