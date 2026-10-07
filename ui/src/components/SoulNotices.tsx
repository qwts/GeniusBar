import { createContext, useCallback, useContext, useEffect, useRef, useState } from 'react';
import { Loader2, LogIn, Zap } from 'lucide-react';
import {
  harnessSignedIn,
  harnessSignIn,
  setSoulColdWake,
  setSoulMode,
  setSoulModel,
  soulColdWake,
  soulMode,
  soulModel,
  soulPopulation,
  type SoulColdWake,
  type SoulMode,
  type SoulModel,
  type SoulPopulation,
} from '../bridge';
import { displayName, type CensusRow } from '../model/census';
import { useI18n } from '../lib/i18n';

/**
 * Where a soul's Details rows and notices come from (#122): agent-bot
 * through the bridge in the app, fixtures in the preview.
 */
export interface SoulSource {
  population: (agentId: string) => Promise<SoulPopulation | null>;
  coldWake: (agentId: string) => Promise<SoulColdWake | null>;
  setColdWake: (agentId: string, on: boolean) => Promise<SoulColdWake>;
  signedIn: (harness: string, agentId: string) => Promise<boolean | null>;
  signIn: (harness: string, agentId: string) => Promise<boolean>;
  mode: (agentId: string) => Promise<SoulMode | null>;
  setMode: (agentId: string, mode: SoulMode) => Promise<SoulMode>;
  /** The soul's model and its harness's list (#128); null when agent-bot cannot say. */
  model: (agentId: string) => Promise<SoulModel | null>;
  /** Sets the model, or (null) returns to the harness default; owner-gated. */
  setModel: (agentId: string, model: string | null) => Promise<SoulModel>;
}

// A source that throws instead of rejecting still settles as a rejection.
const settled = <T,>(run: () => Promise<T>): Promise<T> => new Promise<T>((resolve) => resolve(run()));

export const SoulSourceContext = createContext<SoulSource>({
  population: (agentId) => settled(() => soulPopulation(agentId)),
  coldWake: (agentId) => settled(() => soulColdWake(agentId)),
  setColdWake: (agentId, on) => settled(() => setSoulColdWake(agentId, on)),
  signedIn: (harness, agentId) => settled(() => harnessSignedIn(harness, agentId)),
  signIn: (harness, agentId) => settled(() => harnessSignIn(harness, agentId)),
  mode: (agentId) => settled(() => soulMode(agentId)),
  setMode: (agentId, mode) => settled(() => setSoulMode(agentId, mode)),
  model: (agentId) => settled(() => soulModel(agentId)),
  setModel: (agentId, model) => settled(() => setSoulModel(agentId, model)),
});

/**
 * The soul's population census record (App slug, a failed harness
 * sign-in), read when the soul is shown and on each refresh. `loaded` turns
 * true once the first read settles, even when agent-bot cannot say.
 */
export function useSoulPopulation(agentId: string, refresh = 0) {
  const source = useContext(SoulSourceContext);
  const [state, setState] = useState<{ agentId: string; record: SoulPopulation | null } | null>(null);
  const ticket = useRef(0);
  const reload = useCallback(() => {
    const mine = ++ticket.current;
    void source.population(agentId).then(
      (record) => { if (ticket.current === mine) setState({ agentId, record }); },
      () => { if (ticket.current === mine) setState({ agentId, record: null }); },
    );
  }, [agentId, source]);
  useEffect(reload, [reload, refresh]);
  const current = state?.agentId === agentId ? state : null;
  return { record: current?.record ?? null, loaded: current !== null, reload };
}

// A mode agent-bot accepted reaches every control showing that soul (the
// ⓘ sheet's switch and the banner above the chat), not only the one used.
const modeChanges = new Set<(agentId: string, mode: SoulMode) => void>();

/**
 * The soul's execution mode (#122, agent-bot `soul mode`): read when shown
 * and on refresh, null while agent-bot cannot say. A change asks the owner
 * through agent-bot; a refusal leaves the mode where it was and says why.
 * Not locked while the soul runs: agent-bot applies the mode on its next
 * permission request. Tickets work as in useSoulColdWake.
 */
