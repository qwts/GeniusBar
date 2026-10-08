import { useEffect, useId, useRef, useState } from 'react';
import { AlertTriangle, BookOpen, Check, Circle, ExternalLink, Loader2 } from 'lucide-react';
import { useI18n } from '../lib/i18n';
import { devBuild, firstNotReady, hostChecking, hostReady, type HostCapabilities, type HostTool } from '../model/host';
import { canLaunch } from '../model/launch';
import type { LaunchApi } from '../useLaunch';
import { LaunchStatus } from './LaunchForm';
import { actions, errorLine, mutedLine, primaryButton, textLink } from './ui';

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

/** "Get help" on the Windows first launch (#46): the page About's "Report a problem" opens, through the shell's opener. */
export interface HostHelp {
  url: string;
  /** Opens the page in the owner's browser; rejects when the shell would not. */
  open: (url: string) => Promise<void>;
}

/** A harness's sign-in for a soul, from the shell's `harness_auth`. */
export type HarnessAuth = (action: 'status' | 'login', harness: string, soul: string) => Promise<{ loggedIn: boolean }>;

type SignIn = { phase: 'checking' | 'signed-in' | 'signed-out' | 'signing-in' } | { phase: 'error'; text: string };

/**
 * After a launch, the harness must be signed in before the soul can answer.
 * Checks once, and offers the harness's own browser sign-in when needed.
 */
function HarnessSignIn({ auth, harness, soul }: { auth: HarnessAuth; harness: string; soul: string }) {
  const { t } = useI18n();
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
      return <p className={mutedLine} role="status">{t('starter.checkingSignIn', { harness })}</p>;
    case 'signed-in':
      return <p className="m-0 text-xs text-foreground" role="status">{t('starter.ready')}</p>;
    case 'signing-in':
      return <p className={mutedLine} role="status">{t('starter.signingIn', { harness })}</p>;
    case 'signed-out':
    case 'error':
      return (
        <div className={actions}>
          {state.phase === 'error' && <p className={`${errorLine} min-w-0 flex-1`} role="alert">{state.text}</p>}
          <button type="button" className={primaryButton} onClick={() => run('login')}>{t('starter.signIn', { harness: harness === 'claude' ? 'Claude' : harness })}</button>
        </div>
      );
  }
}

/** A label beside its control, as the starter's two fields. */
const row = 'grid grid-cols-[64px_1fr] items-center gap-2';

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
    <div role="status" className="grid gap-2 text-sm">
      {(step === 'explain' || step === 'opening') && <p className="m-0">{t('setup.clt.explain')}</p>}
      {step === 'opening' && <p className={mutedLine}>{t('setup.clt.opening')}</p>}
      {step === 'waiting' && <p className="m-0">{t('setup.clt.waiting')}</p>}
      {step === 'cancelled' && (
        <>
          <p className="m-0">{t('setup.clt.cancelled')}</p>
          <p className="m-0"><code className="selectable rounded bg-muted px-1.5 py-0.5">xcode-select --install</code></p>
        </>
      )}
      {error && <p className={errorLine} role="alert">{error}</p>}
      {devTools && step === 'explain' && (
        <div className={actions}>
          <button type="button" className={primaryButton} onClick={install}>{t('setup.clt.continue')}</button>
        </div>
      )}
      {devTools && step === 'cancelled' && (
        <div className={actions}>
          <button type="button" className={primaryButton} onClick={install}>{t('setup.clt.retry')}</button>
        </div>
      )}
    </div>
  );
}

/** The design's state marks: a green check, an empty circle, a warning triangle, a spinner. */
const TOOL_MARK = {
  checking: { Icon: Loader2, className: 'text-primary motion-safe:animate-spin' },
  ready: { Icon: Check, className: 'text-success' },
  missing: { Icon: Circle, className: 'text-muted-foreground' },
  failed: { Icon: AlertTriangle, className: 'text-destructive' },
} as const;

