// Where a menu, hover card or tooltip goes so the window never cuts it off
// (#262). The design's menus are Radix popovers with collisionPadding={8}:
// a menu hangs from its trigger, flips to the other side when that side has
// no room, then shifts to stay inside the viewport with 8 px to spare.
// Radix is not a dependency, so this is that arithmetic by hand, with a
// hook that applies it to an element rendered through a portal to the
// body with `position: fixed`, so no card, panel or scrolling pane clips it.
import { useLayoutEffect, useRef, useState, type CSSProperties, type RefObject } from 'react';

/** The room a floating element keeps from the viewport's edges, as Radix's collisionPadding={8}. */
export const COLLISION_PADDING = 8;

export interface Box { left: number; top: number; width: number; height: number }
export interface Size { width: number; height: number }
/** A point in viewport pixels (a contextmenu event's clientX / clientY). */
export interface Point { x: number; y: number }
export type Side = 'top' | 'bottom';
export type Align = 'start' | 'center' | 'end';

export interface Placement { left: number; top: number; side: Side }

/**
 * The top-left that keeps a box of `box`'s size inside the viewport with
 * `padding` to spare, shifting it as little as possible. A box bigger than
 * the room there is sits at the padding on that axis, so its start (the
 * first items of a menu) stays reachable.
 */
export function keepInside(box: Box, viewport: Size, padding = COLLISION_PADDING): { left: number; top: number } {
  const maxLeft = Math.max(padding, viewport.width - padding - box.width);
  const maxTop = Math.max(padding, viewport.height - padding - box.height);
  return {
    left: Math.min(Math.max(padding, box.left), maxLeft),
    top: Math.min(Math.max(padding, box.top), maxTop),
  };
}

export interface PlaceOptions {
  /** Which side of the anchor the box hangs on; it flips when that side has no room and the other has. */
  side?: Side;
  /** How the box lines up along the anchor's edge: its start, its centre or its end. */
  align?: Align;
  /** The gap between the anchor and the box. */
  offset?: number;
  padding?: number;
  /** Whether the box may flip sides; a context menu at the pointer only shifts. */
  flip?: boolean;
}

/**
 * Where a box of `size` goes beside `anchor` (a trigger's rect, or a 0×0
 * rect at a pointer position), as Radix places a popover: on `side`,
 * aligned, `offset` away, flipped when it would leave the viewport on that
 * side but fits on the other, then kept inside the viewport.
 */
export function placeFloating(anchor: Box, size: Size, viewport: Size,
  { side = 'bottom', align = 'center', offset = 4, padding = COLLISION_PADDING, flip = true }: PlaceOptions = {}): Placement {
  const below = anchor.top + anchor.height + offset;
  const above = anchor.top - offset - size.height;
  const fitsBelow = below + size.height <= viewport.height - padding;
  const fitsAbove = above >= padding;
  let shown = side;
  if (flip) {
    if (side === 'bottom' && !fitsBelow && fitsAbove) shown = 'top';
    else if (side === 'top' && !fitsAbove && fitsBelow) shown = 'bottom';
  }
  const left = align === 'start' ? anchor.left
    : align === 'end' ? anchor.left + anchor.width - size.width
    : anchor.left + anchor.width / 2 - size.width / 2;
  const top = shown === 'bottom' ? below : above;
  return { ...keepInside({ left, top, width: size.width, height: size.height }, viewport, padding), side: shown };
}

export interface FloatingOptions extends Omit<PlaceOptions, 'flip'> {
  /** A pointer position to open at (a right-click), in place of the anchor: shifted into view, never flipped. */
  at?: Point | null;
}

const origin: Box = { left: 0, top: 0, width: 0, height: 0 };
const same = (a: Placement | null, b: Placement) => a !== null && a.left === b.left && a.top === b.top && a.side === b.side;

/**
 * Positions a floating element beside `anchor` (or at `at`), re-measuring
 * on resize and on any scroll while it shows. Put `ref` and `style` on the
 * element and render it through a portal to the body: `style` fixes it to
 * the viewport, so a card's overflow, a scrolling pane or a transformed
 * window never clips it. `side` says where it ended up. The first render
 * is placed in a layout effect, before anything paints.
 */
export function useFloating<T extends HTMLElement>(anchor: RefObject<HTMLElement | null> | null, { at, side = 'bottom', align = 'center', offset = 4, padding }: FloatingOptions = {}) {
  const ref = useRef<T>(null);
  const [placed, setPlaced] = useState<Placement | null>(null);
  const atX = at?.x;
  const atY = at?.y;
  useLayoutEffect(() => {
    const measure = () => {
      const el = ref.current;
      if (!el) return;
      const { width, height } = el.getBoundingClientRect();
      const viewport = { width: window.innerWidth, height: window.innerHeight };
      const next = atX !== undefined && atY !== undefined
        ? placeFloating({ left: atX, top: atY, width: 0, height: 0 }, { width, height }, viewport, { side: 'bottom', align: 'start', offset: 0, padding, flip: false })
        : placeFloating(anchor?.current?.getBoundingClientRect() ?? origin, { width, height }, viewport, { side, align, offset, padding });
      setPlaced((prev) => (same(prev, next) ? prev : next));
    };
    measure();
    window.addEventListener('resize', measure);
    window.addEventListener('scroll', measure, true);
    return () => {
      window.removeEventListener('resize', measure);
      window.removeEventListener('scroll', measure, true);
    };
  }, [anchor, atX, atY, side, align, offset, padding]);
  const style: CSSProperties = { position: 'fixed', left: placed?.left ?? 0, top: placed?.top ?? 0 };
  return { ref, style, side: placed?.side ?? side };
}

/** Whether a pointer event's target is inside any of `refs`: a trigger, or the menu that floats beside it. */
export function withinAny(target: EventTarget | null, ...refs: RefObject<HTMLElement | null>[]): boolean {
  return refs.some((ref) => ref.current?.contains(target as Node | null) ?? false);
}