export function useSoulMode(agentId: string, refresh = 0) {
  const source = useContext(SoulSourceContext);
  const [mode, setMode] = useState<SoulMode | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const ticket = useRef(0);
  const changing = useRef(false);
  const heard = useRef<((id: string, next: SoulMode) => void) | null>(null);
  useEffect(() => {
    ticket.current += 1;
    changing.current = false;
    setMode(null);
    setError(null);
    setSaving(false);
  }, [agentId]);
  useEffect(() => {
    if (changing.current) return;
    const mine = ++ticket.current;
    void source.mode(agentId).then((result) => { if (ticket.current === mine) setMode(result); }, () => {});
  }, [agentId, refresh, source]);
  useEffect(() => {
    const hear = (id: string, next: SoulMode) => {
      if (id !== agentId || changing.current) return;
      ticket.current += 1;
      setMode(next);
      setError(null);
    };
    heard.current = hear;
    modeChanges.add(hear);
    return () => { modeChanges.delete(hear); };
  }, [agentId]);
  const change = (next: SoulMode) => {
    const mine = ++ticket.current;
    const latest = () => ticket.current === mine;
    changing.current = true;
    setSaving(true);
    setError(null);
    source.setMode(agentId, next)
      .then((result) => {
        if (!latest()) return;
        setMode(result);
        for (const tell of [...modeChanges]) if (tell !== heard.current) tell(agentId, result);
      })
      .catch((e: unknown) => { if (latest()) setError(e instanceof Error ? e.message : String(e)); })
      .finally(() => {
        if (!latest()) return;
        changing.current = false;
        setSaving(false);
      });
  };
  return { mode, saving, error, change };
}

/** Every companion's mode at once: all safe, all Auto-Pilot, or mixed. */
export type FleetModeState = SoulMode | 'mixed';

/**
 * The fleet's execution mode for the menu footer (Lovable `GeniusBarItem`
 * mode pill, #122): one read per rostered soul, souls agent-bot cannot
 * speak for left out, null while none answered. A change sets every soul
 * that differs, one after another through agent-bot (each may ask the
 * owner); the first refusal stops the run, keeps what was set, and says
 * why. Accepted modes reach the per-soul controls through modeChanges.
 */
