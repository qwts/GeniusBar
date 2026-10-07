import { useEffect, useId, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type ReactNode, type RefObject } from 'react';
import { Eye, LayoutGrid, Pause, Plus, Search } from 'lucide-react';
import { useI18n } from '../lib/i18n';
import { badgeText } from '../model/approvals';
import { allSouls, displayHarness, displayName, soulKey, type CensusRow, type SoulNode } from '../model/census';
import { SoulDudle } from './FleetList';

/** Closes on a pointer down outside `ref` while `open`. */
function useClickAway(ref: RefObject<HTMLElement | null>, open: boolean, close: () => void) {
  useEffect(() => {
    if (!open) return;
    const away = (e: PointerEvent) => { if (!ref.current?.contains(e.target as Node)) close(); };
    document.addEventListener('pointerdown', away);
    return () => document.removeEventListener('pointerdown', away);
  }, [ref, open, close]);
}

/**
 * Window mode's menu bar, drawn as Lovable's: the app name and a View menu
 * on the left; the GeniusBar item (whose menu drops down as a popover),
 * the jump palette and the clock on the right. Escape or a click outside
 * closes a menu. ⌘K opens the palette. While companions are paused
 * (agent-bot `soul pause`), the design's "Companions paused" chip leads
 * the right side; clicking it resumes them.
 */
