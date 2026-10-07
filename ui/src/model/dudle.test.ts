import { describe, expect, it } from 'vitest';
import { blinkEyeScale, deriveDudle, derivedHue, dudleFor, hsb, stableHash64 } from './dudle';

describe('Dudle derivation', () => {
  it('derives the same Dudle for the same soul ID across calls', () => {
    expect(deriveDudle('agent_abc123')).toEqual(deriveDudle('agent_abc123'));
  });

  it('has fixed known stable hash values (no randomized hasher)', () => {
    expect(stableHash64('')).toBe(0xcbf29ce484222325n);
    expect(stableHash64('agent_abc123')).toBe(stableHash64('agent_abc123'));
    expect(stableHash64('agent_abc123')).not.toBe(stableHash64('agent_abc124'));
  });

  it('spreads distinct IDs across the hue wheel', () => {
    const hues = Array.from({ length: 50 }, (_, i) => deriveDudle(`agent_${i}`).bodyHue);
    expect(new Set(hues).size).toBeGreaterThan(40);
  });

  it('keeps all traits inside their documented ranges', () => {
    for (let i = 0; i < 200; i++) {
      const d = deriveDudle(`agent_probe_${i}`);
      expect(d.bodyHue >= 0 && d.bodyHue < 1).toBe(true);
      expect(d.sizeWobble >= 0.92 && d.sizeWobble <= 1.08).toBe(true);
      expect(d.eyeSpacing >= 0.45 && d.eyeSpacing <= 0.75).toBe(true);
      expect(d.eyeScale >= 0.85 && d.eyeScale <= 1.15).toBe(true);
      expect(d.blush >= 0 && d.blush <= 1).toBe(true);
      expect(d.squish >= 0.94 && d.squish <= 1.06).toBe(true);
      expect(d.highlightAngle >= 0 && d.highlightAngle < 2 * Math.PI).toBe(true);
    }
  });

  it('still differs for IDs that differ only in the tail', () => {
    expect(deriveDudle('agent_worker_long_prefix_001')).not.toEqual(deriveDudle('agent_worker_long_prefix_002'));
  });

  // Values printed by R1's Dudle.swift (Swift 6.4), so a soul keeps the
  // exact look it had in the Swift app. The last ID covers multi-byte UTF-8.
  it.each([
    ['', 0xcbf29ce484222325n, [0.13728542000457772, 1.0025842679484245, 0.6338590066376746, 1.089002059967956, 0.08583199816891737, 0.9737212176699473, 2.464952990731474]],
    ['agent_abc123', 0x17370c73671fe7bbn, [0.9052109559777218, 0.9844516670481422, 0.46458915083543145, 0.87720531013962, 0.3709620813305867, 0.9768651865415426, 1.6016921300334501]],
    ['agent_1', 0x9c02ae8a5b754b1en, [0.2934309910734722, 0.9771615167467765, 0.6545410849164569, 1.0328244449530786, 0.11404592965590905, 0.9476777294575417, 1.7391772560042373]],
    ['user/agent_p', 0xa36bb6aa4e8cfbfbn, [0.984313725490196, 0.9690925459678035, 0.6640627145799954, 1.0415083543144883, 0.5114671549553673, 0.9800823987182421, 5.473806343828551]],
    ['agent_worker_long_prefix_001', 0x7ca497d5634bf4bdn, [0.956023498893721, 0.9820590524147402, 0.6279308766308079, 0.9960654612039368, 0.9085984588387884, 1.0174254978255894, 1.0314260705674523]],
    ['héllo-✓', 0xc42910b3b318b16en, [0.6930952925917448, 1.031935301747158, 0.46956969558251316, 1.0798786907759212, 0.9281452658884566, 0.9524220645456626, 4.04794944463919]],
  ] as const)('matches the Swift app exactly for %j', (id, hash, traits) => {
    expect(stableHash64(id)).toBe(hash);
    const d = deriveDudle(id);
    expect([d.bodyHue, d.sizeWobble, d.eyeSpacing, d.eyeScale, d.blush, d.squish, d.highlightAngle]).toEqual(traits);
  });
});

describe('Blink', () => {
  it('keeps the eyes open outside the blink window', () => {
    expect(blinkEyeScale(1.0)).toBe(1);
    expect(blinkEyeScale(0.14)).toBe(1);
    expect(blinkEyeScale(3.599)).toBe(1);
  });

  it('closes the eyes mid-blink', () => {
    expect(Math.abs(blinkEyeScale(0.07) - 0.08)).toBeLessThan(1e-9);
  });

  it('is continuous at the window edge', () => {
    expect(Math.abs(blinkEyeScale(0.14 - 1e-6) - 1)).toBeLessThan(0.001);
    expect(Math.abs(blinkEyeScale(1e-9) - 1)).toBeLessThan(0.001);
  });

  it('stays open with degenerate parameters', () => {
    expect(blinkEyeScale(0.07, 0)).toBe(1);
    expect(blinkEyeScale(0.07, 3.6, 0)).toBe(1);
  });
});

describe('HSB colour', () => {
  it('converts like SwiftUI Color(hue:saturation:brightness:)', () => {
    expect(hsb(0, 1, 1)).toBe('rgb(255, 0, 0)');
    expect(hsb(1 / 3, 1, 1)).toBe('rgb(0, 255, 0)');
    expect(hsb(2 / 3, 1, 1)).toBe('rgb(0, 0, 255)');
    expect(hsb(0.5, 0, 0.5)).toBe('rgb(128, 128, 128)');
  });
});

describe('dudleFor (#64)', () => {
  it('is the derived Dudle without a declared hue', () => {
    expect(dudleFor({ agentId: 'agent_p' })).toEqual(deriveDudle('agent_p'));
  });

  it('puts a declared hue over the derived one and keeps every other trait', () => {
    const spec = dudleFor({ agentId: 'agent_p', hue: 210 });
    expect(spec.bodyHue * 360).toBeCloseTo(210);
    expect({ ...spec, bodyHue: 0 }).toEqual({ ...deriveDudle('agent_p'), bodyHue: 0 });
    expect(dudleFor({ agentId: 'agent_p', hue: 0 }).bodyHue).toBe(0);
  });

  it('gives the derived hue in whole degrees, 0..359', () => {
    for (const id of ['agent_p', 'agent_c', 'luna', '']) {
      const hue = derivedHue(id);
      expect(Number.isInteger(hue)).toBe(true);
      expect(hue).toBeGreaterThanOrEqual(0);
      expect(hue).toBeLessThanOrEqual(359);
      expect(hue).toBe(Math.round(deriveDudle(id).bodyHue * 360) % 360);
    }
  });
});
