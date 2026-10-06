import { useCallback, useEffect, useRef, useState } from 'react';
import { History, MessageSquare, MousePointer2, OctagonX, Pause, Play } from 'lucide-react';
import { computerUseSupported, type ComputerUseSwitch, type SoulStopResult } from '../bridge';
import { useI18n } from '../lib/i18n';
import { displayName, type CensusRow } from '../model/census';
import { deriveDudle } from '../model/dudle';
import { COMPUTER_USE_ERROR_MS, computerUseToggle, HALT_HOLD_MS, menuStep, pauseQuickAction, settleStop, STOP_SETTLE_MS, stopTargets, type FloatingState, type StopPhase } from '../model/floating';
import { Dudle } from './Dudle';

/**
 * Halting a soul's turn (agent-bot `soul stop`, agent-bot-identity #474).
 * `supported` is asked once; an older bundle without the command answers
 * false and the perimeter offers no Stop.
 */
export interface Stopper {
  supported: () => Promise<boolean>;
  stop: (agentId: string) => Promise<SoulStopResult>;
}

interface FloatingDudleProps {
  /** The soul it shows and its quick actions act on (floatingLead). */
  lead: CensusRow | null;
  state: FloatingState;
  /** Static renders or a hidden window: no animation. */
  paused?: boolean;
  /** Who drives the screen (computerUserName); null hides the perimeter. */
  computerUser: string | null;
  /** Agent IDs driving the screen (daemon status `computerUse`): what Stop halts. */
  computerUse?: ReadonlySet<string>;
  /** Stop and hold-Escape; absent (or an older agent-bot) offers neither. */
  stopper?: Stopper;
  /** Opens the lead's chat with its composer focused. */
  onPrompt: (lead: CensusRow) => void;
  /** Opens the lead's Audit log. */
  onHistory: (lead: CensusRow) => void;
  /** Some managed soul is paused (agent-bot `soul pause`): the item offers Resume. */
  fleetPaused?: boolean;
  /**
   * Pause all / Resume (Lovable `togglePause`); absent, or an agent-bot
   * without `soul pause`, offers no such item.
   */
  onTogglePause?: () => void;
  /**
   * The owner's per-soul computer-use switch (agent-bot `soul computer-use`,
   * agent-bot-identity #482) behind "Toggle computer use"; absent, or an
   * agent-bot without the command, offers no such item.
   */
  computerUseSwitch?: ComputerUseSwitch;
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
 * The perimeter's Stop, and holding Escape ~0.6 s, halt the souls driving
 * the screen through agent-bot `soul stop`; it shows "stopping…" until the
 * daemon drops them. The menu's Pause all / Resume item (when
 * `onTogglePause` is given) acts on the whole fleet through agent-bot
 * `soul pause` / `soul resume`. Its "Toggle computer use" item (when
 * `computerUseSwitch` is given and agent-bot has the command) turns the
 * lead's computer use off (agent-bot then denies its computer-use proposals
 * and stops its screen session) or back on, through agent-bot
 * `soul computer-use`, which asks the owner.
 */
