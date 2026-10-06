import { useRef, useState } from 'react';
import { History, MessageSquare } from 'lucide-react';
import { useI18n } from '../lib/i18n';
import { displayName, type CensusRow } from '../model/census';
import { deriveDudle } from '../model/dudle';
import { menuStep, type FloatingState } from '../model/floating';
import { Dudle } from './Dudle';

interface FloatingDudleProps {
  /** The soul it shows and its quick actions act on (floatingLead). */
  lead: CensusRow | null;
  state: FloatingState;
  /** Static renders or a hidden window: no animation. */
  paused?: boolean;
  /** Who drives the screen (computerUserName); null hides the perimeter. */
  computerUser: string | null;
  /** Opens the lead's chat with its composer focused. */
  onPrompt: (lead: CensusRow) => void;
  /** Opens the lead's Audit log. */
  onHistory: (lead: CensusRow) => void;
  /**
   * Shows the floating button and its quick menu. Off by default, matching
   * the Lovable export where it is disabled; the perimeter shows either way.
   */
  showButton?: boolean;
}

/**
 * The desktop's floating companion (Lovable FloatingDudle, #122): the lead's
 * Dudle at the bottom right, drawn idle, working or awaiting (with the
 * awaiting dot), a radial quick menu, and the orange perimeter while a soul
 * drives the screen. Drag to move; click, Enter or Space opens the menu.
 * Pause/resume, toggle computer use and Stop are not offered: agent-bot has
 * no command for them yet.
 */
export function FloatingDudle({ lead, state, paused = false, computerUser, onPrompt, onHistory, showButton = false }: FloatingDudleProps) {
  const { t } = useI18n();
  const [pos, setPos] = useState({ x: 24, y: 104 }); // from bottom-right
  const [open, setOpen] = useState(false);
  const drag = useRef<{ sx: number; sy: number; px: number; py: number; moved: boolean } | null>(null);
  const btn = useRef<HTMLButtonElement>(null);
  const items = useRef<(HTMLButtonElement | null)[]>([]);

  const close = () => { setOpen(false); btn.current?.focus(); };
  const actions = lead ? [
    { icon: MessageSquare, label: t('quick.prompt'), run: () => onPrompt(lead) },
    { icon: History, label: t('quick.history'), run: () => onHistory(lead) },
  ] : [];

  return (
    <>
      {computerUser !== null && (
        <>
          <div className="perimeter pointer-events-none fixed inset-0 z-40" aria-hidden />
          <div role="status" className="pointer-events-none fixed left-1/2 top-3 z-50 flex -translate-x-1/2 items-center gap-3 rounded-full bg-warning px-4 py-1.5 text-xs font-semibold text-warning-foreground shadow-lg">
            {t('computerActive', { name: computerUser })}
          </div>
        </>
      )}
      {showButton && lead && (
        <div className="fixed z-50" style={{ right: pos.x, bottom: pos.y }} data-floating-state={state}>
          {open && (
            <ul aria-label={t('dudleMenu')} className="absolute bottom-1/2 right-1/2 m-0 list-none p-0"
              onKeyDown={(e) => {
                if (e.key === 'Escape') { e.stopPropagation(); close(); return; }
                const at = items.current.findIndex((el) => el === document.activeElement);
                const next = menuStep(e.key, at < 0 ? 0 : at, actions.length);
                if (next === null) return;
                e.preventDefault();
                items.current[next]?.focus();
              }}>
              {actions.map((a, i) => {
                const ang = Math.PI + (i * (Math.PI / 2)) / Math.max(1, actions.length - 1);
                const r = 78;
                return (
                  <li key={a.label} className="absolute" style={{ transform: `translate(${Math.cos(ang) * r}px, ${-Math.abs(Math.sin(ang)) * r}px) translate(50%, 50%)` }}>
                    <button
                      ref={(el) => { items.current[i] = el; }}
                      type="button"
                      autoFocus={i === 0}
                      onClick={() => { a.run(); setOpen(false); }}
                      aria-label={a.label}
                      title={a.label}
                      className="grid size-11 place-items-center rounded-full border border-border bg-popover text-popover-foreground shadow-lg outline-none transition-colors hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring"
                    >
                      <a.icon className="size-4" aria-hidden />
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
          <button
            ref={btn}
            type="button"
            aria-label={t('dudleMenu')}
            title={displayName(lead)}
            aria-expanded={open}
            className="relative grid size-16 cursor-grab touch-none place-items-center rounded-full border border-border bg-card shadow-xl outline-none focus-visible:ring-2 focus-visible:ring-ring active:cursor-grabbing"
            onPointerDown={(e) => {
              (e.target as Element).setPointerCapture?.(e.pointerId);
              drag.current = { sx: e.clientX, sy: e.clientY, px: pos.x, py: pos.y, moved: false };
            }}
            onPointerMove={(e) => {
              const d = drag.current;
              if (!d) return;
              const dx = e.clientX - d.sx, dy = e.clientY - d.sy;
              if (Math.abs(dx) + Math.abs(dy) > 4) d.moved = true;
              if (d.moved) setPos({ x: Math.max(8, Math.min(window.innerWidth - 72, d.px - dx)), y: Math.max(8, Math.min(window.innerHeight - 72, d.py - dy)) });
            }}
            onPointerUp={() => {
              const moved = drag.current?.moved;
              drag.current = null;
              if (!moved) setOpen((o) => !o);
            }}
            onKeyDown={(e) => {
              if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setOpen((o) => !o); }
              if (e.key === 'Escape' && open) { e.stopPropagation(); close(); }
            }}
            onContextMenu={(e) => { e.preventDefault(); setOpen(true); }}
          >
            <Dudle spec={deriveDudle(lead.agentId)} state={state} diameter={48} paused={paused} />
            {state === 'awaiting' && (
              <span className="absolute right-0 top-0 flex size-3.5" data-testid="awaiting-dot" aria-hidden>
                <span className="ping-soft absolute inline-flex size-full rounded-full bg-warning" />
                <span className="relative inline-flex size-3.5 rounded-full border-2 border-card bg-warning" />
              </span>
            )}
          </button>
        </div>
      )}
    </>
  );
}
