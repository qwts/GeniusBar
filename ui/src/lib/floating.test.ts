import { describe, expect, it } from 'vitest';
import { COLLISION_PADDING, keepInside, placeFloating } from './floating';

const viewport = { width: 400, height: 300 };

describe('keepInside (Radix collisionPadding={8}, #262)', () => {
  it('leaves a box that fits where it is', () => {
    expect(keepInside({ left: 50, top: 60, width: 100, height: 80 }, viewport)).toEqual({ left: 50, top: 60 });
  });

  it('shifts a box past an edge back in, with the padding to spare', () => {
    expect(COLLISION_PADDING).toBe(8);
    expect(keepInside({ left: 350, top: 280, width: 100, height: 80 }, viewport)).toEqual({ left: 292, top: 212 });
    expect(keepInside({ left: -30, top: -5, width: 100, height: 80 }, viewport)).toEqual({ left: 8, top: 8 });
  });

  it('pins a box bigger than the viewport at the padding, so its start stays reachable', () => {
    expect(keepInside({ left: 100, top: 100, width: 500, height: 400 }, viewport)).toEqual({ left: 8, top: 8 });
  });
});

describe('placeFloating', () => {
  const anchor = { left: 100, top: 100, width: 40, height: 20 };
  const size = { width: 120, height: 60 };

  it('hangs under the anchor, aligned to its start, centre or end, the offset away', () => {
    expect(placeFloating(anchor, size, viewport, { align: 'start' })).toEqual({ left: 100, top: 124, side: 'bottom' });
    expect(placeFloating(anchor, size, viewport)).toEqual({ left: 60, top: 124, side: 'bottom' });
    expect(placeFloating(anchor, size, viewport, { align: 'end', offset: 10 })).toEqual({ left: 20, top: 130, side: 'bottom' });
  });

  it('rises above the anchor when asked, and flips to the side with room', () => {
    expect(placeFloating(anchor, size, viewport, { side: 'top', align: 'start' })).toEqual({ left: 100, top: 36, side: 'top' });
    const low = { ...anchor, top: 260 };
    expect(placeFloating(low, size, viewport, { align: 'start' })).toEqual({ left: 100, top: 196, side: 'top' });
    const high = { ...anchor, top: 10 };
    expect(placeFloating(high, size, viewport, { side: 'top', align: 'start' })).toEqual({ left: 100, top: 34, side: 'bottom' });
  });

  it('only shifts when neither side has room, or when flipping is off (a context menu at the pointer)', () => {
    // Too tall for either side: it stays below and shifts up to the padding from the bottom edge.
    const tall = { width: 120, height: 280 };
    expect(placeFloating(anchor, tall, viewport, { align: 'start' })).toEqual({ left: 100, top: 12, side: 'bottom' });
    const corner = { left: 390, top: 290, width: 0, height: 0 };
    expect(placeFloating(corner, size, viewport, { align: 'start', offset: 0, flip: false })).toEqual({ left: 272, top: 232, side: 'bottom' });
  });
});