export function FloatingDudle({ lead, state, paused = false, computerUser, computerUse, stopper, onPrompt, onHistory, fleetPaused = false, onTogglePause, computerUseSwitch, showButton = false }: FloatingDudleProps) {
  const { t } = useI18n();
  const stop = useStop(stopper, computerUse);
  const leadComputerUse = useLeadComputerUse(computerUseSwitch);
  const driven = computerUser !== null;
  useHoldEscape(driven && stop.offered, stop.halt);
  const [pos, setPos] = useState({ x: 24, y: 104 }); // from bottom-right
  const [open, setOpen] = useState(false);
  const drag = useRef<{ sx: number; sy: number; px: number; py: number; moved: boolean } | null>(null);
  const btn = useRef<HTMLButtonElement>(null);
  const items = useRef<(HTMLButtonElement | null)[]>([]);

  const close = () => { setOpen(false); btn.current?.focus(); };
  const pause = pauseQuickAction(fleetPaused);
  const actions = lead ? [
    { icon: MessageSquare, label: t('quick.prompt'), run: () => onPrompt(lead) },
    ...(onTogglePause ? [{ icon: pause.icon === 'play' ? Play : Pause, label: t(pause.label), run: onTogglePause }] : []),
    ...(leadComputerUse.offered ? [{ icon: MousePointer2, label: t('quick.computer'), run: () => { void leadComputerUse.toggle(lead.agentId); } }] : []),
    { icon: History, label: t('quick.history'), run: () => onHistory(lead) },
  ] : [];

  return (
    <>
      {computerUser !== null && (
        <>
          <div className="perimeter pointer-events-none fixed inset-0 z-40" aria-hidden />
          <div role={stop.offered ? 'alert' : 'status'} className="pointer-events-none fixed left-1/2 top-3 z-50 flex -translate-x-1/2 items-center gap-3 rounded-full bg-warning px-4 py-1.5 text-xs font-semibold text-warning-foreground shadow-lg">
            {stop.offered ? t('computerActiveStop', { name: computerUser }) : t('computerActive', { name: computerUser })}
            {stop.offered && (
              <button type="button" onClick={() => { void stop.halt(); }} disabled={stop.phase.phase === 'stopping'}
                className="pointer-events-auto flex min-h-7 items-center gap-1 rounded-full bg-warning-foreground px-3 py-0.5 text-warning outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-70">
                <OctagonX className="size-3.5" aria-hidden /> {stop.phase.phase === 'stopping' ? t('stopping') : t('stop')}
              </button>
            )}
          </div>
          {stop.offered && stop.phase.phase === 'failed' && (
            <p className="pointer-events-none fixed left-1/2 top-12 z-50 m-0 -translate-x-1/2 rounded-md bg-card px-3 py-1 text-xs text-destructive shadow-lg">
              {t('stopFailed', { message: stop.phase.message })}
            </p>
          )}
        </>
      )}
      {showButton && lead && (
        <div className="fixed z-50" style={{ right: pos.x, bottom: pos.y }} data-floating-state={state}>
          {leadComputerUse.failure && (
            <p role="alert" className="pointer-events-none absolute bottom-full right-0 m-0 mb-2 w-max max-w-xs rounded-md bg-card px-3 py-1 text-xs text-destructive shadow-lg">
              {t('computerUse.failed', { message: leadComputerUse.failure })}
            </p>
          )}
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

/**
 * The perimeter's Stop: probes `stopper` once, halts every soul driving the
 * screen, and holds "stopping…" until the daemon drops them (or
 * STOP_SETTLE_MS passes). A rejection shows its message; one that says the
 * bundle has no `soul stop` hides Stop instead.
 */
function useStop(stopper: Stopper | undefined, computerUse: ReadonlySet<string> | undefined) {
  const [supported, setSupported] = useState(false);
  const [phase, setPhase] = useState<StopPhase>({ phase: 'ready' });
  const live = useRef({ phase, computerUse, stopper });
  live.current = { phase, computerUse, stopper };

  useEffect(() => {
    setSupported(false);
    if (!stopper) return;
    let current = true;
    stopper.supported().then((ok) => { if (current) setSupported(ok); }, () => {});
    return () => { current = false; };
  }, [stopper]);

  useEffect(() => {
    const next = settleStop(phase, computerUse);
    if (next !== phase) setPhase(next);
  }, [phase, computerUse]);

  useEffect(() => {
    if (phase.phase !== 'stopping') return;
    const timer = setTimeout(() => setPhase({ phase: 'ready' }), STOP_SETTLE_MS);
    return () => clearTimeout(timer);
  }, [phase]);

  const halt = useCallback(async () => {
    const { phase: now, computerUse: driving, stopper: stopWith } = live.current;
    const agentIds = stopTargets(driving);
    if (!stopWith || now.phase === 'stopping' || agentIds.length === 0) return;
    const stopping: StopPhase = { phase: 'stopping', agentIds };
    live.current.phase = stopping;
    setPhase(stopping);
    try {
      await Promise.all(agentIds.map((id) => stopWith.stop(id)));
    } catch (error) {
      const e = error as { code?: unknown; message?: unknown };
      if (e?.code === 'soul-stop-unsupported') setSupported(false);
      setPhase({ phase: 'failed', message: typeof e?.message === 'string' ? e.message : String(error) });
    }
  }, []);

  return { offered: supported && stopper !== undefined, phase, halt };
}

/**
 * "Toggle computer use": probes `sw` once, then reads the lead's switch
 * fresh from agent-bot and flips it. A failure shows its message for
 * COMPUTER_USE_ERROR_MS; one that says the bundle has no `soul
 * computer-use` hides the item instead.
 */
function useLeadComputerUse(sw: ComputerUseSwitch | undefined) {
  const [supported, setSupported] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const busy = useRef(false);

  useEffect(() => {
    setSupported(false);
    if (!sw) return;
    let current = true;
    computerUseSupported(sw).then((ok) => { if (current) setSupported(ok); }, () => {});
    return () => { current = false; };
  }, [sw]);

  useEffect(() => {
    if (!failure) return;
    const timer = setTimeout(() => setFailure(null), COMPUTER_USE_ERROR_MS);
    return () => clearTimeout(timer);
  }, [failure]);

  const toggle = useCallback(async (agentId: string) => {
    if (!sw || busy.current) return;
    busy.current = true;
    setFailure(null);
    try {
      const action = computerUseToggle(await sw.read(agentId));
      if (!action) throw new Error('agent-bot gave no computer-use setting');
      await sw.set(agentId, action === 'on');
    } catch (error) {
      const e = error as { code?: unknown; message?: unknown };
      if (e?.code === 'soul-computer-use-unsupported') setSupported(false);
      else setFailure(typeof e?.message === 'string' ? e.message : String(error));
    } finally {
      busy.current = false;
    }
  }, [sw]);

  return { offered: supported && sw !== undefined, failure, toggle };
}

/**
 * Holding Escape HALT_HOLD_MS while `active` runs `halt` once per hold. A
 * quick press still closes menus as before (nothing is prevented), and the
 * window listens in capture so a menu's own Escape handling does not hide
 * the hold.
 */
function useHoldEscape(active: boolean, halt: () => Promise<void>) {
  useEffect(() => {
    if (!active) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let held = false;
    const release = () => { clearTimeout(timer); timer = undefined; held = false; };
    const down = (e: KeyboardEvent) => {
      if (e.key !== 'Escape' || held) return;
      held = true;
      timer = setTimeout(() => { timer = undefined; void halt(); }, HALT_HOLD_MS);
    };
    const up = (e: KeyboardEvent) => { if (e.key === 'Escape') release(); };
    window.addEventListener('keydown', down, true);
    window.addEventListener('keyup', up, true);
    window.addEventListener('blur', release);
    return () => {
      window.removeEventListener('keydown', down, true);
      window.removeEventListener('keyup', up, true);
      window.removeEventListener('blur', release);
      release();
    };
  }, [active, halt]);
}
