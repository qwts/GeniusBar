import { useMemo, useState, type ReactNode } from 'react';
import { Archive, Eye, EyeOff, Search, Users } from 'lucide-react';
import { availabilityNote, displayHarness, displayName, soulKey, type CensusRow, type SoulNode } from '../model/census';
import { dudleFor } from '../model/dudle';
import { companionLabel, searchTeams, teamKeys, teamsOf } from '../model/fleet';
import { useI18n } from '../lib/i18n';
import { Dudle, type DudleState } from './Dudle';

/**
 * A soul's Dudle, faded once it has left. `state` animates the face as the
 * design's `state={c.presence}` does: bouncing while it waits on you, eyes
 * moving while it works.
 */
export function SoulDudle({ soul, size, paused, label, state }: { soul: CensusRow; size: number; paused: boolean; label?: string; state?: DudleState }) {
  return <Dudle spec={dudleFor(soul)} diameter={size} paused={paused} label={label} dim={soul.presence === 'left'} state={state} />;
}

/** The face for a companion: waiting on you first, then mid-turn, else idle. */
export function dudleState(agentId: string, awaiting?: ReadonlySet<string>, busy?: ReadonlySet<string>): DudleState {
  if (awaiting?.has(agentId)) return 'awaiting';
  if (busy?.has(agentId)) return 'working';
  return 'idle';
}

/** Window mode only: which companions the desktop hides. */
export interface Hiding {
  hidden: readonly string[];
  onToggle: (key: string, hidden: boolean) => void;
  /** Hide or show a team's lead together with all its subagents. */
  onToggleTeam: (keys: readonly string[], hidden: boolean) => void;
  onShowAll: () => void;
}

interface FleetListProps {
  forest: readonly SoulNode[];
  paused: boolean;
  unreadOf?: (soul: CensusRow) => number;
  onOpen: (soul: CensusRow) => void;
  hiding?: Hiding;
  /** Shown in the region while the fleet is empty. */
  empty?: ReactNode;
  /** Asks to archive a soul (#94); without it rows have no Archive button. */
  onArchive?: (soul: CensusRow) => void;
  /** Agent IDs with a proposal waiting on the owner: bouncing face, "Waiting for you". */
  awaiting?: ReadonlySet<string>;
  /** Agent IDs mid-turn (daemon status `busy`): the working face. */
  busy?: ReadonlySet<string>;
}

/**
 * The GeniusBar menu's fleet (R6): one group per team, its lead first and
 * subagents indented beneath, with a search over name, ID and harness.
 * Every companion opens, 'left' ones included.
 */
