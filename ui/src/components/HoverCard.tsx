// The design's hover card on a desktop companion (#122, Lovable
// CompanionButton): who it is, its harness, status, team and subagents,
// from the census row. It opens on hover and on keyboard focus and closes
// on leave, blur or Escape. Lovable's role line has no census value yet.
import { useCallback, useEffect, useRef, useState } from 'react';
import { displayHarness, displayName, shortAgentId, type CensusRow } from '../model/census';
import { useI18n } from '../lib/i18n';
import type { SoulStatus } from './DesktopStatus';

/** Hover opens after a short rest, as the design's HoverCard; focus opens at once. */
export const HOVER_OPEN_MS = 300;

/** Open state and the handlers that drive it, for the avatar and its wrapper. */
export function useHoverCard(enabled = true) {
  const [open, setOpen] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const clear = () => { if (timer.current) clearTimeout(timer.current); timer.current = null; };
  useEffect(() => clear, []);
  useEffect(() => { if (!enabled) { clear(); setOpen(false); } }, [enabled]);
  const show = useCallback(() => { clear(); if (enabled) setOpen(true); }, [enabled]);
  const hide = useCallback(() => { clear(); setOpen(false); }, []);
  return {
    open: open && enabled,
    hide,
    wrapper: {
      onMouseEnter: () => { clear(); if (enabled) timer.current = setTimeout(() => setOpen(true), HOVER_OPEN_MS); },
      onMouseLeave: hide,
    },
    trigger: {
      onFocus: show,
      onBlur: hide,
      onKeyDown: (e: { key: string }) => { if (e.key === 'Escape') hide(); },
    },
  };
}

export function CompanionHoverCard({ id, soul, status, statusText, lead, subagents }: {
  id: string; soul: CensusRow; status: SoulStatus; statusText: string;
  /** The team's lead for a subagent; null for a lead or a solo companion. */
  lead: CensusRow | null;
  /** Subagents beneath this companion. */
  subagents: number;
}) {
  const { t } = useI18n();
  const team = lead ? displayName(lead) : subagents > 0 ? t('hover.lead') : t('team.none');
  const subs = subagents === 0 ? t('hover.noSubagents') : subagents === 1 ? t('team.countOne') : t('team.countMany', { count: subagents });
  return (
    <div id={id} role="tooltip" data-status={status}
      className="pointer-events-none absolute top-full left-1/2 z-40 mt-2 w-56 -translate-x-1/2 rounded-lg border border-border bg-popover p-3 text-left text-popover-foreground shadow-xl">
      <p className="m-0 truncate text-sm font-semibold">{displayName(soul)}</p>
      <p className="m-0 truncate font-mono text-[11px] text-muted-foreground">{displayHarness(soul)} · {shortAgentId(soul)}</p>
      <dl className="m-0 mt-2 grid grid-cols-[auto_1fr] gap-x-2 gap-y-0.5 text-[11px]">
        <dt className="text-muted-foreground">{t('hover.status')}</dt><dd className="m-0 truncate">{statusText}</dd>
        <dt className="text-muted-foreground">{t('hover.teamLabel')}</dt><dd className="m-0 truncate">{team}</dd>
        <dt className="text-muted-foreground">{t('hover.subagents')}</dt><dd className="m-0 truncate">{subs}</dd>
        <dt className="text-muted-foreground">{t('hover.account')}</dt><dd className="m-0 truncate font-mono">{soul.account}</dd>
      </dl>
    </div>
  );
}
