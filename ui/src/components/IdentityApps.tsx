import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { BridgeError, inApp } from '../bridge';
import { useI18n, type Translate } from '../lib/i18n';
import type { MessageKey } from '../locales/en';

// GitHub identities (#67), backed by agent-bot's managed Apps
// (agent-bot-identity #373): which GitHub App each companion acts as, and
// the owner's set up, connect, rotate and assign. agent-bot holds every
// key; GeniusBar sees only the secret-free list and passes a key file's
// path, picked in the native open dialog by the Rust shell. With the
// `github-identity` add-on off the list is empty and mutations answer
// `identity-app-disabled`.

/** Where an App is installed, as agent-bot cached it on connect or rotation. */
export interface IdentityInstallation {
  id: number;
  account: string;
  repositorySelection: 'all' | 'selected';
}

/** One row of `agent-bot identity apps list --json`. */
export interface IdentityApp {
  slug: string;
  botLogin: string;
  issuerPresent: boolean;
  keyPresent: boolean;
  installations: IdentityInstallation[];
  harnesses: string[];
  souls: string[];
  liveMint: { status: 'ready' | 'failed' | 'unknown'; code?: string | null; checkedAt?: string | null };
}

/** `{id, slug, installUrl}`; a rotation adds the retired key's fingerprint. */
export interface IdentityAppResult {
  id: string;
  slug: string;
  installUrl: string;
  retired?: string | null;
}

export type IdentityCreateStatus =
  | { status: 'pending'; localUrl?: string }
  | { status: 'complete'; result: IdentityAppResult }
  | { status: 'failed'; error: { code: string; message: string } };

/** Where identities come from: agent-bot in the app; tests and the preview pass their own. */
export interface IdentityAppsSource {
  /** Rejects when the bundled agent-bot has no `identity apps`, which hides the feature. */
  list: () => Promise<IdentityApp[]>;
  /** Owner-gated by agent-bot; resolves once its loopback page is listening. */
  create: () => Promise<{ handle: number; localUrl: string }>;
  createStatus: (handle: number) => Promise<IdentityCreateStatus>;
  cancelCreate: (handle: number) => Promise<void>;
  /** The shell asks for the key file with `prompt`; owner-gated by agent-bot. */
  connect: (id: string, prompt: string) => Promise<IdentityAppResult>;
  rotateKey: (slug: string, prompt: string) => Promise<IdentityAppResult>;
  assign: (slug: string, target: { soul: string } | { harness: string }) => Promise<unknown>;
  /** Opens the create page or a github.com page in the owner's browser. */
  open: (url: string) => Promise<void>;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);
