import { useMemo, useState, type ReactNode } from 'react';
import { Eye, EyeOff, Search } from 'lucide-react';
import { displayHarness, displayName, soulKey, type CensusRow, type SoulNode } from '../model/census';
import { deriveDudle } from '../model/dudle';
import { companionLabel, searchTeams, teamKeys, teamsOf } from '../model/fleet';
import { useI18n } from '../lib/i18n';
import { Dudle } from './Dudle';

/** A soul's Dudle, faded once it has left. */
export function SoulDudle({ soul, size, paused, label }: { soul: CensusRow; size: number; paused: boolean; label?: string }) {
  return <Dudle spec={deriveDudle(soul.agentId)} diameter={size} paused={paused} label={label} dim={soul.presence === 'left'} />;
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
}

/**
 * The GeniusBar menu's fleet (R6): one group per team, its lead first and
 * subagents indented beneath, with a search over name, ID and harness.
 * Every companion opens, 'left' ones included.
 */
export function FleetList({ forest, paused, unreadOf, onOpen, hiding, empty }: FleetListProps) {
  const { t } = useI18n();
  const [query, setQuery] = useState('');
  const teams = useMemo(() => teamsOf(forest), [forest]);
  const shown = useMemo(() => searchTeams(teams, query), [teams, query]);
  // Whole teams by lead, unaffected by the search, for hiding a team at once.
  const teamOf = useMemo(() => new Map(teams.filter((team) => team.members.length > 0)
    .map((team) => [soulKey(team.lead), teamKeys(team)])), [teams]);

  // A lead with subagents hides and shows its whole team; anyone else, just themselves.
  const row = (soul: CensusRow, depth: number, team: readonly string[] | null = null) => {
    const key = soulKey(soul);
    const unread = unreadOf?.(soul) ?? 0;
    const hidden = hiding?.hidden.includes(key) ?? false;
    const name = displayName(soul);
    return (
      <li key={key} className="group flex items-center gap-1 px-2">
        <button
          type="button"
          className={`companion-row flex min-w-0 flex-1 items-center gap-2 rounded-md py-1 pr-1 text-left text-sm hover:bg-accent ${hidden ? 'opacity-50' : ''}`}
          style={{ paddingLeft: 4 + depth * 14 }}
          aria-label={companionLabel(soul, t, unread)}
          onClick={() => onOpen(soul)}
        >
          <SoulDudle soul={soul} size={20} paused={paused} />
          <span className="truncate">{name}</span>
          <span className="truncate font-mono text-[10px] text-muted-foreground">{displayHarness(soul)}</span>
          <span className="ml-auto flex shrink-0 items-center gap-1.5">
            {unread > 0 && (
              <span className="rounded-full bg-primary px-1.5 font-mono text-[10px] font-semibold text-primary-foreground">
                {t('newCount', { count: unread })}
              </span>
            )}
            <span className={`text-[11px] ${soul.presence === 'joined' ? 'text-success' : 'text-muted-foreground'}`}>
              {t(`presence.${soul.presence}`)}
            </span>
          </span>
        </button>
        {hiding && (
          <button
            type="button"
            className="rounded p-1 text-muted-foreground hover:text-foreground"
            aria-label={`${team ? (hidden ? t('bar.showTeam') : t('bar.hideTeam')) : (hidden ? t('bar.show') : t('bar.hide'))}: ${name}`}
            aria-pressed={!hidden}
            onClick={() => (team ? hiding.onToggleTeam(team, !hidden) : hiding.onToggle(key, !hidden))}
          >
            {hidden ? <EyeOff className="size-3.5" aria-hidden /> : <Eye className="size-3.5 opacity-40 group-hover:opacity-100" aria-hidden />}
          </button>
        )}
      </li>
    );
  };

  return (
    <section className="flex min-h-0 flex-1 flex-col" aria-label={t('fleet')}>
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
              className="h-8 w-full rounded-md border-0 bg-muted pr-2 pl-7 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring"
            />
          </div>
          <ul className="m-0 min-h-0 flex-1 list-none overflow-y-auto p-0 py-1">
            {shown.length === 0 && <li className="px-3 py-2 text-sm text-muted-foreground">{t('bar.noResults')}</li>}
            {shown.map((team) => (
              <li key={soulKey(team.lead)}>
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
