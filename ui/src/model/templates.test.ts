import { describe, expect, it } from 'vitest';
import type { SoulTemplate } from '../bridge';
import { chosenTemplate, CUSTOM_SOUL, initialChoice } from './templates';

const template = (name: string, harness: string | null = null): SoulTemplate => ({
  name, description: '', preferredHarnesses: harness ? [harness] : [], defaultHarness: harness,
  package: `/souls/${name}.soul`, revision: null, source: 'souls-root',
});
const list = [template('Coder', 'claude'), template('Researcher')];

describe('soul template choice (#65)', () => {
  it('preselects the first template for a blank form', () => {
    expect(initialChoice(list, '', false)).toBe('/souls/Coder.soul');
  });

  it('keeps an opened or typed package on "Custom soul"', () => {
    expect(initialChoice(list, '', true)).toBe(CUSTOM_SOUL);
    expect(initialChoice(list, '/souls/mine.soul', false)).toBe(CUSTOM_SOUL);
    expect(initialChoice([], '', false)).toBe(CUSTOM_SOUL);
  });

  it('finds the chosen template by package', () => {
    expect(chosenTemplate(list, '/souls/Researcher.soul')?.name).toBe('Researcher');
    expect(chosenTemplate(list, CUSTOM_SOUL)).toBeNull();
    expect(chosenTemplate(list, '/souls/Gone.soul')).toBeNull();
  });
});
