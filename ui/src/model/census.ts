// Census model, ported from R1's Models.swift. Rows come from the
// agent-comms principal client's census (through the Node bridge, #7).
// Display only: nothing here routes messages or carries authority.

export type Presence = 'watching' | 'joined' | 'left';

/** One soul as listed by the principal client's census. */
export interface CensusRow {
  account: string;
  agentId: string;
  name: string | null;
  harness: string | null;
  /** Agent ID of the parent soul, for subagents told to join. Null for roots. */
  parent: string | null;
  presence: Presence;
  unacked: number;
  /** Opaque last-wake marker from the broker, or null. */
  lastWake: string | null;
  // Added by the principal client after R1. Optional so R1-shaped
  // fixtures and older bridges still render.
  verification?: string | null;
  hardened?: boolean | null;
  daemonWatching?: boolean | null;
  /**
   * The Dudle hue the soul declares (soul.json `appearance.hue`, 0..359),
   * joined from agent-bot's population list by `withHues`; absent derives it.
   */
  hue?: number;
  /**
   * The role the soul declares (soul.json `role`, agent-bot-identity #535),
   * joined from agent-bot's population list by `withRoles`; absent or null
   * when it declares none, and the harness shows instead.
   */
  role?: string | null;
  /** agent-bot's role line (the role, else "Lead" and the subagent count); joined like `role`. */
  roleLine?: string | null;
}

/** A soul with its subagents nested underneath. */
export interface SoulNode {
  soul: CensusRow;
  children: SoulNode[];
}

/**
 * Roster key: account plus agent ID. Rows key by this, never by display
 * name, so duplicate names cannot merge and identical agent IDs under
 * different accounts stay distinct.
 */
export function soulKey(soul: Pick<CensusRow, 'account' | 'agentId'>): string {
  return `${soul.account}/${soul.agentId}`;
}

/** First 8 characters of the agent ID, used when no name is set. */
export function shortAgentId(soul: Pick<CensusRow, 'agentId'>): string {
  // Code points rather than UTF-16 units, closer to Swift's prefix(8).
  return Array.from(soul.agentId).slice(0, 8).join('');
}

/** Display name when set, otherwise the short agent ID. */
export function displayName(soul: Pick<CensusRow, 'agentId' | 'name'>): string {
  if (soul.name) return soul.name;
  const short = shortAgentId(soul);
  return short === '' ? 'unknown companion' : short;
}

/** Harness label with an explicit fallback instead of a bare dash. */
export function displayHarness(soul: Pick<CensusRow, 'harness'>): string {
  return soul.harness ? soul.harness : 'unknown harness';
}

/**
 * A companion's subtitle (#122, agent-bot-identity #535): the role it
 * declares, else its harness, so a soul without a role reads as before.
 */
export function displayRole(soul: Pick<CensusRow, 'harness' | 'role'>): string {
  const role = soul.role?.trim();
  return role ? role : displayHarness(soul);
}

/**
 * The design's "role · harness" line: the declared role ahead of the
 * harness when there is one, else the harness alone. `harness` words the
 * harness: its raw ID by default, or its label (`soulHarnessLabel`).
 */
export function roleAndHarness(soul: Pick<CensusRow, 'harness' | 'role'>,
  harness: (soul: Pick<CensusRow, 'harness'>) => string = displayHarness): string {
  const role = soul.role?.trim();
  return role ? `${role} · ${harness(soul)}` : harness(soul);
}

/**
 * Drops the rows of souls agent-bot has archived (#196): `soul remove`
 * retires a soul and its hub row stays as `left`, and a left row is kept
 * for reference, but an archived soul is gone from this Mac and its row
 * only looks like a companion that remains. `population` is agent-bot's
 * `population_list`; null (an older bundle, or not read yet) hides nothing.
 */
export function withoutArchived(souls: readonly CensusRow[],
  population: readonly { agentId: string; status?: string | null }[] | null): readonly CensusRow[] {
  if (!population) return souls;
  const archived = new Set(population.flatMap((e) => (e.status === 'retired' ? [e.agentId] : [])));
  return archived.size === 0 ? souls : souls.filter((s) => !archived.has(s.agentId));
}

/**
 * Text state for unavailable souls. 'left' souls stay listed with this
 * explanation instead of being dropped from the roster.
 */
export function availabilityNote(soul: Pick<CensusRow, 'presence'>): string | null {
  return soul.presence === 'left'
    ? 'Left — no longer available. Kept in the fleet for reference.'
    : null;
}

/**
 * Display name of a soul's parent when the parent is in the roster, null
 * for roots and unknown parents. Scoped to the soul's account so identical
 * agent IDs under different accounts never resolve across accounts.
 */
export function parentDisplayName(soul: CensusRow, roster: readonly CensusRow[]): string | null {
  if (soul.parent === null) return null;
  const parent = roster.find((s) => s.account === soul.account && s.agentId === soul.parent);
  return parent ? displayName(parent) : null;
}

