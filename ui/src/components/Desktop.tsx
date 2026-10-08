import { useContext, useEffect, useId, useMemo, useRef, useState, type PointerEvent, type ReactNode, type Ref, type RefObject } from 'react';
import { createPortal } from 'react-dom';
import { Archive, ChevronDown, Eye, EyeOff, History, Monitor, MoreHorizontal, Palette, Plus, Radio, Shield, ShieldOff, Users, X } from 'lucide-react';
import { displayName, displayRole, roleAndHarness, soulKey, type CensusRow, type SoulNode } from '../model/census';
import { companionLabel, teamKeys, teamsOf, type Team } from '../model/fleet';
import { useFloating, type Point } from '../lib/floating';
import { useI18n } from '../lib/i18n';
import { escapeStaysInside, menuKeys } from '../lib/keys';
import { noBadges, type SoulBadges } from '../model/refresh';
import { layoutActions, type DesktopLayout } from '../state/layout';
import { ProfileSourceContext } from '../useSoulProfile';
import { AuditLog } from './AuditLog';
import { CustomizeDialog } from './CustomizeDialog';
import { SoulDudle } from './FleetList';
import type { DudleState } from './Dudle';
import { CompanionHoverCard, useHoverCard } from './HoverCard';
import { soulStatus, statusText, StatusDot, type StatusInputs } from './DesktopStatus';
import { SurfaceOpenerContext } from '../surfaces/opener';

const CARD_W = 300;
/** A lead with no subagents is a slim card, as the design's solo cards. */
const SOLO_W = 200;
const GAP = 16;

/**
 * How one team's card shows under the layout: who in it is visible, whether
 * it is collapsed, and the card's size. The desktop places cards with it and
 * the popup's coordinator sizes native team windows with it (#223), before
 * the window measures its own card.
 */
export function teamCard(team: Team, layout: DesktopLayout) {
  const key = soulKey(team.lead);
  const visible = team.members.filter((m) => !layout.hidden.includes(soulKey(m.soul)));
  const collapsed = layout.collapsed.includes(key);
  const leadHidden = layout.hidden.includes(key);
  return {
    key, visible, collapsed, leadHidden,
    /** A hidden lead with nobody visible under it has no card at all. */
    shown: !(leadHidden && !visible.length),
    width: team.members.length > 0 ? CARD_W : SOLO_W,
    height: 64 + (collapsed || !visible.length ? 0 : Math.ceil(visible.length / 4) * 68 + 12),
  };
}

interface DesktopProps {
  forest: readonly SoulNode[];
  layout: DesktopLayout;
  paused: boolean;
  unreadOf?: (soul: CensusRow) => number;
  selectedKey: string | null;
  onOpen: (soul: CensusRow) => void;
  /** Shown in place of the teams: setup hints and the empty fleet. */
  notice?: ReactNode;
  /** Opens the launch form; without it there is no Launch button. */
  onLaunch?: () => void;
  /** The open companion's window. */
  children?: ReactNode;
  /** Avatar badges (#122): agent comms on, driving the screen. */
  badges?: SoulBadges;
  /** Asks to archive a soul (#94); without it the menu has no Remove…. */
  onArchive?: (soul: CensusRow) => void;
  /** Agent IDs with a proposal waiting on the owner, for the status dot. */
  awaiting?: ReadonlySet<string>;
  /** agent-bot reports the companions paused, for the status dot. */
  fleetPaused?: boolean;
}

const none: ReadonlySet<string> = new Set();

/**
 * Window mode's desktop (R6): every team as a card the user can drag,
 * collapse, and hide companions from. Teams nobody moved fill columns.
 */
