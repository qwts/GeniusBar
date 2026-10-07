// The fleet as the redesign shows it (R6): one team per root soul, its
// subagents flattened beneath it with their depth, and a search over them.
import { availabilityNote, displayHarness, displayName, soulKey, type CensusRow, type SoulNode } from './census';
import type { Translate } from '../lib/i18n';

export interface TeamMember {
  soul: CensusRow;
  /** 1 for the lead's direct subagents, 2 for theirs, and so on. */
  depth: number;
}

export interface Team {
  lead: CensusRow;
  members: TeamMember[];
}

function flatten(nodes: readonly SoulNode[], depth: number): TeamMember[] {
  return nodes.flatMap((node) => [{ soul: node.soul, depth }, ...flatten(node.children, depth + 1)]);
}

/** Each root of the forest leads a team of every soul beneath it. */
export function teamsOf(forest: readonly SoulNode[]): Team[] {
  return forest.map((node) => ({ lead: node.soul, members: flatten(node.children, 1) }));
}

/** Name, agent ID or harness contains the query, ignoring case. */
export function matchesQuery(soul: CensusRow, query: string): boolean {
  const q = query.trim().toLowerCase();
  if (!q) return true;
  // The declared role too, as the design's search matches it (agent-bot-identity #535).
  return [displayName(soul), soul.agentId, soul.harness ?? '', soul.role ?? ''].some((text) => text.toLowerCase().includes(q));
}

/**
 * Teams narrowed to the souls a query matches. A team stays while any of
 * its souls match; `leadMatches` says whether the lead's own row shows.
 */
export function searchTeams(teams: readonly Team[], query: string): (Team & { leadMatches: boolean })[] {
  return teams.flatMap((team) => {
    const leadMatches = matchesQuery(team.lead, query);
    const members = team.members.filter((m) => matchesQuery(m.soul, query));
    return leadMatches || members.length ? [{ ...team, members, leadMatches }] : [];
  });
}

/** Every key in a team, lead first. */
export function teamKeys(team: Team): string[] {
  return [soulKey(team.lead), ...team.members.map((m) => soulKey(m.soul))];
}

/** Spoken summary of a companion: name, harness, presence, unread, note. */
export function companionLabel(soul: CensusRow, t: Translate, unread = 0): string {
  const parts = [displayName(soul), displayHarness(soul), t(`presence.${soul.presence}`)];
  if (unread > 0) parts.push(unread === 1 ? t('unreadOne') : t('unreadMany', { count: unread }));
  const note = availabilityNote(soul);
  if (note) parts.push(note);
  return parts.join(', ');
}

function contains(node: SoulNode, key: string): boolean {
  return soulKey(node.soul) === key || node.children.some((child) => contains(child, key));
}

/** The root node of the team a soul belongs to, for its delegation tree. */
export function teamNodeOf(forest: readonly SoulNode[], key: string): SoulNode | null {
  return forest.find((node) => contains(node, key)) ?? null;
}