/** Every soul in a forest, pre-order, for resolving parent names. */
export function allSouls(forest: readonly SoulNode[]): CensusRow[] {
  return forest.flatMap((node) => [node.soul, ...allSouls(node.children)]);
}

/** Census soul count behind a forest (every node holds exactly one soul). */
export function countSouls(forest: readonly SoulNode[]): number {
  return forest.reduce((n, node) => n + 1 + countSouls(node.children), 0);
}

/** Find a soul by bare agent ID or by its account/agentId roster key. */
export function findSoul(forest: readonly SoulNode[], agentId: string): CensusRow | null {
  const stack = [...forest];
  for (let node = stack.pop(); node; node = stack.pop()) {
    if (node.soul.agentId === agentId || soulKey(node.soul) === agentId) return node.soul;
    stack.push(...node.children);
  }
  return null;
}

// Code-unit order, not localeCompare, so the listing never depends on the
// web view's locale.
function byAgentId(a: CensusRow, b: CensusRow): number {
  return a.agentId < b.agentId ? -1 : a.agentId > b.agentId ? 1 : 0;
}

/**
 * Nest subagents under their parent, preserving census order for roots.
 * Children sort by agent ID. Roots are souls with no parent or with a
 * parent absent from the census. Repeat entries collapse to their first
 * occurrence, and nesting is scoped per account. The forest is rebuilt
 * wholesale from each census, so reconciling after an outage replaces rows
 * instead of duplicating them.
 */
export function buildSoulForest(souls: readonly CensusRow[]): SoulNode[] {
  const seen = new Set<string>();
  const byAccount = new Map<string, CensusRow[]>();
  for (const soul of souls) {
    const key = soulKey(soul);
    if (seen.has(key)) continue;
    seen.add(key);
    const group = byAccount.get(soul.account);
    if (group) group.push(soul);
    else byAccount.set(soul.account, [soul]);
  }

  const forest: SoulNode[] = [];
  for (const group of byAccount.values()) {
    const byParent = new Map<string, CensusRow[]>();
    for (const soul of group) {
      const key = soul.parent ?? '';
      const siblings = byParent.get(key);
      if (siblings) siblings.push(soul);
      else byParent.set(key, [soul]);
    }
    const knownIds = new Set(group.map((s) => s.agentId));
    // Parents are claims, so a census can hold a parent cycle or a soul
    // naming itself. Each soul is placed exactly once; a cycle no root
    // reaches is entered at its first soul in census order.
    const placed = new Set<string>();
    const node = (soul: CensusRow): SoulNode => {
      placed.add(soul.agentId);
      const kids = (byParent.get(soul.agentId) ?? [])
        .filter((kid) => !placed.has(kid.agentId))
        .sort(byAgentId)
        .map(node);
      return { soul, children: kids };
    };
    for (const soul of group) {
      if (soul.parent === null || !knownIds.has(soul.parent)) forest.push(node(soul));
    }
    for (const soul of group) {
      if (!placed.has(soul.agentId)) forest.push(node(soul));
    }
  }
  return forest;
}

/**
 * The census with each soul's declared hue (agent-bot `population list`)
 * joined in: the one place population appearance meets the census rows.
 * Unchanged rows (and the same array, when nothing changed) are kept so
 * the forest does not rebuild for nothing.
 */
export function withHues(souls: readonly CensusRow[], hues: ReadonlyMap<string, number> | undefined): readonly CensusRow[] {
  let changed = false;
  const out = souls.map((soul) => {
    const hue = hues?.get(soul.agentId);
    if (hue === soul.hue) return soul;
    changed = true;
    if (hue !== undefined) return { ...soul, hue };
    const { hue: _dropped, ...rest } = soul;
    return rest;
  });
  return changed ? out : souls;
}

/** A soul's declared role and agent-bot's role line, from one `population_list` read. */
export interface SoulRole {
  role?: string | null;
  roleLine?: string | null;
}

/**
 * The census with each soul's declared role (agent-bot `population list`,
 * agent-bot-identity #535) joined in, beside `withHues`. Unchanged rows
 * (and the same array, when nothing changed) are kept.
 */
export function withRoles(souls: readonly CensusRow[], roles: ReadonlyMap<string, SoulRole> | undefined): readonly CensusRow[] {
  let changed = false;
  const out = souls.map((soul) => {
    const next = roles?.get(soul.agentId);
    const role = next?.role ?? undefined;
    const roleLine = next?.roleLine ?? undefined;
    if ((soul.role ?? undefined) === role && (soul.roleLine ?? undefined) === roleLine) return soul;
    changed = true;
    const { role: _role, roleLine: _line, ...rest } = soul;
    return { ...rest, ...(role ? { role } : {}), ...(roleLine ? { roleLine } : {}) };
  });
  return changed ? out : souls;
}
