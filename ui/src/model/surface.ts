// Which native window this web view is (#223). Every Tauri window loads
// index.html; the shell names the surface, and the soul it shows, in the
// query. No surface (or `tray` / `window`) keeps today's popup and desktop.
import type { SessionTab } from '../components/CompanionSession';

export type Surface = 'tray' | 'window' | 'team' | 'session' | 'audit' | 'customize' | 'launch';
/** The surfaces the popup and the team cards open with `open_surface`. */
export type WindowSurface = 'session' | 'audit' | 'customize' | 'launch';
/** A session tab as the URL names it: the delegation tree is `delegation`. */
export type QueryTab = 'chat' | 'delegation' | 'audit' | 'details';

export interface SurfaceQuery {
  /** Null when absent or unknown: today's behaviour. */
  surface: Surface | null;
  /** A roster key (account/agentId), decoded. */
  soul: string | null;
  tab: SessionTab | null;
  /** `archive`: the session opens with the Archive confirmation showing. */
  action: 'archive' | null;
}

const SURFACES: readonly Surface[] = ['tray', 'window', 'team', 'session', 'audit', 'customize', 'launch'];

/** The URL's tab to the session's own name for it; null for anything else. */
export function sessionTabOf(tab: string | null): SessionTab | null {
  switch (tab) {
    case 'chat': case 'audit': case 'details': return tab;
    // The design's tab is "Delegation"; CompanionSession calls it the tree.
    case 'delegation': case 'tree': return 'tree';
    default: return null;
  }
}

/** A session tab as `open_surface` takes it. */
export function queryTabOf(tab: SessionTab): QueryTab {
  return tab === 'tree' ? 'delegation' : tab;
}

/** Reads `location.search`; anything malformed is dropped, never thrown. */
export function parseSurface(search: string): SurfaceQuery {
  const params = new URLSearchParams(search);
  const surface = params.get('surface');
  const soul = params.get('soul')?.trim();
  return {
    surface: SURFACES.includes(surface as Surface) ? surface as Surface : null,
    soul: soul ? soul : null,
    tab: sessionTabOf(params.get('tab')),
    action: params.get('action') === 'archive' ? 'archive' : null,
  };
}
