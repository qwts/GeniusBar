import type { DudleSpec } from '../model/dudle';

/** What the Dudle is doing; drives its CSS animation (styles.css `dudle-*`). */
export type DudleState = 'idle' | 'working' | 'awaiting' | 'offline';

interface DudleProps {
  spec: DudleSpec;
  diameter?: number;
  /** Set while the popup is hidden or for static renders: no animation. */
  paused?: boolean;
  /** Accessible name; omitted keeps the avatar decorative in a labelled row. */
  label?: string;
  /** Faded, for a companion that has left (R6). Same as state 'offline'. */
  dim?: boolean;
  state?: DudleState;
}

/**
 * The Dudle, drawn as Lovable's design: a wide round body with a sheen,
 * dark eyes with white glints, and blush. The hue comes from the soul's
 * agent ID (deriveDudle), so a soul keeps its colour, unless the soul
 * declares one (dudleFor, #64). Breathe,
 * blink, bounce (awaiting) and glance (working) are CSS animations that
 * stop under reduced motion or while paused.
 */
export function Dudle({ spec, diameter = 28, paused = false, label, dim = false, state = 'idle' }: DudleProps) {
  const a11y = label ? { role: 'img' as const, 'aria-label': label } : { 'aria-hidden': true as const };
  const shown: DudleState = dim ? 'offline' : state;
  const off = shown === 'offline';
  const hue = Math.round(spec.bodyHue * 360);
  return (
    <svg
      className="dudle shrink-0"
      data-state={shown}
      data-paused={paused ? 'true' : undefined}
      width={diameter}
      height={diameter}
      viewBox="0 0 40 40"
      {...a11y}
    >
      <g className="dudle-body" opacity={off ? 0.4 : 1}>
        <ellipse data-part="body" cx="20" cy="22" rx="17" ry="15.5" fill={`hsl(${hue} 70% ${off ? 45 : 62}%)`} />
        <ellipse cx="13" cy="15" rx="4" ry="2.4" fill="hsl(0 0% 100% / 0.5)" />
        <g className="dudle-eyes">
          <ellipse data-part="eye" cx="14.5" cy="21" rx="3.6" ry="4.4" fill="hsl(30 20% 8%)" />
          <ellipse data-part="eye" cx="25.5" cy="21" rx="3.6" ry="4.4" fill="hsl(30 20% 8%)" />
          <g className="dudle-pupils">
            <circle cx="15.6" cy="19.4" r="1.2" fill="hsl(0 0% 100%)" />
            <circle cx="26.6" cy="19.4" r="1.2" fill="hsl(0 0% 100%)" />
          </g>
        </g>
        <ellipse data-part="cheek" cx="10" cy="27" rx="2.4" ry="1.3" fill={`hsl(${hue + 330} 80% 70% / 0.6)`} />
        <ellipse data-part="cheek" cx="30" cy="27" rx="2.4" ry="1.3" fill={`hsl(${hue + 330} 80% 70% / 0.6)`} />
      </g>
    </svg>
  );
}
