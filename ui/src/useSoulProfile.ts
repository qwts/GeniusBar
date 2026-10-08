// The Customize dialog's read (#64): agent-bot's `soul profile`, asked
// each time the dialog (or the ⓘ sheet that offers it) opens. An older
// bundle without the command, or no source (a plain browser, a test without
// one), leaves `supported` false and the Customize entry hidden.
import { createContext, useContext, useEffect, useRef, useState } from 'react';
import { discardRevision, prepareRevision, soulProfile, soulProfileFile, type PreparedRevision, type SoulProfile, type SoulProfileFile } from './bridge';

/** Where profiles come from: agent-bot in the app; fixtures in the preview and tests. */
export interface ProfileSource {
  profile: (agentId: string) => Promise<SoulProfile>;
  file: (agentId: string, path: string) => Promise<SoulProfileFile>;
  /** Stages the soul for an edit (#268): the engine's rows say what the owner may edit. */
  prepare: (agentId: string) => Promise<PreparedRevision>;
  /** Drops a staging the dialog gave up on. */
  discard: (staging: string) => Promise<void>;
}

export const liveProfileSource: ProfileSource = {
  profile: (agentId) => soulProfile(agentId),
  file: (agentId, path) => soulProfileFile(agentId, path),
  prepare: (agentId) => prepareRevision(agentId),
  discard: (staging) => discardRevision(staging),
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

export interface RevisionStagingApi {
  /** The staging and the engine's rows; null until it answers, or when it refused. */
  prepared: PreparedRevision | null;
  /** Why staging failed (the engine's message); files then open read-only. */
  error: string | null;
  /** Stages afresh after a Save, which consumed the staging whether it was recorded or refused. */
  renew: () => void;
}

const UNSTAGED: Pick<RevisionStagingApi, 'prepared' | 'error'> = { prepared: null, error: null };

/**
 * The Customize dialog's staging (#268): `soul revision prepare` while
 * `open`, discarded when the dialog closes without saving (`prepare
 * --discard`), or when a later prepare supersedes it. Save consumes it, so
 * `renew` prepares again without discarding.
 */
export function useRevisionStaging(agentId: string, open: boolean): RevisionStagingApi {
  const source = useContext(ProfileSourceContext);
  const [generation, setGeneration] = useState(0);
  const [state, setState] = useState(UNSTAGED);
  const consumed = useRef(false);
  useEffect(() => {
    if (!open || !source) {
      setState(UNSTAGED);
      return;
    }
    let current = true;
    let staging: string | null = null;
    consumed.current = false;
    setState(UNSTAGED);
    const drop = (path: string) => { source.discard(path).catch(() => {}); };
    source.prepare(agentId).then(
      (prepared) => {
        if (!current) {
          if (prepared.staging) drop(prepared.staging);
          return;
        }
        staging = prepared.staging;
        setState({ prepared, error: null });
      },
      (failure: unknown) => {
        if (!current) return;
        const e = failure as { message?: unknown };
        setState({ prepared: null, error: typeof e?.message === 'string' ? e.message : String(failure) });
      },
    );
    return () => {
      current = false;
      if (staging && !consumed.current) drop(staging);
    };
  }, [agentId, open, source, generation]);
  const renew = () => {
    consumed.current = true;
    setGeneration((g) => g + 1);
  };
  return { ...state, renew };
}
