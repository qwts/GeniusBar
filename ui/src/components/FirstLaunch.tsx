import { useEffect, useId, useRef, useState } from 'react';
import { useI18n } from '../lib/i18n';
import { canLaunch } from '../model/launch';
import type { LaunchApi } from '../useLaunch';
import { LaunchStatus } from './LaunchForm';

/** The starter soul the app ships, from the shell's `starter_soul`. */
export interface Starter {
  package: string;
  account: string;
  name: string;
  /** The soul's preference order; the first is its default. */
  harnesses: readonly string[];
  /** Whether git works; a stock Mac first needs Apple's command line tools. */
  devTools: boolean;
  /** Whether Apple's installer for them is open now (#101); older shells leave it out. */
  devToolsInstalling?: boolean;
}

/** Opens Apple's installer for the command line tools, then checks again. */
export interface DevTools {
  install: () => Promise<void>;
  recheck: () => void;
}

/** A harness's sign-in for a soul, from the shell's `harness_auth`. */
export type HarnessAuth = (action: 'status' | 'login', harness: string, soul: string) => Promise<{ loggedIn: boolean }>;

type SignIn = { phase: 'checking' | 'signed-in' | 'signed-out' | 'signing-in' } | { phase: 'error'; text: string };

/**
 * After a launch, the harness must be signed in before the soul can answer.
 * Checks once, and offers the harness's own browser sign-in when needed.
 */
function HarnessSignIn({ auth, harness, soul }: { auth: HarnessAuth; harness: string; soul: string }) {
  const [state, setState] = useState<SignIn>({ phase: 'checking' });
  const run = (action: 'status' | 'login') => {
    setState({ phase: action === 'login' ? 'signing-in' : 'checking' });
    auth(action, harness, soul).then(
      ({ loggedIn }) => setState({ phase: loggedIn ? 'signed-in' : 'signed-out' }),
      (error: unknown) => setState({ phase: 'error', text: error instanceof Error ? error.message : String(error) }),
    );
  };
  useEffect(() => { run('status'); }, [harness, soul]); // eslint-disable-line react-hooks/exhaustive-deps
  switch (state.phase) {
    case 'checking':
      return <p className="muted small" role="status">Checking the {harness} sign-in…</p>;
    case 'signed-in':
      return <p className="small" role="status">Ready. Open the companion in the fleet to chat.</p>;
    case 'signing-in':
      return <p className="muted small" role="status">Finish signing in to {harness} in your browser…</p>;
    case 'signed-out':
    case 'error':
      return (
        <div className="detail-actions">
          {state.phase === 'error' && <p className="error small" role="alert">{state.text}</p>}
          <button type="button" onClick={() => run('login')}>Sign in to {harness === 'claude' ? 'Claude' : harness}</button>
        </div>
      );
  }
}

/** How often the waiting step checks again while Apple's installer runs. */
export const DEV_TOOLS_POLL_MS = 5000;
/** Checks after which an installer that never opened counts as cancelled. */
const INSTALLER_NEVER_OPENED_POLLS = 3;

type DevToolsStep = 'explain' | 'opening' | 'waiting' | 'cancelled';

/**
 * Shown instead of the launch until git works on this Mac (#101). It says
 * why before macOS asks, waits while Apple's installer runs, and says how
 * to resume if the owner cancels it. The shell's starter probe
 * (`xcode-select -p`, and whether the installer is open) decides; the
 * launch takes over by itself once the tools are there.
 */