export function useFleetMode(roster: readonly CensusRow[], refresh = 0) {
  const source = useContext(SoulSourceContext);
  const [modes, setModes] = useState<Record<string, SoulMode>>({});
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const ticket = useRef(0);
  const ids = roster.map((soul) => soul.agentId).join('\n');
  useEffect(() => {
    const mine = ++ticket.current;
    const list = ids ? ids.split('\n') : [];
    void Promise.all(list.map((id) => source.mode(id).then((mode) => [id, mode] as const, () => [id, null] as const)))
      .then((pairs) => {
        if (ticket.current !== mine) return;
        const next: Record<string, SoulMode> = {};
        for (const [id, mode] of pairs) if (mode) next[id] = mode;
        setModes(next);
      });
  }, [ids, refresh, source]);
  useEffect(() => {
    const hear = (id: string, next: SoulMode) => setModes((prev) => (id in prev ? { ...prev, [id]: next } : prev));
    modeChanges.add(hear);
    return () => { modeChanges.delete(hear); };
  }, []);
  const known = Object.values(modes);
  const mode: FleetModeState | null = known.length === 0 ? null
    : known.every((m) => m === 'autopilot') ? 'autopilot'
    : known.every((m) => m === 'safe') ? 'safe' : 'mixed';
  const change = async (next: SoulMode) => {
    setSaving(true);
    setError(null);
    try {
      for (const [id, current] of Object.entries(modes)) {
        if (current === next) continue;
        const result = await source.setMode(id, next);
        setModes((prev) => ({ ...prev, [id]: result }));
        for (const tell of [...modeChanges]) tell(id, result);
      }
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  };
  return { mode, count: known.length, saving, error, change };
}

// A model agent-bot accepted reaches every control showing that soul (the
// Details row and the ⓘ sheet's row), not only the one used.
const modelChanges = new Set<(agentId: string, setting: SoulModel) => void>();

/**
 * The soul's model (#128, agent-bot `soul model`): read when shown and on
 * refresh, null while agent-bot cannot say. A change asks the owner through
 * agent-bot; a refusal leaves the model where it was and says why. The
 * daemon applies it on the soul's next turn. Tickets work as in useSoulMode.
 */
export function useSoulModel(agentId: string, refresh = 0) {
  const source = useContext(SoulSourceContext);
  const [setting, setSetting] = useState<SoulModel | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const ticket = useRef(0);
  const changing = useRef(false);
  const heard = useRef<((id: string, next: SoulModel) => void) | null>(null);
  useEffect(() => {
    ticket.current += 1;
    changing.current = false;
    setSetting(null);
    setError(null);
    setSaving(false);
  }, [agentId]);
  useEffect(() => {
    if (changing.current) return;
    const mine = ++ticket.current;
    void source.model(agentId).then((result) => { if (ticket.current === mine) setSetting(result); }, () => {});
  }, [agentId, refresh, source]);
  useEffect(() => {
    const hear = (id: string, next: SoulModel) => {
      if (id !== agentId || changing.current) return;
      ticket.current += 1;
      setSetting(next);
      setError(null);
    };
    heard.current = hear;
    modelChanges.add(hear);
    return () => { modelChanges.delete(hear); };
  }, [agentId]);
  const change = (next: string | null) => {
    const mine = ++ticket.current;
    const latest = () => ticket.current === mine;
    changing.current = true;
    setSaving(true);
    setError(null);
    source.setModel(agentId, next)
      .then((result) => {
        if (!latest()) return;
        setSetting(result);
        for (const tell of [...modelChanges]) if (tell !== heard.current) tell(agentId, result);
      })
      .catch((e: unknown) => { if (latest()) setError(e instanceof Error ? e.message : String(e)); })
      .finally(() => {
        if (!latest()) return;
        changing.current = false;
        setSaving(false);
      });
  };
  return { setting, saving, error, change };
}

/**
 * The design's Auto-Pilot strip (Lovable `MenuBar`), here per soul: shown
 * while agent-bot says the soul is on Auto-Pilot; Turn off asks agent-bot
 * (owner-gated) for Safe Mode, and a refusal keeps the strip with the reason.
 */
export function AutopilotBanner({ soul, refresh = 0 }: { soul: CensusRow; refresh?: number }) {
  const { t } = useI18n();
  const { mode, saving, error, change } = useSoulMode(soul.agentId, refresh);
  if (mode !== 'autopilot') return null;
  return (
    <div role="status" className="flex flex-wrap items-center justify-center gap-x-3 gap-y-0.5 bg-warning px-4 py-1 text-[11px] font-semibold text-warning-foreground">
      <Zap className="size-3" aria-hidden /> {t('mode.banner', { name: displayName(soul) })}
      <button type="button" disabled={saving} onClick={() => change('safe')}
        className="underline underline-offset-2 disabled:opacity-60">{t('mode.turnOff')}</button>
      {error && <span role="alert" className="basis-full text-center font-normal">{t('mode.failed', { message: error })}</span>}
    </div>
  );
}

/**
 * The expired or missing harness sign-in banner above a soul's chat
 * (Lovable `SoulNotices`). Shown while agent-bot's census records the
 * failure; its button runs the harness's own sign-in, then reads the
 * census again. The Lovable copy notice is not here: agent-bot does not
 * say a launched soul is a copy.
 */
function SignInNotice({ soul, refresh }: { soul: CensusRow; refresh: number }) {
  const { t } = useI18n();
  const source = useContext(SoulSourceContext);
  const { record, reload } = useSoulPopulation(soul.agentId, refresh);
  const [signing, setSigning] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const failure = record?.harnessAuth;
  if (!failure) return null;
  const { harness } = failure;
  const name = displayName(soul);
  const signIn = () => {
    setSigning(true);
    setError(null);
    source.signIn(harness, soul.agentId)
      .then((loggedIn) => { if (!loggedIn) setError(t('login.signedOut')); })
      .catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)))
      .finally(() => { setSigning(false); reload(); });
  };
  return (
    <div className="space-y-2 border-b border-border p-3">
      <div role="alert" className="flex items-start gap-3 rounded-md border border-destructive/50 bg-destructive/10 p-3">
        <LogIn className="mt-0.5 size-4 text-destructive" aria-hidden />
        <div className="min-w-0 flex-1">
          <p className="m-0 text-sm font-semibold">
            {t(failure.status === 'expired' ? 'login.expiredTitle' : 'login.signedOutTitle', { harness })}
          </p>
          <p className="m-0 text-xs text-muted-foreground">{t('login.expiredBody', { name, harness })}</p>
          {error && <p className="error m-0 text-[11px]">{t('login.failed', { message: error })}</p>}
        </div>
        <button type="button" disabled={signing} onClick={signIn}
          className="inline-flex min-h-8 shrink-0 items-center gap-1.5 rounded-md bg-primary px-3 text-sm font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-60">
          {signing ? <><Loader2 className="size-4 animate-spin" aria-hidden />{t('login.signingIn', { harness })}</> : t('login.signIn')}
        </button>
      </div>
    </div>
  );
}

/**
 * The notices above a soul's chat (Lovable `SoulNotices` and the
 * Auto-Pilot strip): Auto-Pilot first, then an expired sign-in; both can show.
 */
export function SoulNotices({ soul, refresh = 0 }: { soul: CensusRow; refresh?: number }) {
  return (
    <>
      <AutopilotBanner soul={soul} refresh={refresh} />
      <SignInNotice soul={soul} refresh={refresh} />
    </>
  );
}