/** The design's build note: only when the host says unsigned, or no updater. */
function BuildNote({ host }: { host: HostCapabilities }) {
  const { t } = useI18n();
  if (!devBuild(host)) return null;
  return <p className={mutedLine} role="note">{t('host.devBuild')}</p>;
}

/**
 * The Windows first launch (#46), from the host's capability results: the
 * bundled Git, Node and command-line tools, each as the shell's probe found
 * it. A row that is missing or could not start says so, with Retry (the
 * shell probes again; focus lands on the first row still not ready) and
 * Get help. Nothing here opens an installer: a Windows PC has nothing to
 * install, as the bundle carries its tools (ADR-0046 decision 6). Once
 * every row is ready the usual start takes over.
 */
function HostReadiness({ host, onRecheck, help }: { host: HostCapabilities; onRecheck?: () => void; help?: HostHelp }) {
  const { t } = useI18n();
  const ids = useId();
  const rows = useRef(new Map<string, HTMLLIElement>());
  const [helpError, setHelpError] = useState<string | null>(null);
  // After a Retry, focus goes to the first row still not ready.
  const focusPending = useRef(false);
  const checking = hostChecking(host);
  useEffect(() => {
    if (!focusPending.current || checking) return;
    focusPending.current = false;
    const first = firstNotReady(host);
    if (first) rows.current.get(first.id)?.focus();
  }, [host, checking]);
  const retry = () => {
    if (!onRecheck) return;
    focusPending.current = true;
    onRecheck();
  };
  const getHelp = () => {
    if (!help) return;
    setHelpError(null);
    help.open(help.url).catch((e: unknown) => setHelpError(t('about.openFailed', { message: e instanceof Error ? e.message : String(e) })));
  };
  const detail = (tool: HostTool, name: string) => {
    if (tool.state === 'missing') return t('host.missing', { tool: name });
    if (tool.state === 'failed') return t('host.failed', { tool: name, hostMessage: tool.message ?? t('host.noDetail') });
    return null;
  };
  return (
    <div className="grid gap-2 text-sm">
      <p id={`${ids}-title`} className="m-0 font-medium">{t('host.title')}</p>
      <ul className="m-0 grid list-none gap-2 p-0" aria-labelledby={`${ids}-title`} aria-live="polite">
        {host.tools.map((tool) => {
          const { Icon, className } = TOOL_MARK[tool.state];
          const name = t(`host.tool.${tool.id}`);
          const text = detail(tool, name);
          return (
            <li key={tool.id} tabIndex={-1} ref={(el) => { if (el) rows.current.set(tool.id, el); else rows.current.delete(tool.id); }}
              className="grid gap-1.5 rounded-sm outline-none focus-visible:ring-2 focus-visible:ring-ring">
              <p className="m-0 flex flex-wrap items-center gap-2">
                <Icon className={`size-4 shrink-0 ${className}`} aria-hidden />
                <span>{name} — {t(`host.state.${tool.state}`)}</span>
              </p>
              {text && <p className="m-0 pl-6 text-xs text-muted-foreground">{text}</p>}
              {text && (
                <div className="flex flex-wrap items-center gap-3 pl-6">
                  {onRecheck && <button type="button" className={primaryButton} onClick={retry} disabled={checking}>{t('host.retry')}</button>}
                  {help && (
                    <button type="button" className={textLink} onClick={getHelp}>
                      <ExternalLink className="size-3" aria-hidden />{t('host.help')}
                    </button>
                  )}
                </div>
              )}
            </li>
          );
        })}
      </ul>
      {helpError && <p className={errorLine} role="alert">{helpError}</p>}
      <BuildNote host={host} />
    </div>
  );
}

/**
 * The empty roster's one-click start (R4): launches the bundled starter
 * soul, Genius (#287), with its default harness, which the owner may
 * change first. "Meet Genius, your guide" leads, with the App guide a
 * click away, as the design's first start has it.
 */