export function Desktop({ forest, layout, paused, unreadOf, selectedKey, onOpen, notice, onLaunch, children, badges = noBadges, onArchive, awaiting = none, fleetPaused = false }: DesktopProps) {
  const { t } = useI18n();
  const ref = useRef<HTMLElement>(null);
  const [width, setWidth] = useState(1100);
  useEffect(() => {
    const el = ref.current;
    if (!el || typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(([entry]) => entry && setWidth(entry.contentRect.width));
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  const teams = useMemo(() => teamsOf(forest), [forest]);
  const status = useMemo<StatusInputs>(() => ({ busy: badges.busy, computerUse: badges.computerUse, awaiting, fleetPaused }),
    [badges, awaiting, fleetPaused]);
  // Shortest column first, as masonry, for teams without a saved position.
  const placed = useMemo(() => {
    const column = CARD_W + GAP;
    const heights = Array<number>(Math.max(1, Math.floor((width - GAP) / column))).fill(GAP);
    return teams.map((team) => {
      const { key, visible, collapsed, leadHidden, height } = teamCard(team, layout);
      const col = heights.indexOf(Math.min(...heights));
      const fallback = { x: GAP + col * column, y: heights[col] };
      heights[col] += height + GAP;
      return { team, id: key, visible, collapsed, leadHidden, pos: layout.pos[key] ?? fallback };
    });
  }, [teams, layout, width]);

  return (
    <main ref={ref} className="gb-wallpaper relative min-h-0 flex-1 overflow-auto overscroll-contain" aria-label={t('fleet')}>
      {notice ? (
        <div className="absolute inset-x-0 top-1/3 mx-auto grid max-w-sm justify-items-center gap-3 px-4 text-center text-sm text-muted-foreground">
          {notice}
        </div>
      ) : (
        placed.map(({ id, ...p }) => p.leadHidden && !p.visible.length ? null : (
          <TeamCluster key={id} {...p} paused={paused} unreadOf={unreadOf} selectedKey={selectedKey} onOpen={onOpen} badges={badges} onArchive={onArchive} status={status} />
        ))
      )}
      {onLaunch && (
        <button type="button" onClick={onLaunch}
          className="fixed bottom-4 left-4 z-10 flex items-center gap-2 rounded-full border border-dashed border-muted-foreground/50 bg-background/70 px-3 py-1.5 text-xs text-foreground backdrop-blur hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none">
          <Plus className="size-3.5" aria-hidden /> {t('launchCompanion')}
        </button>
      )}
      {!notice && <p className="pointer-events-none fixed inset-x-0 bottom-3 m-0 text-center text-xs text-muted-foreground">{t('desktopHint')}</p>}
      {children}
    </main>
  );
}

interface ClusterProps {
  team: Team;
  visible: Team['members'];
  collapsed: boolean;
  leadHidden: boolean;
  pos: { x: number; y: number };
  paused: boolean;
  unreadOf?: (soul: CensusRow) => number;
  selectedKey: string | null;
  onOpen: (soul: CensusRow) => void;
  badges: SoulBadges;
  onArchive?: (soul: CensusRow) => void;
  status: StatusInputs;
  /**
   * A native team window (#223): the card is the whole page, the window
   * moves by the title (`data-tauri-drag-region`), and nothing is absolute.
   */
  windowed?: boolean;
  cardRef?: Ref<HTMLElement>;
}

/** Subagents beneath each member: the members after it, deeper, until one is not. */
function descendants(members: Team['members']): Map<string, number> {
  const out = new Map<string, number>();
  members.forEach((m, i) => {
    let n = 0;
    for (let j = i + 1; j < members.length && members[j].depth > m.depth; j++) n++;
    out.set(soulKey(m.soul), n);
  });
  return out;
}

/**
 * One team's card. A hidden lead shows nothing of itself — no avatar, name
 * or harness — just a neutral placeholder with the subagent and hidden
 * counts, so hiding a team root hides it even when the team has visible
 * subagents to reach. Only the controls those subagents need stay.
 */
function TeamCluster({ team, visible, collapsed, leadHidden, pos, paused, unreadOf, selectedKey, onOpen, badges, onArchive, status, windowed = false, cardRef }: ClusterProps) {
  const { t } = useI18n();
  const key = soulKey(team.lead);
  const drag = useRef<{ dx: number; dy: number } | null>(null);
  const [live, setLive] = useState<{ x: number; y: number } | null>(null);
  const at = live ?? pos;
  const count = team.members.length;
  const hiddenCount = count - visible.length;
  const below = useMemo(() => descendants(team.members), [team.members]);
  const [more, setMore] = useState(false);
  const moreButton = useRef<HTMLButtonElement>(null);
  const closeMore = () => { setMore(false); moreButton.current?.focus(); };
  const subagents = count > 0 ? (count === 1 ? t('team.countOne') : t('team.countMany', { count })) : null;
  const hidden = hiddenCount > 0
    ? (hiddenCount === 1 ? t('team.hiddenOne') : t('team.hiddenMany', { count: hiddenCount }))
    : null;
  // The design's header pills: who in the team waits on you, and who works.
  const everyone = [team.lead, ...team.members.map((m) => m.soul)];
  const awaitingCount = everyone.filter((s) => status.awaiting.has(s.agentId)).length;
  const workingCount = everyone.filter((s) => !status.awaiting.has(s.agentId) && status.busy.has(s.agentId)).length;

  const onDown = (e: PointerEvent<HTMLDivElement>) => {
    if ((e.target as HTMLElement).closest('button')) return;
    drag.current = { dx: e.clientX - pos.x, dy: e.clientY - pos.y };
    e.currentTarget.setPointerCapture(e.pointerId);
  };
  const onMove = (e: PointerEvent<HTMLDivElement>) => {
    if (!drag.current) return;
    setLive({ x: Math.max(0, e.clientX - drag.current.dx), y: Math.max(0, e.clientY - drag.current.dy) });
  };
  const onUp = () => {
    if (drag.current && live) layoutActions.move(key, live.x, live.y);
    drag.current = null;
    setLive(null);
  };

  // A native window moves itself: the shell drags it from any element marked
  // as a drag region, and only that element, so the title's text is marked too.
  const dragRegion = windowed ? { 'data-tauri-drag-region': '' } : {};
  return (
    <section
      ref={cardRef}
      aria-label={leadHidden ? t('team.placeholder') : displayName(team.lead)}
      style={windowed ? { width: count > 0 ? CARD_W : SOLO_W } : { left: at.x, top: at.y, width: count > 0 ? CARD_W : SOLO_W }}
      // A native team window has no shadow of its own and is the card's size, so the card draws none either.
      className={`group rounded-xl border bg-card/75 backdrop-blur-md ${windowed ? 'relative' : 'absolute shadow-lg'} ${awaitingCount > 0 ? 'border-warning/70' : 'border-border'} ${live ? 'z-20' : ''}`}
    >
      <div {...dragRegion} {...(windowed ? {} : { onPointerDown: onDown, onPointerMove: onMove, onPointerUp: onUp, onPointerCancel: onUp })}
        className={`flex touch-none items-center gap-2 p-2 ${windowed ? '' : live ? 'cursor-grabbing' : 'cursor-grab'}`}>
        {leadHidden ? (
          <>
            <span className="grid size-10 shrink-0 place-items-center rounded-lg border border-dashed border-border text-muted-foreground" aria-hidden>
              <Users className="size-5" />
            </span>
            <div {...dragRegion} className="min-w-0 flex-1 select-none">
              <p {...dragRegion} className="m-0 truncate text-sm font-semibold">{t('team.placeholder')}</p>
              <p {...dragRegion} className="m-0 truncate font-mono text-[10px] text-muted-foreground">
                {[subagents, hidden].filter((part): part is string => part !== null).join(' · ')}
              </p>
            </div>
          </>
        ) : (
          <>
            <CompanionButton soul={team.lead} size={40} paused={paused} unread={unreadOf?.(team.lead) ?? 0}
              selected={selectedKey === key} onOpen={onOpen} bare team={count > 0 ? teamKeys(team) : undefined}
              badges={badges} onArchive={onArchive} status={status} lead={null} subagents={count} />
            <div {...dragRegion} className="min-w-0 flex-1 select-none">
              <p {...dragRegion} className="m-0 truncate text-sm font-semibold">{displayName(team.lead)}</p>
              <p {...dragRegion} className="m-0 truncate font-mono text-[10px] text-muted-foreground">
                {displayRole(team.lead)}{subagents && <> · {subagents}</>}
              </p>
            </div>
          </>
        )}
        {awaitingCount > 0 && (
          <span title={t('bar.approvals', { count: awaitingCount })} className="rounded-full bg-warning px-1.5 font-mono text-[10px] font-bold text-warning-foreground">
            <span aria-hidden>{awaitingCount}</span><span className="sr-only">{t('bar.approvals', { count: awaitingCount })}</span>
          </span>
        )}
        {workingCount > 0 && (
          <span title={t('bar.working', { count: workingCount })} className="rounded-full bg-primary/20 px-1.5 font-mono text-[10px] text-primary">
            <span aria-hidden>{workingCount}</span><span className="sr-only">{t('bar.working', { count: workingCount })}</span>
          </span>
        )}
        <div className="relative">
          <button ref={moreButton} type="button" aria-haspopup="menu" aria-expanded={more}
            aria-label={t('team.more', { name: leadHidden ? t('team.placeholder') : displayName(team.lead) })}
            onClick={() => setMore(!more)}
            // As the design, whose header ends with the pills and the chevron: shown on hover
            // and focus only, so keyboard users keep it. A hidden lead's placeholder keeps it
            // visible, since it is that card's only control.
            className={`rounded p-1 text-muted-foreground outline-none hover:bg-accent hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring ${leadHidden ? '' : 'opacity-0 group-hover:opacity-100 focus-visible:opacity-100 aria-expanded:opacity-100'}`}>
            <MoreHorizontal className="size-4" aria-hidden />
          </button>
          {more && (leadHidden ? (
            <MenuBox label={t('team.placeholder')} onClose={closeMore} align="right" anchor={moreButton}>
              {(first) => (
                <>
                  <button ref={first} type="button" role="menuitem" className={menuItem}
                    onClick={() => { setMore(false); layoutActions.setHidden(key, false); }}>
                    <Eye className="size-3.5" aria-hidden /> {t('bar.show')}
                  </button>
                  <button type="button" role="menuitem" className={menuItem}
                    onClick={() => { setMore(false); layoutActions.setTeamHidden(teamKeys(team), false); }}>
                    <Users className="size-3.5" aria-hidden /> {t('bar.showTeam')}
                  </button>
                </>
              )}
            </MenuBox>
          ) : (
            <SoulMenu soul={team.lead} team={count > 0 ? teamKeys(team) : undefined} onOpen={onOpen} onArchive={onArchive}
              onClose={closeMore} done={() => setMore(false)} align="right" anchor={moreButton} />
          ))}
        </div>
        {count > 0 && (
          <button
            type="button"
            aria-label={collapsed ? t('team.expand') : t('team.collapse')}
            aria-expanded={!collapsed}
            onClick={() => layoutActions.setCollapsed(key, !collapsed)}
            className="rounded p-1 text-muted-foreground outline-none hover:bg-accent hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
          >
            <ChevronDown className={`size-4 transition-transform ${collapsed ? '-rotate-90' : ''}`} aria-hidden />
          </button>
        )}
      </div>
      {!collapsed && visible.length > 0 && (
        <ul className="m-0 grid list-none grid-cols-4 gap-1 border-t border-border/60 p-2">
          {visible.map((m) => (
            <li key={soulKey(m.soul)}>
              <CompanionButton soul={m.soul} size={32} paused={paused} unread={unreadOf?.(m.soul) ?? 0}
                selected={selectedKey === soulKey(m.soul)} onOpen={onOpen} badges={badges} onArchive={onArchive}
                status={status} lead={team.lead} subagents={below.get(soulKey(m.soul)) ?? 0} />
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

/**
 * One team's card as a whole page: the native team window's content (#223),
 * the same card the in-window desktop draws.
 */
export function TeamCard({ team, layout, paused, unreadOf, onOpen, badges = noBadges, onArchive, awaiting = none, fleetPaused = false, cardRef }: {
  team: Team; layout: DesktopLayout; paused: boolean; unreadOf?: (soul: CensusRow) => number;
  onOpen: (soul: CensusRow) => void; badges?: SoulBadges; onArchive?: (soul: CensusRow) => void;
  awaiting?: ReadonlySet<string>; fleetPaused?: boolean; cardRef?: Ref<HTMLElement>;
}) {
  const { visible, collapsed, leadHidden } = teamCard(team, layout);
  const status = useMemo<StatusInputs>(() => ({ busy: badges.busy, computerUse: badges.computerUse, awaiting, fleetPaused }),
    [badges, awaiting, fleetPaused]);
  return (
    <TeamCluster team={team} visible={visible} collapsed={collapsed} leadHidden={leadHidden} pos={{ x: 0, y: 0 }}
      paused={paused} unreadOf={unreadOf} selectedKey={null} onOpen={onOpen} badges={badges} onArchive={onArchive}
      status={status} windowed cardRef={cardRef} />
  );
}

const menuItem = 'flex items-center gap-2 rounded-sm px-2 py-1.5 text-left hover:bg-accent focus-visible:bg-accent focus-visible:outline-none';

/**
 * A small menu that takes focus, moves it with Up / Down / Home / End (as
 * Radix ContextMenu), and closes on Escape or when focus leaves it; its
 * owner hands focus back to the trigger. Given `at`, it opens at that
 * pointer position, kept inside the viewport, as Radix ContextMenu does;
 * otherwise it hangs under its `anchor`, flipping above it when the window
 * ends there. It floats over the body (#262), so neither the card, the
 * desktop's scrolling pane nor a team window the card's size cuts it off.
 */
function MenuBox({ label, onClose, align = 'center', at, anchor, children }: {
  label: string; onClose: () => void; align?: 'center' | 'right'; at?: Point;
  /** The trigger the menu hangs from when it has no pointer position. */
  anchor: RefObject<HTMLElement | null>;
  children: (first: RefObject<HTMLButtonElement | null>) => ReactNode;
}) {
  const first = useRef<HTMLButtonElement>(null);
  const { ref, style, side } = useFloating<HTMLDivElement>(anchor, { at, align: align === 'right' ? 'end' : 'center' });
  useEffect(() => { first.current?.focus(); }, []);
  return createPortal(
    <div ref={ref} role="menu" aria-label={label} data-side={side} style={style}
      className="z-50 grid min-w-[8rem] rounded-md border border-border bg-popover p-1 text-sm shadow-md"
      onKeyDown={(e) => { if (e.key === 'Escape') { e.stopPropagation(); onClose(); } else menuKeys(e); }}
      onBlur={(e) => { if (!e.currentTarget.contains(e.relatedTarget as Node | null)) onClose(); }}>
      {children(first)}
    </div>,
    document.body,
  );
}

/**
 * Open, Customize… (right-click only, as the design's), Hide, Hide team and
 * Remove… for one companion: its right-click menu and its team's ⋯. As the
 * design, Hide on a team's lead hides the whole team; Hide team stays.
 */
function SoulMenu({ soul, team, onOpen, onCustomize, onArchive, onClose, done, align, at, anchor }: {
  soul: CensusRow; team?: readonly string[]; onOpen: (soul: CensusRow) => void; onArchive?: (soul: CensusRow) => void;
  /** Opens the Customize dialog (#64); without it the menu has no Customize…. */
  onCustomize?: () => void;
  /** Escape or focus leaving: close and hand focus back. */
  onClose: () => void;
  /** An item ran: close without moving focus. */
  done: () => void;
  align?: 'center' | 'right';
  /** A right-click's pointer position: the menu opens there. */
  at?: Point;
  /** The trigger it hangs under otherwise. */
  anchor: RefObject<HTMLElement | null>;
}) {
  const { t } = useI18n();
  return (
    <MenuBox label={displayName(soul)} onClose={onClose} align={align} at={at} anchor={anchor}>
      {(first) => (
        <>
          <button ref={first} type="button" role="menuitem" className={menuItem}
            onClick={() => { done(); onOpen(soul); }}>
            {t('bar.open')}
          </button>
          {onCustomize && (
            <button type="button" role="menuitem" aria-haspopup="dialog" className={menuItem}
              onClick={() => { done(); onCustomize(); }}>
              <Palette className="size-3.5" aria-hidden /> {t('edit.title')}
            </button>
          )}
          <button type="button" role="menuitem" className={menuItem}
            onClick={() => { done(); if (team) layoutActions.setTeamHidden(team, true); else layoutActions.setHidden(soulKey(soul), true); }}>
            <EyeOff className="size-3.5" aria-hidden /> {t('bar.hide')}
          </button>
          {team && (
            // Hide now takes the team (the design); hiding the lead alone stays here.
            <button type="button" role="menuitem" className={menuItem}
              onClick={() => { done(); layoutActions.setHidden(soulKey(soul), true); }}>
              <EyeOff className="size-3.5" aria-hidden /> {t('bar.hideOnly')}
            </button>
          )}
          {onArchive && (
            <button type="button" role="menuitem" className={`${menuItem} text-destructive`}
              onClick={() => { done(); onArchive(soul); }}>
              <Archive className="size-3.5" aria-hidden /> {t('bar.remove')}
            </button>
          )}
        </>
      )}
    </MenuBox>
  );
}

function CompanionButton({ soul, size, paused, unread, selected, onOpen, bare = false, team, badges = noBadges, onArchive, status, lead, subagents }: {
  soul: CensusRow; size: number; paused: boolean; unread: number; selected: boolean;
  onOpen: (soul: CensusRow) => void; bare?: boolean;
  /** A lead's whole team: hiding it hides the team card. */
  team?: readonly string[];
  badges?: SoulBadges;
  onArchive?: (soul: CensusRow) => void;
  status: StatusInputs;
  /** The team's lead for a subagent; null for a lead. */
  lead: CensusRow | null;
  /** Subagents beneath this companion. */
  subagents: number;
}) {
  const { t } = useI18n();
  // Open, and where: a right-click's pointer position, or null under the avatar (keyboard).
  const [menu, setMenu] = useState<false | Point | null>(false);
  const [customizing, setCustomizing] = useState(false);
  // Customize… reads agent-bot's profile; no source (a plain browser) offers none.
  const customizable = useContext(ProfileSourceContext) !== null;
  // In the app it opens in its own window (#223); without one, the dialog here.
  const openSurface = useContext(SurfaceOpenerContext);
  const customize = () => {
    if (!openSurface) { setCustomizing(true); return; }
    openSurface({ surface: 'customize', soul: soulKey(soul) }).catch(() => setCustomizing(true));
  };
  const button = useRef<HTMLButtonElement>(null);
  const card = useHoverCard(menu === false && !customizing);
  const cardId = useId();
  const comms = badges.comms.has(soul.agentId);
  const computer = badges.computerUse.has(soul.agentId);
  const state = soulStatus(soul, status);
  const said = statusText(state, soul, t);
  // The label already says the census presence; other statuses add theirs.
  const extra = state === 'idle' || state === 'offline' ? null : said;
  const label = [companionLabel(soul, t, unread), extra, comms && t('badge.comms'), computer && t('badge.computer')]
    .filter(Boolean).join(', ');
  return (
    <div className="relative" {...card.wrapper}>
      <button
        ref={button}
        type="button"
        aria-label={label}
        aria-describedby={card.open ? cardId : undefined}
        aria-current={selected ? 'true' : undefined}
        aria-haspopup="menu"
        onClick={() => onOpen(soul)}
        // As Radix ContextMenu: a right-click opens at the pointer; Shift+F10 or
        // the ContextMenu key (no pointer position) keeps it under the avatar.
        onContextMenu={(e) => { e.preventDefault(); setMenu(e.clientX || e.clientY ? { x: e.clientX, y: e.clientY } : null); }}
        {...card.trigger}
        onKeyDown={(e) => {
          card.trigger.onKeyDown(e);
          if (e.key === 'ContextMenu' || (e.key === 'F10' && e.shiftKey)) { e.preventDefault(); setMenu(null); }
        }}
        className={`flex flex-col items-center gap-0.5 rounded-lg p-1 outline-none focus-visible:ring-2 focus-visible:ring-ring ${bare ? 'shrink-0' : 'w-full'} ${selected ? 'bg-accent' : 'hover:bg-accent/50'}`}
      >
        <span className="relative">
          <SoulDudle soul={soul} size={size} paused={paused} state={state === 'awaiting' || state === 'working' ? state : undefined} />
          {unread > 0 && (
            <span className="absolute -top-1 -right-1.5 min-w-[14px] rounded-full bg-primary px-0.5 text-center font-mono text-[10px] font-bold leading-[14px] text-primary-foreground ring-2 ring-card" aria-hidden>
              {unread > 9 ? '9+' : unread}
            </span>
          )}
          {comms && (
            <span className="absolute -top-1 -left-1.5 flex size-3.5 items-center justify-center rounded-full bg-success ring-2 ring-card" aria-hidden>
              <Radio className="size-2 text-success-foreground" />
            </span>
          )}
          {computer && (
            <span className="absolute -right-1.5 -bottom-1 flex size-3.5 items-center justify-center rounded-full bg-warning ring-2 ring-card" aria-hidden>
              <Monitor className="size-2 text-warning-foreground" />
            </span>
          )}
          <StatusDot status={state} text={said} />
        </span>
        {!bare && (
          <span className={`max-w-full truncate text-[10px] ${soul.presence === 'left' ? 'text-muted-foreground' : 'text-foreground'}`}>
            {displayName(soul)}
          </span>
        )}
      </button>
      {card.open && <CompanionHoverCard id={cardId} anchor={button} soul={soul} status={state} statusText={said} lead={lead} subagents={subagents} />}
      {menu !== false && (
        <SoulMenu soul={soul} team={team} onOpen={onOpen} onArchive={onArchive} at={menu ?? undefined} anchor={button}
          onCustomize={customizable ? customize : undefined}
          onClose={() => { setMenu(false); button.current?.focus(); }} done={() => setMenu(false)} />
      )}
      {customizing && <CustomizeDialog soul={soul} state={state === 'awaiting' || state === 'working' ? state : undefined}
        onClose={() => { setCustomizing(false); button.current?.focus(); }} />}
    </div>
  );
}

/** Marks an element the native window drags by (#223); only marked elements start a drag. */
const dragRegionOf = (native: boolean) => (native ? { 'data-tauri-drag-region': '' } : {});

/**
 * A native window's page (#223) with the same chrome: no close dot (the
 * window's own traffic lights float over the header's left 72 px), the
 * header drags the window, and Escape anywhere outside a field or an inner
 * dialog closes it. The page clips (never scrolls, #260): only the body's
 * own panes scroll, so the header stays put whatever gets focus inside.
 */
function NativeWindow({ head, titleId, onClose, children }: {
  head: ReactNode; titleId: string; onClose: () => void; children: ReactNode;
}) {
  const root = useRef<HTMLElement>(null);
  const close = useRef(onClose);
  close.current = onClose;
  useEffect(() => {
    // On the document: with no close button, focus may rest on the body.
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && root.current && !escapeStaysInside(e.target, root.current)) close.current();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, []);
  return (
    <section ref={root} aria-labelledby={titleId} className="flex h-full flex-col overflow-clip bg-card">
      <div data-tauri-drag-region="" className="flex min-h-10 items-center gap-2 border-b border-border bg-sidebar py-2 pr-3 pl-[72px] select-none">
        {head}
      </div>
      <div className="flex min-h-0 flex-1 flex-col">{children}</div>
    </section>
  );
}

/**
 * A movable window over the desktop with the design's chrome: a close dot,
 * then `head` (the title and its controls), then the body. `native` is the
 * page of a window of its own (#223).
 */
function DesktopWindow({ head, titleId, onClose, native = false, children }: {
  head: ReactNode; titleId: string; onClose: () => void; native?: boolean; children: ReactNode;
}) {
  if (native) return <NativeWindow head={head} titleId={titleId} onClose={onClose}>{children}</NativeWindow>;
  return <FloatingWindow head={head} titleId={titleId} onClose={onClose}>{children}</FloatingWindow>;
}

function FloatingWindow({ head, titleId, onClose, children }: {
  head: ReactNode; titleId: string; onClose: () => void; children: ReactNode;
}) {
  const { t } = useI18n();
  const [offset, setOffset] = useState({ x: 0, y: 0 });
  const drag = useRef<{ sx: number; sy: number; ox: number; oy: number } | null>(null);
  const close = useRef<HTMLButtonElement>(null);
  useEffect(() => close.current?.focus(), []);
  return (
    <section
      role="dialog"
      aria-labelledby={titleId}
      className="absolute top-1/2 left-1/2 z-30 flex h-[min(660px,calc(100%-3.5rem))] w-[min(780px,calc(100%-1rem))] flex-col overflow-clip rounded-xl border border-border bg-card shadow-2xl"
      style={{ transform: `translate(calc(-50% + ${offset.x}px), calc(-50% + ${offset.y}px))` }}
      // As the design: Escape in the composer, a field or an inner dialog stays there.
      onKeyDown={(e) => { if (e.key === 'Escape' && !escapeStaysInside(e.target, e.currentTarget)) onClose(); }}
    >
      <div
        className="flex cursor-grab touch-none items-center gap-2 border-b border-border bg-sidebar px-3 py-2 select-none active:cursor-grabbing"
        onPointerDown={(e) => {
          if ((e.target as HTMLElement).closest('button')) return;
          e.currentTarget.setPointerCapture(e.pointerId);
          drag.current = { sx: e.clientX, sy: e.clientY, ox: offset.x, oy: offset.y };
        }}
        onPointerMove={(e) => {
          const d = drag.current;
          if (d) setOffset({ x: d.ox + e.clientX - d.sx, y: d.oy + e.clientY - d.sy });
        }}
        onPointerUp={() => { drag.current = null; }}
      >
        <button ref={close} type="button" onClick={onClose} aria-label={t('closeWindow')} title={t('closeWindow')}
          className="grid size-4 place-items-center rounded-full bg-destructive/80 text-destructive-foreground outline-none hover:bg-destructive focus-visible:ring-2 focus-visible:ring-ring">
          <X className="size-2.5" aria-hidden />
        </button>
        {head}
      </div>
      <div className="flex min-h-0 flex-1 flex-col">{children}</div>
    </section>
  );
}

/**
 * A movable window over the desktop, hosting one companion's session, with
 * the design's chrome: a close dot, the Dudle, the mono name and its role · harness line,
 * and a pill for the census's hardened flag when it is known.
 */
export function CompanionWindow({ soul, paused, onClose, actions, state, native = false, children }: {
  soul: CensusRow; paused: boolean; onClose: () => void;
  /** The session's own native window (#223): no close dot, the header drags it. */
  native?: boolean;
  /** The title Dudle's face (the design's `state={c.presence}`): awaiting, working or idle. */
  state?: DudleState;
  /** The chrome's right-hand controls after the pill, such as ⓘ. */
  actions?: ReactNode;
  children: ReactNode;
}) {
  const { t } = useI18n();
  const title = displayName(soul);
  const titleId = useId();
  return (
    <DesktopWindow titleId={titleId} onClose={onClose} native={native} head={(
      <>
        <SoulDudle soul={soul} size={20} paused={paused} state={state} />
        <h2 id={titleId} {...dragRegionOf(native)} className="m-0 truncate font-mono text-xs font-semibold text-foreground">{title}</h2>
        <span {...dragRegionOf(native)} className="mr-auto truncate text-[11px] text-muted-foreground">{roleAndHarness(soul)}</span>
        {typeof soul.hardened === 'boolean' && (
          <span className={`flex shrink-0 items-center gap-1 rounded-full border px-2 py-0.5 text-[11px] ${soul.hardened ? 'border-success/50 text-success' : 'border-border text-muted-foreground'}`}>
            {soul.hardened ? <Shield className="size-3" aria-hidden /> : <ShieldOff className="size-3" aria-hidden />}
            {soul.hardened ? t('pill.hardened') : t('pill.notHardened')}
          </span>
        )}
        {actions}
      </>
    )}>
      {children}
    </DesktopWindow>
  );
}

/**
 * Window mode's Audit log (Lovable route /audit): the companion window's
 * chrome around the design's page, its heading then every companion's records.
 */
export function AuditWindow({ roster, onClose, native = false, soul = null }: {
  roster: readonly CensusRow[]; onClose: () => void;
  /** The audit log's own native window (#223): no close dot, the header drags it. */
  native?: boolean;
  /** One companion's records (the native `audit-<slug>` window); null is all activity. */
  soul?: Pick<CensusRow, 'agentId' | 'name'> | null;
}) {
  const { t } = useI18n();
  const titleId = useId();
  const who = soul ? displayName(soul) : t('allActivity');
  return (
    <DesktopWindow titleId={titleId} onClose={onClose} native={native} head={(
      <>
        <History className="size-4 text-muted-foreground" aria-hidden />
        <h2 id={titleId} {...dragRegionOf(native)} className="m-0 mr-auto truncate font-mono text-xs font-semibold text-foreground">{t('auditTitle')}</h2>
      </>
    )}>
      <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain">
        <h1 className="m-0 px-4 pt-6 text-lg font-semibold md:px-6">{t('auditTitle')} · <span className="text-muted-foreground">{who}</span></h1>
        <AuditLog agentId={soul?.agentId ?? null} roster={roster} />
      </div>
    </DesktopWindow>
  );
}