export function FleetList({ forest, paused, unreadOf, onOpen, hiding, empty, onArchive, awaiting, busy }: FleetListProps) {
  const { t } = useI18n();
  const [query, setQuery] = useState('');
  const teams = useMemo(() => teamsOf(forest), [forest]);
  const shown = useMemo(() => searchTeams(teams, query), [teams, query]);
  // As the design: teams under their lead's name, then souls with no team.
  const ordered = useMemo(() => [...shown.filter((team) => team.members.length > 0), ...shown.filter((team) => !team.members.length)], [shown]);
  const firstSolo = ordered.findIndex((team) => !team.members.length);
  // Whole teams by lead, unaffected by the search, for hiding a team at once.
  const teamOf = useMemo(() => new Map(teams.filter((team) => team.members.length > 0)
    .map((team) => [soulKey(team.lead), teamKeys(team)])), [teams]);

  // Everyone keeps their own eye; a lead with subagents also gets one for the whole team.
  const row = (soul: CensusRow, depth: number, team: readonly string[] | null = null) => {
    const key = soulKey(soul);
    const unread = unreadOf?.(soul) ?? 0;
    const hidden = hiding?.hidden.includes(key) ?? false;
    const name = displayName(soul);
    const note = availabilityNote(soul);
    const state = soul.presence === 'left' ? 'offline' : dudleState(soul.agentId, awaiting, busy);
    return (
      <li key={key} className="group flex items-center gap-2 px-2">
        <button
          type="button"
          className={`companion-row flex min-h-7 min-w-0 flex-1 items-center gap-2 rounded py-1 pr-1 text-left text-sm hover:bg-accent ${hidden ? 'opacity-50' : ''}`}
          style={{ paddingLeft: 4 + depth * 14 }}
          title={t('showDetails', { name })}
          aria-label={companionLabel(soul, t, unread)}
          aria-description={t('showsDetails')}
          onClick={() => onOpen(soul)}
        >
          <SoulDudle soul={soul} size={18} paused={paused} state={state} />
          <span className="flex min-w-0 flex-col">
            <span className="truncate">{name}</span>
            {note && <span className="truncate text-[11px] text-muted-foreground">{note}</span>}
          </span>
          <span className="truncate font-mono text-[11px] text-muted-foreground">{displayHarness(soul)}</span>
          <span className="ml-auto flex shrink-0 items-center gap-1.5">
            {unread > 0 && (
              <span className="rounded-full bg-primary px-1.5 font-mono text-[11px] font-semibold text-primary-foreground">
                {t('newCount', { count: unread })}
              </span>
            )}
            <span className={`text-[11px] ${state === 'awaiting' ? 'text-warning' : 'text-muted-foreground'}`}>
              {state === 'awaiting' ? t('presence.awaiting') : t(`presence.${soul.presence}`)}
            </span>
          </span>
        </button>
        {hiding && (
          <button
            type="button"
            className="rounded p-1 text-muted-foreground hover:text-foreground"
            aria-label={`${hidden ? t('bar.show') : t('bar.hide')}: ${name}`}
            aria-pressed={!hidden}
            onClick={() => hiding.onToggle(key, !hidden)}
          >
            {hidden ? <EyeOff className="size-3.5" aria-hidden /> : <Eye className="size-3.5 opacity-40 group-hover:opacity-100" aria-hidden />}
          </button>
        )}
        {hiding && team && (() => {
          const teamHidden = team.every((k) => hiding.hidden.includes(k));
          return (
            <button
              type="button"
              className="rounded p-1 text-muted-foreground hover:text-foreground"
              aria-label={`${teamHidden ? t('bar.showTeam') : t('bar.hideTeam')}: ${name}`}
              aria-pressed={!teamHidden}
              onClick={() => hiding.onToggleTeam(team, !teamHidden)}
            >
              <Users className={`size-3.5 ${teamHidden ? '' : 'opacity-40 group-hover:opacity-100'}`} aria-hidden />
            </button>
          );
        })()}
        {onArchive && (
          <button
            type="button"
            className="rounded p-1 text-muted-foreground hover:text-destructive"
            aria-label={`${t('bar.archive')}: ${name}`}
            title={t('bar.archive')}
            onClick={() => onArchive(soul)}
          >
            <Archive className="size-3.5 opacity-40 group-hover:opacity-100" aria-hidden />
          </button>
        )}
      </li>
    );
  };

  return (
    <section className="flex flex-1 flex-col" aria-label={t('fleet')}>
      {forest.length === 0 ? empty : (
        <>
          <div className="relative border-b border-border p-2">
            <Search className="pointer-events-none absolute top-1/2 left-4 size-3.5 -translate-y-1/2 text-muted-foreground" aria-hidden />
            <input
              type="search"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder={t('bar.search')}
              aria-label={t('bar.search')}
              autoFocus
              className="h-8 w-full rounded-md border-0 bg-muted pr-2 pl-7 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring"
            />
          </div>
          <ul className="m-0 min-h-40 flex-1 list-none overflow-y-auto p-0 py-1">
            {ordered.length === 0 && <li className="px-3 py-2 text-sm text-muted-foreground">{t('bar.noResults')}</li>}
            {ordered.map((team, i) => (
              <li key={soulKey(team.lead)}>
                {(team.members.length > 0 || i === firstSolo) && (
                  <p className="m-0 px-3 pt-2 pb-0.5 font-mono text-[11px] tracking-wider text-muted-foreground uppercase" aria-hidden>
                    {team.members.length > 0 ? displayName(team.lead) : t('team.none')}
                  </p>
                )}
                <ul className="m-0 list-none p-0" aria-label={displayName(team.lead)}>
                  {team.leadMatches && row(team.lead, 0, teamOf.get(soulKey(team.lead)) ?? null)}
                  {team.members.map((m) => row(m.soul, m.depth))}
                </ul>
              </li>
            ))}
          </ul>
          {hiding && hiding.hidden.length > 0 && (
            <button type="button" className="w-full border-t border-border px-3 py-2 text-left text-xs text-primary hover:bg-accent"
              onClick={hiding.onShowAll}>
              {t('bar.showAll', { count: hiding.hidden.length })}
            </button>
          )}
        </>
      )}
    </section>
  );
}
