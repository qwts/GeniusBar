// Dudle derivation, ported from R1's Dudle.swift. A soul's look comes
// deterministically from its agent ID through FNV-1a 64 over UTF-8, so the
// same soul looks the same here as it did in the Swift app.

const FNV_OFFSET = 0xcbf29ce484222325n;
const FNV_PRIME = 0x100000001b3n;
const U64 = 0xffffffffffffffffn;
const utf8 = new TextEncoder();

/** FNV-1a 64-bit. BigInt because the hash needs all 64 bits wrapping. */
export function stableHash64(text: string): bigint {
  let hash = FNV_OFFSET;
  for (const byte of utf8.encode(text)) {
    hash ^= BigInt(byte);
    hash = (hash * FNV_PRIME) & U64;
  }
  return hash;
}

/** Unit-interval value from 16 bits of hash starting at a bit offset. */
function unit(hash: bigint, offset: number): number {
  return Number((hash >> BigInt(offset)) & 0xffffn) / 0xffff;
}

/** Every visual trait of a Dudle; the renderer treats them as opaque. */
export interface DudleSpec {
  /** Body hue, 0..<1 around the colour wheel. */
  bodyHue: number;
  /** Body radius multiplier, 0.92...1.08. */
  sizeWobble: number;
  /** Eye separation as a fraction of body radius, 0.45...0.75. */
  eyeSpacing: number;
  /** Eye radius multiplier, 0.85...1.15. */
  eyeScale: number;
  /** Cheek blush strength, 0...1. */
  blush: number;
  /** Resting squish (width over height), 0.94...1.06. */
  squish: number;
  /** Specular highlight angle in radians, 0..<2pi. */
  highlightAngle: number;
}

/** Derive a Dudle's look from a soul ID. Pure and deterministic. */
export function deriveDudle(soulId: string): DudleSpec {
  const h1 = stableHash64(soulId);
  // Extra independent bits from a salted rehash of the same function.
  const h2 = stableHash64(`dudle-v1::${soulId}`);
  return {
    bodyHue: unit(h1, 0),
    sizeWobble: 0.92 + 0.16 * unit(h1, 16),
    eyeSpacing: 0.45 + 0.3 * unit(h1, 32),
    eyeScale: 0.85 + 0.3 * unit(h1, 48),
    blush: unit(h2, 0),
    squish: 0.94 + 0.12 * unit(h2, 16),
    highlightAngle: 2 * Math.PI * unit(h2, 32),
  };
}

/** The derived body hue in whole degrees, 0..359: what a soul with no declared colour shows. */
export function derivedHue(soulId: string): number {
  return Math.round(deriveDudle(soulId).bodyHue * 360) % 360;
}

/**
 * The one way a soul's Dudle is drawn: derived from its agent ID, with the
 * hue the soul declares (soul.json `appearance.hue`, degrees 0..359) over
 * the derived one when it has one.
 */
export function dudleFor(soul: { agentId: string; hue?: number }): DudleSpec {
  const spec = deriveDudle(soul.agentId);
  return soul.hue === undefined ? spec : { ...spec, bodyHue: soul.hue / 360 };
}

/**
 * Eyelid scale for the idle blink: 1 while open, dipping smoothly to 0.08
 * mid-blink, continuous at both edges of the closed window.
 */
export function blinkEyeScale(t: number, period = 3.6, closedDuration = 0.14): number {
  if (!(period > 0) || !(closedDuration > 0)) return 1;
  // JS % keeps the dividend's sign, like Swift's truncatingRemainder.
  const phase = t % period;
  if (!(phase >= 0 && phase < closedDuration)) return 1;
  const u = Math.sin((Math.PI * phase) / closedDuration);
  return 1 - 0.92 * u * u;
}

/** HSB (SwiftUI's Color(hue:saturation:brightness:)) to an sRGB string. */
export function hsb(h: number, s: number, b: number): string {
  const f = (n: number) => {
    const k = (n + h * 6) % 6;
    return Math.round(255 * (b - b * s * Math.max(0, Math.min(k, 4 - k, 1))));
  };
  return `rgb(${f(5)}, ${f(3)}, ${f(1)})`;
}