export function MenuBar({ open, onOpenChange, tone, title, attention = null, onReset, unread, approvals = 0, forest, paused, onJump, fleetPaused = false, onResume, onLaunch, hiddenCount = 0, onShowAll, children }: {
  open: boolean; onOpenChange: (open: boolean) => void; tone: string; title: string;
  attention?: { text: string; isError: boolean } | null; onReset: () => void;
  /** Unread messages across the fleet, badged on the GeniusBar item. */
  unread: number;
  /** Proposals waiting on the owner, badged on the G as the design does. */
  approvals?: number;
  forest: readonly SoulNode[]; paused: boolean; onJump: (soul: CensusRow) => void;
  /** Some managed soul is paused; shows the chip when `onResume` is given too. */
  fleetPaused?: boolean;
  /** Resumes the paused companions (Lovable `togglePause` while paused). */
  onResume?: () => void;
  /** Opens the launch dialog; the palette offers "Launch a companion…" when given. */
  onLaunch?: () => void;
  /** Companions hidden from the desktop; the palette offers "Show all hidden" while above zero. */
  hiddenCount?: number;
  onShowAll?: () => void;
  children: ReactNode;
}) {
  const { t, lang } = useI18n();
  const item = useRef<HTMLDivElement>(null);
  const view = useRef<HTMLDivElement>(null);
  const [viewOpen, setViewOpen] = useState(false);
  const [palette, setPalette] = useState(false);
  const closeMenu = () => onOpenChange(false);
  const closeView = () => setViewOpen(false);
  useClickAway(item, open, closeMenu);
  useClickAway(view, viewOpen, closeView);
  const badge = useId();
  const waiting = badgeText(approvals);
  const described = [waiting && t('bar.approvals', { count: approvals }), unread > 0 && t('newCount', { count: unread })]
    .filter(Boolean).join(', ');
  useEffect(() => {
    const k = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        // As the search button does: no menu stays open under the palette.
        setViewOpen(false);
        onOpenChange(false);
        setPalette((v) => !v);
      }
    };
    window.addEventListener('keydown', k);
    return () => window.removeEventListener('keydown', k);
  }, [onOpenChange]);
  const now = useClock(paused);
  const clock = new Intl.DateTimeFormat(lang, { weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }).format(now);
  const openPalette = () => { setViewOpen(false); onOpenChange(false); setPalette(true); };
  const viewItem = 'flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-xs hover:bg-accent focus-visible:bg-accent focus-visible:outline-none';

  return (
    <header className="relative z-40 flex h-8 shrink-0 items-center gap-1 bg-menubar px-2 text-[13px] text-foreground">
      <span className="flex items-center gap-1.5 px-1.5 py-0.5 font-semibold tracking-tight">
        <span className="grid size-5 place-items-center rounded bg-primary text-[11px] text-primary-foreground" aria-hidden>G</span>
        <span>GeniusBar</span>
      </span>
      <div ref={view} className="relative" onKeyDown={(e) => { if (e.key === 'Escape') setViewOpen(false); }}>
        <button type="button" aria-haspopup="menu" aria-expanded={viewOpen} onClick={() => setViewOpen(!viewOpen)}
          className={`h-7 rounded px-2 text-xs hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none ${viewOpen ? 'bg-accent' : ''}`}>
          {t('menu.view')}
        </button>
        {viewOpen && (
          <div role="menu" aria-label={t('menu.view')}
            className="absolute top-full left-0 mt-1 min-w-[14rem] rounded-md border border-border bg-popover p-1 shadow-2xl">
            <button type="button" role="menuitem" className={viewItem} onClick={openPalette}>
              <Search className="size-3.5" aria-hidden /> {t('bar.palette')}
              <span className="ml-auto pl-4 text-muted-foreground">⌘K</span>
            </button>
            <div role="separator" className="-mx-1 my-1 h-px bg-border" />
            <button type="button" role="menuitem" className={viewItem} onClick={() => { setViewOpen(false); onReset(); }}>
              <LayoutGrid className="size-3.5" aria-hidden /> {t('menu.resetLayout')}
            </button>
          </div>
        )}
      </div>
      {attention && !open && (
        <div role={attention.isError ? 'alert' : 'status'} className="min-w-0">
          <button type="button" onClick={() => onOpenChange(true)} title={attention.text}
            className={`min-h-7 max-w-[20rem] truncate rounded px-3 py-0.5 text-xs hover:bg-accent ${attention.isError ? 'text-destructive' : 'text-muted-foreground'}`}>
            {attention.text}
          </button>
        </div>
      )}
      <div className="ml-auto flex items-center gap-3 pr-1">
        {fleetPaused && onResume && (
          <button type="button" onClick={onResume} className="flex min-h-7 items-center gap-1 rounded bg-secondary px-3 py-0.5 text-secondary-foreground">
            <Pause className="size-3" aria-hidden /> {t('paused')}
          </button>
        )}
        <button type="button" onClick={onReset} title={t('menu.resetLayout')} aria-label={t('menu.resetLayout')}
          className="rounded p-0.5 text-foreground hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none">
          <LayoutGrid className="size-4" aria-hidden />
        </button>
        <div ref={item} className="relative" onKeyDown={(e) => { if (e.key === 'Escape') onOpenChange(false); }}>
          <button
            type="button"
            aria-expanded={open}
            aria-haspopup="dialog"
            aria-label={t('bar.menu')}
            aria-describedby={described ? badge : undefined}
            title={title}
            onClick={() => onOpenChange(!open)}
            className={`flex h-6 items-center gap-1 rounded px-1 hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none ${open ? 'bg-accent' : ''}`}
          >
            <span className="grid size-4 place-items-center rounded-[4px] bg-foreground text-[10px] font-bold text-background" aria-hidden>G</span>
            {waiting && (
              <span title={t('bar.approvals', { count: approvals })} aria-hidden className="grid min-w-4 place-items-center rounded-full bg-warning px-1 font-mono text-[10px] font-bold leading-4 text-warning-foreground">
                {waiting}
              </span>
            )}
            <span className={`dot dot-${tone}`} aria-hidden />
            {unread > 0 && (
              <span title={t('newCount', { count: unread })} aria-hidden className="grid min-w-4 place-items-center rounded-full bg-warning px-1 font-mono text-[10px] font-bold leading-4 text-warning-foreground">
                {unread}
              </span>
            )}
          </button>
          {described && <span id={badge} hidden>{described}</span>}
          {open && (
            <div role="dialog" aria-label={t('bar.menu')}
              className="absolute top-full right-0 mt-1.5 flex max-h-[calc(100vh-3rem)] w-[22rem] flex-col overflow-y-auto rounded-lg border border-border bg-popover shadow-2xl">
              {children}
            </div>
          )}
        </div>
        <button type="button" aria-label={t('bar.palette')} onClick={openPalette}
          className="rounded p-0.5 text-foreground hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none">
          <Search className="size-4" aria-hidden />
        </button>
        <time className="pl-1 text-foreground" dateTime={now.toISOString()}>{clock}</time>
      </div>
      {palette && <Palette forest={forest} paused={paused} onClose={() => setPalette(false)}
        onJump={(soul) => { setPalette(false); onJump(soul); }}
        onLaunch={onLaunch && (() => { setPalette(false); onLaunch(); })}
        onShowAll={onShowAll && hiddenCount > 0 ? () => { setPalette(false); onShowAll(); } : undefined}
        hiddenCount={hiddenCount} />}
    </header>
  );
}

