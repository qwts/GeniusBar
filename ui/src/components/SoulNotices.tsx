import { createContext, useCallback, useContext, useEffect, useRef, useState } from 'react';
import { Loader2, LogIn } from 'lucide-react';
import {
  harnessSignedIn,
  harnessSignIn,
  setSoulColdWake,
  soulColdWake,
  soulPopulation,
  type SoulColdWake,
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
}

// A source that throws instead of rejecting still settles as a rejection.
const settled = <T,>(run: () => Promise<T>): Promise<T> => new Promise<T>((resolve) => resolve(run()));

export const SoulSourceContext = createContext<SoulSource>({
  population: (agentId) => settled(() => soulPopulation(agentId)),
  coldWake: (agentId) => settled(() => soulColdWake(agentId)),
  setColdWake: (agentId, on) => settled(() => setSoulColdWake(agentId, on)),
  signedIn: (harness, agentId) => settled(() => harnessSignedIn(harness, agentId)),
  signIn: (harness, agentId) => settled(() => harnessSignIn(harness, agentId)),
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

/**
 * The expired or missing harness sign-in banner above a soul's chat
 * (Lovable `SoulNotices`). Shown while agent-bot's census records the
 * failure; its button runs the harness's own sign-in, then reads the
 * census again. The Lovable copy notice is not here: agent-bot does not
 * say a launched soul is a copy.
 */
export function SoulNotices({ soul, refresh = 0 }: { soul: CensusRow; refresh?: number }) {
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
