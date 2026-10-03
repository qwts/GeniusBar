import { useEffect, useId, useState } from 'react';
import { blinkEyeScale, hsb, type DudleSpec } from '../model/dudle';

// Seconds since 2001-01-01, the epoch R1's blink clock used, so a soul
// blinks on the same beat as it did in the Swift app.
const REFERENCE_EPOCH_MS = 978_307_200_000;
const FRAME_MS = 50; // 20 fps, as R1's TimelineView minimumInterval.

function prefersReducedMotion(): boolean {
  return typeof window.matchMedia === 'function' &&
    window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}

interface DudleProps {
  spec: DudleSpec;
  diameter?: number;
  /** Set while the popup is hidden or for static renders: eyes stay open. */
  paused?: boolean;
  /** Accessible name; omitted keeps the avatar decorative in a labelled row. */
  label?: string;
  /** Faded, for a companion that has left (R6). */
  dim?: boolean;
}

/**
 * The Dudle: a round, spongy character with big solid-black eyes, drawn
 * as SVG from the derived spec. The idle blink stops under reduced motion
 * or while paused.
 */
export function Dudle({ spec, diameter = 28, paused = false, label, dim = false }: DudleProps) {
  const gradientId = useId();
  const [blink, setBlink] = useState(1);
  const animates = !paused && !prefersReducedMotion();

  useEffect(() => {
    if (!animates) {
      setBlink(1);
      return;
    }
    const tick = () => setBlink(blinkEyeScale((Date.now() - REFERENCE_EPOCH_MS) / 1000));
    const timer = window.setInterval(tick, FRAME_MS);
    return () => window.clearInterval(timer);
  }, [animates]);

  const c = diameter / 2;
  const r = c * spec.sizeWobble;
  const eyeR = r * 0.38 * spec.eyeScale;
  const eyeY = c - r * 0.12;
  const eyeX = (r * spec.eyeSpacing) / 2;
  // Centres mirror R1's HStacks: two shapes of a given width either side
  // of the middle with the given spacing between them.
  const eyeDx = eyeR + eyeX * 0.3;
  const cheekDx = eyeR * 0.45 + eyeX / 2;
  const cheekY = eyeY + eyeR * 1.1;
  const hx = c + Math.cos(spec.highlightAngle) * r * 0.35;
  const hy = c + Math.sin(spec.highlightAngle) * r * 0.35;
  const a11y = label ? { role: 'img', 'aria-label': label } : { 'aria-hidden': true };

  return (
    <svg
      className="dudle"
      width={diameter}
      height={diameter}
      viewBox={`0 0 ${diameter} ${diameter}`}
      overflow="visible"
      opacity={dim ? 0.45 : undefined}
      {...a11y}
    >
      <defs>
        <radialGradient id={gradientId} gradientUnits="userSpaceOnUse" cx={c} cy={c} r={r}>
          <stop offset={0.1} stopColor={hsb(spec.bodyHue, 0.55, 0.98)} />
          <stop offset={1} stopColor={hsb(spec.bodyHue, 0.65, 0.82)} />
        </radialGradient>
      </defs>
      <ellipse cx={c} cy={c} rx={r * spec.squish} ry={r / spec.squish} fill={`url(#${gradientId})`} />
      <ellipse cx={hx} cy={hy} rx={r * 0.225} ry={r * 0.14} fill="#fff" fillOpacity={0.55} />
      {spec.blush > 0.35 &&
        [-cheekDx, cheekDx].map((dx) => (
          <ellipse
            key={dx}
            data-part="cheek"
            cx={c + dx}
            cy={cheekY}
            rx={eyeR * 0.45}
            ry={eyeR * 0.3}
            fill="#ff2d55"
            fillOpacity={0.5 * spec.blush}
          />
        ))}
      {[-eyeDx, eyeDx].map((dx) => (
        <ellipse key={dx} data-part="eye" cx={c + dx} cy={eyeY} rx={eyeR} ry={eyeR * blink} fill="#000" />
      ))}
    </svg>
  );
}