export function FirstLaunch({ starter, launcher, auth, devTools, onStart, onAbout, onGuide, host, onRecheckHost, help }:
  { starter: Starter; launcher: LaunchApi; auth?: HarnessAuth; devTools?: DevTools; onStart?: () => void;
    /** Opens About GeniusBar (#290), reachable before the first companion exists. */
    onAbout?: () => void;
    /** Opens the App guide (#287), likewise. */
    onGuide?: () => void;
    /** The host's capability results (#46); on Windows they replace the command-line-tools step. Absent or null keeps today's flow. */
    host?: HostCapabilities | null;
    /** Asks the shell to probe the host again (Retry). */
    onRecheckHost?: () => void;
    /** Where "Get help" goes. */
    help?: HostHelp }) {
  const { t } = useI18n();
  const [harness, setHarness] = useState(starter.harnesses[0] ?? '');
  // Agent comms is on by default and can be turned off only before start (#71).
  const [comms, setComms] = useState(true);
  const [started, setStarted] = useState(false);
  const ids = useId();
  // Copy follows the host's platform, never the user agent: a Windows PC
  // sees its bundled tools' readiness; everywhere else the flow is unchanged.
  const windows = host?.platform === 'windows';
  if (windows && !started && !hostReady(host)) return <HostReadiness host={host} onRecheck={onRecheckHost} help={help} />;
  if (!windows && !starter.devTools && !started) return <DevToolsNeeded devTools={devTools} installing={starter.devToolsInstalling} />;
  const ready = canLaunch(launcher.state) && harness.trim() !== '';
  return (
    <form
      className="grid gap-2 text-sm"
      aria-label={t('starter.start', { name: starter.name })}
      onSubmit={(e) => {
        e.preventDefault();
        if (!ready) return;
        setStarted(true);
        onStart?.();
        void launcher.launch({ account: starter.account, target: { package: starter.package }, harness, name: starter.name, comms });
      }}
    >
      {!started && <p className="m-0">{t('starter.intro', { name: starter.name })}</p>}
      {!started && onGuide && (
        <p className="m-0"><button type="button" className={textLink} aria-haspopup="dialog" onClick={onGuide}><BookOpen className="size-3" aria-hidden />{t('guide.open')}</button></p>
      )}
      <datalist id={`${ids}-harnesses`}>{starter.harnesses.map((h) => <option key={h} value={h} />)}</datalist>
      <label className={row}>
        <span className="text-xs text-muted-foreground">{t('field.harness')}</span>
        <input value={harness} readOnly={started} list={`${ids}-harnesses`} onChange={(e) => setHarness(e.target.value)}
          className="h-8 w-full rounded-md border border-input bg-transparent px-2 font-mono text-xs shadow-sm read-only:border-transparent read-only:px-0 read-only:shadow-none" />
      </label>
      <label className={row}>
        <span className="text-xs text-muted-foreground">{t('launch.comms')}</span>
        <input type="checkbox" role="switch" className="justify-self-start" checked={comms} disabled={started}
          onChange={(e) => setComms(e.target.checked)} />
      </label>
      {!started && <p className={mutedLine}>{t('launch.commsHint')}</p>}
      {windows && !started && <BuildNote host={host} />}
      {started && <LaunchStatus state={launcher.state} />}
      {started && auth && launcher.state.phase === 'launched' && launcher.state.agentId && (
        <HarnessSignIn auth={auth} harness={harness} soul={launcher.state.agentId} />
      )}
      {!started && (
        <div className={actions}>
          {onAbout && <button type="button" className={`${textLink} mr-auto`} onClick={onAbout}>{t('about.link')}</button>}
          <button type="submit" className={primaryButton} disabled={!ready}>{t('starter.start', { name: starter.name })}</button>
        </div>
      )}
    </form>
  );
}
