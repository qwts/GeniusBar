// The Customize dialog's read (#64): agent-bot's `soul profile`, asked
// each time the dialog (or the ⓘ sheet that offers it) opens. An older
// bundle without the command, or no source (a plain browser, a test without
// one), leaves `supported` false and the Customize entry hidden.
import { createContext, useContext, useEffect, useState } from 'react';
import { soulProfile, soulProfileFile, type SoulProfile, type SoulProfileFile } from './bridge';

/** Where profiles come from: agent-bot in the app; fixtures in the preview and tests. */
export interface ProfileSource {
  profile: (agentId: string) => Promise<SoulProfile>;
  file: (agentId: string, path: string) => Promise<SoulProfileFile>;
}

export const liveProfileSource: ProfileSource = {
  profile: (agentId) => soulProfile(agentId),
  file: (agentId, path) => soulProfileFile(agentId, path),
};

/** App provides agent-bot's in the app; none hides Customize. */
export const ProfileSourceContext = createContext<ProfileSource | null>(null);

export interface SoulProfileApi {
  profile: SoulProfile | null;
  /**
   * True once agent-bot answered with the command present (a profile, or a
   * failure such as `soul-not-found`); false before, on an older bundle, or
   * without a source.
   */
  supported: boolean;
  loading: boolean;
  /** Why the read failed (never for an older bundle). */
  error: string | null;
}

const NONE: SoulProfileApi = { profile: null, supported: false, loading: false, error: null };

/** Reads the profile whenever `open` turns true, for that soul. */
export function useSoulProfile(agentId: string, open: boolean): SoulProfileApi {
  const source = useContext(ProfileSourceContext);
  const [state, setState] = useState<SoulProfileApi>(NONE);
  useEffect(() => {
    if (!open || !source) {
      setState(NONE);
      return;
    }
    let current = true;
    setState((s) => ({ ...s, loading: true, error: null }));
    source.profile(agentId).then(
      (profile) => { if (current) setState({ profile, supported: true, loading: false, error: null }); },
      (failure: unknown) => {
        if (!current) return;
        const e = failure as { code?: unknown; message?: unknown };
        if (e?.code === 'soul-profile-unsupported') setState(NONE);
        else setState({ profile: null, supported: true, loading: false, error: typeof e?.message === 'string' ? e.message : String(failure) });
      },
    );
    return () => { current = false; };
  }, [agentId, open, source]);
  return state;
}
