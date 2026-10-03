import { describe, expect, it } from 'vitest';
import { translate } from '../lib/i18n';
import { en } from './en';
import { es } from './es';

describe('locales', () => {
  it('gives Spanish exactly the English keys, none empty', () => {
    expect(Object.keys(es).sort()).toEqual(Object.keys(en).sort());
    expect(Object.values(es).every((text) => text.trim() !== '')).toBe(true);
  });

  it('keeps every placeholder in each translation', () => {
    const holes = (text: string) => [...text.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort();
    for (const key of Object.keys(en) as (keyof typeof en)[]) expect(holes(es[key]), key).toEqual(holes(en[key]));
  });

  it('fills placeholders', () => {
    expect(translate('en', 'bar.showAll', { count: 3 })).toBe('Show all hidden (3)');
    expect(translate('es', 'composerLabel', { name: 'luna' })).toBe('Mensaje para luna');
  });
});
