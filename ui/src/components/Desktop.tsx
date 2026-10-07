import { useContext, useEffect, useId, useMemo, useRef, useState, type PointerEvent, type ReactNode, type RefObject } from 'react';
import { Archive, ChevronDown, Eye, EyeOff, History, Monitor, MoreHorizontal, Palette, Plus, Radio, Shield, ShieldOff, Users, X } from 'lucide-react';
import { displayName, displayRole, roleAndHarness, soulKey, type CensusRow, type SoulNode } from '../model/census';
import { companionLabel, teamKeys, teamsOf, type Team } from '../model/fleet';
import { useI18n } from '../lib/i18n';
import { noBadges, type SoulBadges } from '../model/refresh';
import { layoutActions, type DesktopLayout } from '../state/layout';
import { ProfileSourceContext } from '../useSoulProfile';
import { AuditLog } from './AuditLog';
import { CustomizeDialog } from './CustomizeDialog';
import { SoulDudle } from './FleetList';
import { CompanionHoverCard, useHoverCard } from './HoverCard';
import { soulStatus, statusText, StatusDot, type StatusInputs } from './DesktopStatus';

const CARD_W = 300;
/** A lead with no subagents is a slim card, as the design's solo cards. */
const SOLO_W = 200;
const GAP = 16;

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
      const key = soulKey(team.lead);
      const visible = team.members.filter((m) => !layout.hidden.includes(soulKey(m.soul)));
      const collapsed = layout.collapsed.includes(key);
      const height = 64 + (collapsed || !visible.length ? 0 : Math.ceil(visible.length / 4) * 68 + 12);
      const col = heights.indexOf(Math.min(...heights));
      const fallback = { x: GAP + col * column, y: heights[col] };
      heights[col] += height + GAP;
      return { team, id: key, visible, collapsed, leadHidden: layout.hidden.includes(key), pos: layout.pos[key] ?? fallback };
    });
  }, [teams, layout, width]);

  return (
    <main ref={ref} className="gb-wallpaper relative min-h-0 flex-1 overflow-auto" aria-label={t('fleet')}>
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
function TeamCluster({ team, visible, collapsed, leadHidden, pos, paused, unreadOf, selectedKey, onOpen, badges, onArchive, status }: ClusterProps) {
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

  return (
    <section
      aria-label={leadHidden ? t('team.placeholder') : displayName(team.lead)}
      style={{ left: at.x, top: at.y, width: count > 0 ? CARD_W : SOLO_W }}
      className={`group absolute rounded-xl border bg-card/75 shadow-lg backdrop-blur-md ${awaitingCount > 0 ? 'border-warning/70' : 'border-border'} ${live ? 'z-20' : ''}`}
    >
      <div onPointerDown={onDown} onPointerMove={onMove} onPointerUp={onUp} onPointerCancel={onUp}
        className={`flex touch-none items-center gap-2 p-2 ${live ? 'cursor-grabbing' : 'cursor-grab'}`}>
        {leadHidden ? (
          <>
            <span className="grid size-10 shrink-0 place-items-center rounded-lg border border-dashed border-border text-muted-foreground" aria-hidden>
              <Users className="size-5" />
            </span>
            <div className="min-w-0 flex-1 select-none">
              <p className="m-0 truncate text-sm font-semibold">{t('team.placeholder')}</p>
              <p className="m-0 truncate font-mono text-[10px] text-muted-foreground">
                {[subagents, hidden].filter((part): part is string => part !== null).join(' · ')}
              </p>
            </div>
          </>
        ) : (
          <>
            <CompanionButton soul={team.lead} size={40} paused={paused} unread={unreadOf?.(team.lead) ?? 0}
              selected={selectedKey === key} onOpen={onOpen} bare team={count > 0 ? teamKeys(team) : undefined}
              badges={badges} onArchive={onArchive} status={status} lead={null} subagents={count} />
            <div className="min-w-0 flex-1 select-none">
              <p className="m-0 truncate text-sm font-semibold">{displayName(team.lead)}</p>
              <p className="m-0 truncate font-mono text-[10px] text-muted-foreground">
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
            className={`rounded p-1 text-muted-foreground hover:bg-accent hover:text-foreground ${leadHidden ? '' : 'opacity-0 group-hover:opacity-100 focus-visible:opacity-100 aria-expanded:opacity-100'}`}>
            <MoreHorizontal className="size-4" aria-hidden />
          </button>
          {more && (leadHidden ? (
            <MenuBox label={t('team.placeholder')} onClose={closeMore} align="right">
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
              onClose={closeMore} done={() => setMore(false)} align="right" />
          ))}
        </div>
        {count > 0 && (
          <button
            type="button"
            aria-label={collapsed ? t('team.expand') : t('team.collapse')}
            aria-expanded={!collapsed}
            onClick={() => layoutActions.setCollapsed(key, !collapsed)}
            className="rounded p-1 text-muted-foreground hover:bg-accent hover:text-foreground"
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

const menuItem = 'flex items-center gap-2 rounded-sm px-2 py-1.5 text-left hover:bg-accent focus-visible:bg-accent focus-visible:outline-none';

/** A small menu that takes focus and closes on Escape or when focus leaves it. */
function MenuBox({ label, onClose, align = 'center', children }: {
  label: string; onClose: () => void; align?: 'center' | 'right';
  children: (first: RefObject<HTMLButtonElement | null>) => ReactNode;
}) {
  const first = useRef<HTMLButtonElement>(null);
  useEffect(() => { first.current?.focus(); }, []);
  return (
    <div role="menu" aria-label={label}
      className={`absolute top-full z-30 mt-1 grid min-w-[8rem] rounded-md border border-border bg-popover p-1 text-sm shadow-md ${align === 'right' ? 'right-0' : 'left-1/2 -translate-x-1/2'}`}
      onKeyDown={(e) => { if (e.key === 'Escape') { e.stopPropagation(); onClose(); } }}
      onBlur={(e) => { if (!e.currentTarget.contains(e.relatedTarget as Node | null)) onClose(); }}>
      {children(first)}
    </div>
  );
}

/**
 * Open, Customize… (right-click only, as the design's), Hide, Hide team and
 * Remove… for one companion: its right-click menu and its team's ⋯.
 */
function SoulMenu({ soul, team, onOpen, onCustomize, onArchive, onClose, done, align }: {
  soul: CensusRow; team?: readonly string[]; onOpen: (soul: CensusRow) => void; onArchive?: (soul: CensusRow) => void;
  /** Opens the Customize dialog (#64); without it the menu has no Customize…. */
  onCustomize?: () => void;
  /** Escape or focus leaving: close and hand focus back. */
  onClose: () => void;
  /** An item ran: close without moving focus. */
  done: () => void;
  align?: 'center' | 'right';
}) {
  const { t } = useI18n();
  return (
    <MenuBox label={displayName(soul)} onClose={onClose} align={align}>
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
            onClick={() => { done(); layoutActions.setHidden(soulKey(soul), true); }}>
            <EyeOff className="size-3.5" aria-hidden /> {t('bar.hide')}
          </button>
          {team && (
            <button type="button" role="menuitem" className={menuItem}
              onClick={() => { done(); layoutActions.setTeamHidden(team, true); }}>
              <EyeOff className="size-3.5" aria-hidden /> {t('bar.hideTeam')}
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
  const [menu, setMenu] = useState(false);
  const [customizing, setCustomizing] = useState(false);
  // Customize… reads agent-bot's profile; no source (a plain browser) offers none.
  const customizable = useContext(ProfileSourceContext) !== null;
  const button = useRef<HTMLButtonElement>(null);
  const card = useHoverCard(!menu && !customizing);
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
        onContextMenu={(e) => { e.preventDefault(); setMenu(true); }}
        {...card.trigger}
        className={`flex flex-col items-center gap-0.5 rounded-lg p-1 ${bare ? 'shrink-0' : 'w-full'} ${selected ? 'bg-accent' : 'hover:bg-accent/50'}`}
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
      {card.open && <CompanionHoverCard id={cardId} soul={soul} status={state} statusText={said} lead={lead} subagents={subagents} />}
      {menu && (
        <SoulMenu soul={soul} team={team} onOpen={onOpen} onArchive={onArchive}
          onCustomize={customizable ? () => setCustomizing(true) : undefined}
          onClose={() => { setMenu(false); button.current?.focus(); }} done={() => setMenu(false)} />
      )}
      {customizing && <CustomizeDialog soul={soul} onClose={() => { setCustomizing(false); button.current?.focus(); }} />}
    </div>
  );
}

/**
 * A movable window over the desktop with the design's chrome: a close dot,
 * then `head` (the title and its controls), then the body.
 */
function DesktopWindow({ head, titleId, onClose, children }: {
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
      className="absolute top-1/2 left-1/2 z-30 flex h-[min(660px,calc(100%-3.5rem))] w-[min(780px,calc(100%-1rem))] flex-col overflow-hidden rounded-xl border border-border bg-card shadow-2xl"
      style={{ transform: `translate(calc(-50% + ${offset.x}px), calc(-50% + ${offset.y}px))` }}
      onKeyDown={(e) => { if (e.key === 'Escape') onClose(); }}
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
          className="grid size-4 place-items-center rounded-full bg-destructive/80 text-destructive-foreground hover:bg-destructive">
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
export function CompanionWindow({ soul, paused, onClose, actions, children }: {
  soul: CensusRow; paused: boolean; onClose: () => void;
  /** The chrome's right-hand controls after the pill, such as ⓘ. */
  actions?: ReactNode;
  children: ReactNode;
}) {
  const { t } = useI18n();
  const title = displayName(soul);
  const titleId = useId();
  return (
    <DesktopWindow titleId={titleId} onClose={onClose} head={(
      <>
        <SoulDudle soul={soul} size={20} paused={paused} />
        <h2 id={titleId} className="m-0 truncate font-mono text-xs font-semibold text-foreground">{title}</h2>
        <span className="mr-auto truncate text-[11px] text-muted-foreground">{roleAndHarness(soul)}</span>
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
export function AuditWindow({ roster, onClose }: { roster: readonly CensusRow[]; onClose: () => void }) {
  const { t } = useI18n();
  const titleId = useId();
  return (
    <DesktopWindow titleId={titleId} onClose={onClose} head={(
      <>
        <History className="size-4 text-muted-foreground" aria-hidden />
        <h2 id={titleId} className="m-0 mr-auto truncate font-mono text-xs font-semibold text-foreground">{t('auditTitle')}</h2>
      </>
    )}>
      <div className="min-h-0 flex-1 overflow-y-auto">
        <h1 className="m-0 px-4 pt-6 text-lg font-semibold md:px-6">{t('auditTitle')} · <span className="text-muted-foreground">{t('allActivity')}</span></h1>
        <AuditLog agentId={null} roster={roster} />
      </div>
    </DesktopWindow>
  );
}