const strings = (value: unknown): string[] => (Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string') : []);

export function normalizeIdentityApp(raw: unknown): IdentityApp | null {
  if (!isRecord(raw) || typeof raw.slug !== 'string' || raw.slug === '') return null;
  const mint = isRecord(raw.liveMint) ? raw.liveMint : {};
  const status = mint.status === 'ready' || mint.status === 'failed' ? mint.status : 'unknown';
  return {
    slug: raw.slug,
    botLogin: typeof raw.botLogin === 'string' ? raw.botLogin : `${raw.slug}[bot]`,
    issuerPresent: raw.issuerPresent === true,
    keyPresent: raw.keyPresent === true,
    installations: Array.isArray(raw.installations)
      ? raw.installations.flatMap((i): IdentityInstallation[] => (isRecord(i) && typeof i.id === 'number' && typeof i.account === 'string'
        ? [{ id: i.id, account: i.account, repositorySelection: i.repositorySelection === 'all' ? 'all' : 'selected' }] : []))
      : [],
    harnesses: strings(raw.harnesses),
    souls: strings(raw.souls),
    liveMint: status === 'unknown' ? { status }
      : { status, code: typeof mint.code === 'string' ? mint.code : null, checkedAt: typeof mint.checkedAt === 'string' ? mint.checkedAt : null },
  };
}

export function normalizeIdentityApps(raw: unknown): IdentityApp[] | null {
  if (!isRecord(raw) || !Array.isArray(raw.apps)) return null;
  return raw.apps.map(normalizeIdentityApp).filter((a): a is IdentityApp => a !== null);
}

function normalizeResult(raw: unknown): IdentityAppResult | null {
  if (!isRecord(raw) || typeof raw.slug !== 'string' || typeof raw.installUrl !== 'string') return null;
  return {
    id: typeof raw.id === 'string' ? raw.id : '',
    slug: raw.slug,
    installUrl: raw.installUrl,
    ...(raw.retired !== undefined ? { retired: typeof raw.retired === 'string' ? raw.retired : null } : {}),
  };
}

function normalizeCreateStatus(raw: unknown): IdentityCreateStatus | null {
  if (!isRecord(raw)) return null;
  if (raw.status === 'pending') return { status: 'pending', ...(typeof raw.localUrl === 'string' ? { localUrl: raw.localUrl } : {}) };
  if (raw.status === 'complete') {
    const result = normalizeResult(raw.result);
    return result && { status: 'complete', result };
  }
  if (raw.status === 'failed') {
    const error = isRecord(raw.error) ? raw.error : {};
    return { status: 'failed', error: {
      code: typeof error.code === 'string' ? error.code : 'identity-app-failed',
      message: typeof error.message === 'string' ? error.message : 'App creation failed',
    } };
  }
  return null;
}

async function call<T>(command: string, args: Record<string, unknown>, normalize: (raw: unknown) => T | null, fallback: string): Promise<T> {
  let raw: unknown;
  try {
    raw = await invoke<unknown>(command, args);
  } catch (error) {
    const e = error as { code?: unknown; message?: unknown };
    throw new BridgeError(typeof e?.code === 'string' ? e.code : 'identity-app-failed',
      typeof e?.message === 'string' ? e.message : String(error));
  }
  const result = normalize(raw);
  if (result === null) throw new BridgeError('identity-app-failed', fallback);
  return result;
}

const anything = (raw: unknown) => raw ?? {};

export const liveIdentityApps: IdentityAppsSource = {
  list: () => call('identity_apps_list', {}, normalizeIdentityApps, 'agent-bot gave no App list'),
  create: () => call('identity_app_create', {}, (raw) => (isRecord(raw) && typeof raw.handle === 'number' && typeof raw.localUrl === 'string'
    ? { handle: raw.handle, localUrl: raw.localUrl } : null), 'agent-bot gave no App creation page'),
  createStatus: (handle) => call('identity_app_create_status', { handle }, normalizeCreateStatus, 'agent-bot gave no App creation status'),
  cancelCreate: (handle) => call('identity_app_create_cancel', { handle }, () => undefined, ''),
  connect: (id, prompt) => call('identity_app_connect', { id, prompt }, normalizeResult, 'agent-bot gave no App'),
  rotateKey: (slug, prompt) => call('identity_app_rotate_key', { slug, prompt }, normalizeResult, 'agent-bot gave no App'),
  assign: (slug, target) => call('identity_app_assign', { slug, ...target }, anything, 'agent-bot gave no assignment'),
  open: (url) => call('identity_app_open', { url }, () => undefined, ''),
};

/** The live source inside the app (not in static renders); null elsewhere, which hides identities. */
export function defaultIdentityAppsSource(isStatic?: boolean): IdentityAppsSource | null {
  return inApp() && !isStatic ? liveIdentityApps : null;
}

export interface IdentityAppsApi {
  source: IdentityAppsSource | null;
  /** Nothing to show: no source, or the list could not be read (an older bundle). */
  hidden: boolean;
  /** Null until the first read answers. */
  apps: IdentityApp[] | null;
  reload: () => void;
}

const HIDDEN: IdentityAppsApi = { source: null, hidden: true, apps: null, reload: () => {} };
const IdentityAppsContext = createContext<IdentityAppsApi>(HIDDEN);

export function useIdentityApps(): IdentityAppsApi {
  return useContext(IdentityAppsContext);
}

/**
 * Holds agent-bot's App list for the whole app, so the menu section and
 * every Details row agree. A failed read hides both: an older bundle has
 * no `identity apps`. Only the latest read settles.
 */
export function IdentityAppsProvider({ source, children }: { source: IdentityAppsSource | null; children: ReactNode }) {
  const [apps, setApps] = useState<IdentityApp[] | null>(null);
  const [failed, setFailed] = useState(false);
  const ticket = useRef(0);
  const reload = useCallback(() => {
    if (!source) return;
    const mine = ++ticket.current;
    source.list().then(
      (next) => { if (ticket.current === mine) { setApps(next); setFailed(false); } },
      () => { if (ticket.current === mine) { setApps(null); setFailed(true); } },
    );
  }, [source]);
  const api = useMemo<IdentityAppsApi>(() => (source
    ? { source, hidden: failed, apps: failed ? null : apps, reload }
    : HIDDEN), [source, failed, apps, reload]);
  return <IdentityAppsContext.Provider value={api}>{children}</IdentityAppsContext.Provider>;
}

/** The App a companion acts as: the list row whose `souls` names it. */
export function appFor(apps: readonly IdentityApp[] | null, agentId: string): IdentityApp | null {
  return apps?.find((app) => app.souls.includes(agentId)) ?? null;
}

export type IdentityStatus = 'ready' | 'keyMissing' | 'mintFailing' | 'unknown';

export function identityStatus(app: IdentityApp): IdentityStatus {
  if (!app.keyPresent) return 'keyMissing';
  if (app.liveMint.status === 'failed') return 'mintFailing';
  if (app.liveMint.status === 'ready') return 'ready';
  return 'unknown';
}

export const STATUS_TEXT: Record<IdentityStatus, MessageKey> = {
  ready: 'identity.status.ready',
  keyMissing: 'identity.status.keyMissing',
  mintFailing: 'identity.status.mintFailing',
  unknown: 'identity.status.unknown',
};

/** A failure's text; the add-on being off gets GeniusBar's own explanation. */
export function identityFailure(error: unknown, t: Translate): string | null {
  const e = error as { code?: unknown; message?: unknown };
  if (e?.code === 'identity-app-cancelled') return null;
  if (e?.code === 'identity-app-disabled') return t('identity.disabled');
  return typeof e?.message === 'string' ? e.message : String(error);
}

/**
 * Runs one owner-gated change at a time and reloads the list after it.
 * `busy` names what is waiting; a refusal is kept as `error`.
 */
export function useIdentityAction() {
  const { source, reload } = useIdentityApps();
  const { t } = useI18n();
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const run = useCallback(<T,>(scope: string, action: (source: IdentityAppsSource) => Promise<T>, done?: (result: T) => void) => {
    if (!source) return;
    setBusy(scope);
    setError(null);
    action(source)
      .then((result) => done?.(result), (e: unknown) => setError(identityFailure(e, t)))
      .finally(() => { setBusy(null); reload(); });
  }, [source, reload, t]);
  return { busy, error, run, setError };
}

const smallButton = 'min-h-6 rounded border border-border px-2 font-sans text-[11px] hover:bg-accent disabled:opacity-50';

/** An App ID field and the key-file button that connects it. */
export function ConnectForm({ onConnected, label }: { onConnected?: (result: IdentityAppResult) => void; label?: string }) {
  const { t } = useI18n();
  const [id, setId] = useState('');
  const { busy, error, run } = useIdentityAction();
  const valid = /^\d{1,20}$/.test(id.trim());
  return (
    <div className="grid gap-1 font-sans">
      <div className="flex items-center gap-1">
        <input value={id} onChange={(e) => setId(e.target.value)} inputMode="numeric" placeholder={t('identity.appId')}
          aria-label={label ?? t('identity.appId')}
          className="h-6 w-28 rounded border border-input bg-transparent px-1.5 font-mono text-[11px] text-foreground" />
        <button type="button" className={smallButton} disabled={!valid || busy !== null}
          onClick={() => run('connect', (s) => s.connect(id.trim(), t('identity.pickKey')), (result) => onConnected?.(result))}>
          {t('identity.chooseKey')}
        </button>
      </div>
      <span className="text-[11px] text-muted-foreground">{t('identity.connectHint')}</span>
      {busy && <span className="text-[11px] text-muted-foreground" role="status">{t('identity.waiting')}</span>}
      {error && <span className="error text-[11px]" role="alert">{t('identity.failed', { message: error })}</span>}
    </div>
  );
}

/** What a rotation leaves for the owner: deleting the old key on github.com. */
export function RotatedNotice({ result }: { result: IdentityAppResult }) {
  const { t } = useI18n();
  return (
    <span className="block font-sans text-[11px] text-muted-foreground" role="status">
      {t('identity.rotated', { app: result.slug })}{' '}
      {result.retired && <>{t('identity.retired', { fingerprint: result.retired })}{' '}</>}
      {t('identity.deleteOld')}
    </span>
  );
}

/**
 * The Details tab's Acts as row value (#67, #122 "GitHub App row"): the
 * App this companion acts as on GitHub, or "your account"; "Change…" lists
 * the Apps with a key to assign it to, "Rotate key…" replaces the current
 * App's key, and "Connect…" shows while agent-bot manages none.
 */
export function ActsAs({ agentId, name }: { agentId: string; name: string }) {
  const { t } = useI18n();
  const { apps } = useIdentityApps();
  const { busy, error, run } = useIdentityAction();
  const [rotated, setRotated] = useState<IdentityAppResult | null>(null);
  const [connecting, setConnecting] = useState(false);
  useEffect(() => { setRotated(null); setConnecting(false); }, [agentId]);
  if (!apps) return null;
  const current = appFor(apps, agentId);
  const choices = apps.filter((app) => app.keyPresent && app.slug !== current?.slug);
  return (
    <>
      <span>{current ? current.botLogin : t('identity.yourAccount')}</span>
      <span className="mt-1 flex flex-wrap items-center gap-1">
        {choices.length > 0 && (
          <select aria-label={t('identity.changeFor', { name })} value="" disabled={busy !== null}
            onChange={(e) => { const slug = e.target.value; if (slug) run('assign', (s) => s.assign(slug, { soul: agentId })); }}
            className="h-6 rounded border border-input bg-transparent px-1 font-sans text-[11px] text-foreground">
            <option value="">{t('identity.change')}</option>
            {choices.map((app) => <option key={app.slug} value={app.slug}>{app.botLogin}</option>)}
          </select>
        )}
        {current && (
          <button type="button" className={smallButton} disabled={busy !== null}
            onClick={() => { setRotated(null); run('rotate', (s) => s.rotateKey(current.slug, t('identity.pickNewKey', { app: current.slug })), setRotated); }}>
            {t('identity.rotate')}
          </button>
        )}
        {apps.length === 0 && !connecting && (
          <button type="button" className={smallButton} onClick={() => setConnecting(true)}>{t('identity.connect')}</button>
        )}
      </span>
      {connecting && apps.length === 0 && <ConnectForm />}
      {busy && <span className="block font-sans text-[11px] text-muted-foreground" role="status">{t('identity.waiting')}</span>}
      {error && <span className="error block font-sans text-[11px]" role="alert">{t('identity.failed', { message: error })}</span>}
      {rotated && <RotatedNotice result={rotated} />}
    </>
  );
}
