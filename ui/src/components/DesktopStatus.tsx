// A companion's status on the desktop (#122): the dot on its avatar and the
// words its tooltip and hover card use. Display only, from what GeniusBar
// already reads: the census, the daemon's busy and computer-use lists, the
// pending approvals and agent-bot's pause state.
import { useId, useState } from 'react';
import type { CensusRow } from '../model/census';
import type { Translate } from '../lib/i18n';

export type SoulStatus = 'paused' | 'awaiting' | 'working' | 'asleep' | 'idle' | 'offline';

export interface StatusInputs {
  /** Agent IDs mid-turn (daemon status `busy`). */
  busy: ReadonlySet<string>;
  /** Agent IDs driving the screen. */
  computerUse: ReadonlySet<string>;
  /** Agent IDs with a proposal waiting on the owner. */
  awaiting: ReadonlySet<string>;
  /** agent-bot reports the companions paused (fleet-wide, as the design's pause). */
  fleetPaused: boolean;
}

export const noStatus: StatusInputs = { busy: new Set(), computerUse: new Set(), awaiting: new Set(), fleetPaused: false };

/**
 * Left companions are asleep when the daemon still wakes them on a message,
 * otherwise offline. Live ones are paused, then waiting on you, then
 * working, then idle — the order the floating Dudle uses.
 */
export function soulStatus(soul: CensusRow, inputs: StatusInputs): SoulStatus {
  if (soul.presence === 'left') return soul.daemonWatching ? 'asleep' : 'offline';
  if (inputs.fleetPaused) return 'paused';
  if (inputs.awaiting.has(soul.agentId)) return 'awaiting';
  const presence: string = soul.presence;
  if (inputs.busy.has(soul.agentId) || inputs.computerUse.has(soul.agentId) || presence === 'working' || presence === 'busy') return 'working';
  return 'idle';
}

/** The status in the menu's words; idle and offline say the census presence. */
export function statusText(status: SoulStatus, soul: CensusRow, t: Translate): string {
  switch (status) {
    case 'paused': return t('status.paused');
    case 'awaiting': return t('status.awaiting');
    case 'working': return t('status.working');
    case 'asleep': return t('status.asleep');
    default: return t(`presence.${soul.presence}`);
  }
}

// Inline colours rather than the badge classes, so the dot is never taken
// for a comms or computer-use badge.
const tone: Record<SoulStatus, string> = {
  paused: 'color-mix(in oklch, var(--secondary-foreground) 60%, transparent)',
  awaiting: 'var(--warning)',
  working: 'var(--primary)',
  asleep: 'color-mix(in oklch, var(--muted-foreground) 60%, transparent)',
  idle: 'var(--success)',
  offline: 'color-mix(in oklch, var(--muted-foreground) 30%, transparent)',
};

/**
 * The status dot with its tooltip. Pointer hover shows the tooltip; the
 * avatar's label and hover card carry the same words for the keyboard.
 */
export function StatusDot({ status, text }: { status: SoulStatus; text: string }) {
  const [tip, setTip] = useState(false);
  const id = useId();
  return (
    <span className="absolute -bottom-1 -left-1.5" onPointerEnter={() => setTip(true)} onPointerLeave={() => setTip(false)}
      onMouseEnter={() => setTip(true)} onMouseLeave={() => setTip(false)}>
      <span data-status={status} aria-describedby={tip ? id : undefined}
        className="block size-2.5 rounded-full ring-2 ring-card" style={{ background: tone[status] }} />
      {tip && (
        <span id={id} role="tooltip"
          className="pointer-events-none absolute top-full left-1/2 z-40 mt-1 -translate-x-1/2 rounded bg-popover px-1.5 py-0.5 text-[11px] whitespace-nowrap text-popover-foreground shadow-lg">
          {text}
        </span>
      )}
    </span>
  );
}