function DevToolsNeeded({ devTools, installing }: { devTools?: DevTools; installing?: boolean }) {
  const { t } = useI18n();
  const [step, setStep] = useState<DevToolsStep>('explain');
  const [error, setError] = useState<string>();
  // Whether this attempt's installer was seen open, and how many checks ran.
  const seen = useRef(false);
  const polls = useRef(0);
  const recheck = useRef(devTools?.recheck);
  recheck.current = devTools?.recheck;
  const install = () => {
    if (!devTools) return;
    seen.current = false;
    polls.current = 0;
    setError(undefined);
    setStep('opening');
    devTools.install().then(() => setStep('waiting'), (e: unknown) => {
      setError(e instanceof Error ? e.message : String(e));
      setStep('cancelled');
    });
  };
  // Poll the probe only while waiting; leaving the step stops it.
  useEffect(() => {
    if (step !== 'waiting') return;
    const timer = setInterval(() => {
      polls.current += 1;
      if (installing === false && !seen.current && polls.current > INSTALLER_NEVER_OPENED_POLLS) setStep('cancelled');
      else recheck.current?.();
    }, DEV_TOOLS_POLL_MS);
    return () => clearInterval(timer);
  }, [step, installing]);
  // The installer closing without the tools means the owner cancelled it.
  useEffect(() => {
    if (step !== 'waiting' || installing === undefined) return;
    if (installing) seen.current = true;
    else if (seen.current) setStep('cancelled');
  }, [step, installing]);
  return (
    <div role="status">
      {(step === 'explain' || step === 'opening') && <p>{t('setup.clt.explain')}</p>}
      {step === 'opening' && <p className="muted small">{t('setup.clt.opening')}</p>}
      {step === 'waiting' && <p>{t('setup.clt.waiting')}</p>}
      {step === 'cancelled' && (
        <>
          <p>{t('setup.clt.cancelled')}</p>
          <p><code className="selectable">xcode-select --install</code></p>
        </>
      )}
      {error && <p className="error small" role="alert">{error}</p>}
      {devTools && step === 'explain' && (
        <div className="detail-actions">
          <button type="button" onClick={install}>{t('setup.clt.continue')}</button>
        </div>
      )}
      {devTools && step === 'cancelled' && (
        <div className="detail-actions">
          <button type="button" onClick={install}>{t('setup.clt.retry')}</button>
        </div>
      )}
    </div>
  );
}

/**
 * The empty roster's one-click start (R4): launches the bundled starter
 * soul with its default harness, which the owner may change first.
 */
export function FirstLaunch({ starter, launcher, auth, devTools, onStart }:
  { starter: Starter; launcher: LaunchApi; auth?: HarnessAuth; devTools?: DevTools; onStart?: () => void }) {
  const { t } = useI18n();
  const [harness, setHarness] = useState(starter.harnesses[0] ?? '');
  // Agent comms is on by default and can be turned off only before start (#71).
  const [comms, setComms] = useState(true);
  const [started, setStarted] = useState(false);
  const ids = useId();
  if (!starter.devTools && !started) return <DevToolsNeeded devTools={devTools} installing={starter.devToolsInstalling} />;
  const ready = canLaunch(launcher.state) && harness.trim() !== '';
  return (
    <form
      className="first-launch"
      aria-label="Start with Starter"
      onSubmit={(e) => {
        e.preventDefault();
        if (!ready) return;
        setStarted(true);
        onStart?.();
        void launcher.launch({ account: starter.account, target: { package: starter.package }, harness, name: starter.name, comms });
      }}
    >
      {!started && <p>No companions yet. Start with {starter.name}, a friendly first companion you can chat with.</p>}
      <datalist id={`${ids}-harnesses`}>{starter.harnesses.map((h) => <option key={h} value={h} />)}</datalist>
      <label>
        <span>Harness</span>
        <input value={harness} readOnly={started} list={`${ids}-harnesses`} onChange={(e) => setHarness(e.target.value)} />
      </label>
      <label>
        <span>{t('launch.comms')}</span>
        <input type="checkbox" role="switch" className="justify-self-start" checked={comms} disabled={started}
          onChange={(e) => setComms(e.target.checked)} />
      </label>
      {!started && <p className="muted small">{t('launch.commsHint')}</p>}
      {started && <LaunchStatus state={launcher.state} />}
      {started && auth && launcher.state.phase === 'launched' && launcher.state.agentId && (
        <HarnessSignIn auth={auth} harness={harness} soul={launcher.state.agentId} />
      )}
      {!started && (
        <div className="detail-actions">
          <button type="submit" disabled={!ready}>Start with Starter</button>
        </div>
      )}
    </form>
  );
}