/** The current minute; static renders keep the first. */
function useClock(paused: boolean): Date {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    if (paused) return;
    // Back from hidden: show the time now, not when it was hidden.
    setNow(new Date());
    const i = setInterval(() => setNow(new Date()), 15_000);
    return () => clearInterval(i);
  }, [paused]);
  return now;
}

type PaletteOption = { key: string; id: string; run: () => void };
type PaletteAction = { key: string; label: string; icon: typeof Plus; run: () => void };

/**
 * ⌘K jump-to-companion palette, grouped by team, with the launch and
 * show-all actions below the companions. A combobox: the arrow keys move
 * the highlight (`aria-activedescendant`), Enter picks it, typing filters.
 */
function Palette({ forest, paused, onClose, onJump, onLaunch, onShowAll, hiddenCount }: {
  forest: readonly SoulNode[]; paused: boolean; onClose: () => void; onJump: (soul: CensusRow) => void;
  onLaunch?: () => void; onShowAll?: () => void; hiddenCount: number;
}) {
  const { t } = useI18n();
  const [q, setQ] = useState('');
  const [active, setActive] = useState(0);
  const box = useRef<HTMLDivElement>(null);
  const ids = useId();
  useClickAway(box, true, onClose);
  // A modal: focus returns where it was when the palette closes.
  // Read while rendering, before the search box takes focus.
  const [before] = useState(() => document.activeElement as HTMLElement | null);
  useEffect(() => () => before?.focus(), [before]);
  const query = q.trim().toLowerCase();
  const match = (s: CensusRow) => !query || `${displayName(s)} ${displayHarness(s)} ${s.agentId}`.toLowerCase().includes(query);
  const teams = forest
    .map((node) => ({ key: soulKey(node.soul), heading: displayName(node.soul), souls: allSouls([node]).filter(match) }))
    .filter((team) => team.souls.length > 0);
  const actions: PaletteAction[] = [];
  if (onLaunch) actions.push({ key: 'launch', label: t('bar.launch'), icon: Plus, run: onLaunch });
  if (onShowAll) actions.push({ key: 'showAll', label: t('bar.showAll', { count: hiddenCount }), icon: Eye, run: onShowAll });
  const shownActions = actions.filter((a) => !query || a.label.toLowerCase().includes(query));
  // Ids by position: roster keys can hold characters an id should not.
  const options: PaletteOption[] = [
    ...teams.flatMap((team) => team.souls.map((soul) => ({ key: `soul:${soulKey(soul)}`, run: () => onJump(soul) }))),
    ...shownActions.map((a) => ({ key: `action:${a.key}`, run: a.run })),
  ].map((o, i) => ({ ...o, id: `${ids}-option-${i}` }));
  const current = options.length > 0 ? Math.min(active, options.length - 1) : -1;
  const activeId = current >= 0 ? options[current].id : undefined;
  useEffect(() => {
    if (activeId) document.getElementById(activeId)?.scrollIntoView?.({ block: 'nearest' });
  }, [activeId]);
  const onInputKey = (e: ReactKeyboardEvent<HTMLInputElement>) => {
    if (options.length === 0) return;
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      const step = e.key === 'ArrowDown' ? 1 : -1;
      setActive((current + step + options.length) % options.length);
    } else if (e.key === 'Home' || e.key === 'End') {
      e.preventDefault();
      setActive(e.key === 'Home' ? 0 : options.length - 1);
    } else if (e.key === 'Enter' && !e.nativeEvent.isComposing) {
      e.preventDefault();
      options[current].run();
    }
  };
  const option = (key: string, children: ReactNode) => {
    const index = options.findIndex((o) => o.key === key);
    const { id, run } = options[index];
    const selected = index === current;
    return (
      <div key={key} id={id} role="option" aria-selected={selected}
        onMouseMove={() => { if (!selected) setActive(index); }}
        // Keep focus in the search box; the click still picks.
        onMouseDown={(e) => e.preventDefault()}
        onClick={run}
        className={`flex w-full cursor-default items-center gap-2 rounded px-2 py-1.5 text-left text-sm ${selected ? 'bg-accent' : ''}`}>
        {children}
      </div>
    );
  };
  const listId = `${ids}-list`;
  return (
    <div className="fixed inset-0 z-50 grid place-items-start justify-center bg-black/50 pt-[15vh]">
      <div ref={box} role="dialog" aria-modal="true" aria-label={t('bar.palette')}
        onKeyDown={(e) => {
          if (e.key === 'Escape') onClose();
          if (e.key === 'Tab') trapTab(e, box.current);
        }}
        className="w-[30rem] max-w-[calc(100vw-2rem)] overflow-hidden rounded-lg border border-border bg-popover shadow-2xl">
        <div className="flex items-center gap-2 border-b border-border px-3">
          <Search className="size-4 text-muted-foreground" aria-hidden />
          <input autoFocus value={q} onChange={(e) => { setQ(e.target.value); setActive(0); }} onKeyDown={onInputKey}
            placeholder={t('bar.search')} aria-label={t('bar.search')}
            role="combobox" aria-expanded="true" aria-controls={listId} aria-autocomplete="list" aria-activedescendant={activeId}
            className="h-11 flex-1 bg-transparent text-sm outline-none placeholder:text-muted-foreground" />
        </div>
        <div className="max-h-80 overflow-y-auto p-1">
          {options.length === 0 && <p className="py-6 text-center text-sm text-muted-foreground">{t('bar.noResults')}</p>}
          <div id={listId} role="listbox" aria-label={t('bar.palette')}>
            {teams.map((team) => (
              <div key={team.key} role="group" aria-label={team.heading}>
                <h3 aria-hidden className="m-0 px-2 pb-1 pt-2 text-xs font-medium text-muted-foreground">{team.heading}</h3>
                {team.souls.map((soul) => option(`soul:${soulKey(soul)}`, (
                  <>
                    <SoulDudle soul={soul} size={18} paused={paused} />
                    <span>{displayName(soul)}</span>
                    <span className="font-mono text-xs text-muted-foreground">{displayHarness(soul)}</span>
                    <span className="ml-auto text-xs text-muted-foreground">{t(`presence.${soul.presence}`)}</span>
                  </>
                )))}
              </div>
            ))}
            {shownActions.length > 0 && (
              <div role="group" aria-label={t('bar.actions')}>
                {teams.length > 0 && <div role="presentation" className="-mx-1 my-1 h-px bg-border" />}
                <h3 aria-hidden className="m-0 px-2 pb-1 pt-2 text-xs font-medium text-muted-foreground">{t('bar.actions')}</h3>
                {shownActions.map((a) => option(`action:${a.key}`, (
                  <><a.icon className="size-4 text-muted-foreground" aria-hidden /><span>{a.label}</span></>
                )))}
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

/** Keeps Tab and Shift+Tab inside `root`, wrapping at either end. */
function trapTab(e: ReactKeyboardEvent, root: HTMLElement | null) {
  const stops = root ? [...root.querySelectorAll<HTMLElement>('input, button, [tabindex]:not([tabindex="-1"])')] : [];
  if (stops.length === 0) return;
  const first = stops[0];
  const last = stops[stops.length - 1];
  if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
  else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
}
