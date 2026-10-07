import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { Github } from 'lucide-react';
import { BridgeError, inApp } from '../bridge';
import { useI18n, type Translate } from '../lib/i18n';
import type { MessageKey } from '../locales/en';

// GitHub identities (#67), backed by agent-bot's managed Apps
// (agent-bot-identity #373): which GitHub App each companion acts as, and
// the owner's set up, connect, rotate and assign. agent-bot holds every
// key; GeniusBar sees only the secret-free list and passes a key file's
// path, picked in the native open dialog by the Rust shell. With the
// `github-identity` add-on off the list is empty and mutations answer
// `identity-app-disabled`. agent-bot-identity #554 adds the add-on's switch,
// its state in the list (`addons`) and removing an App from this Mac.

/** Where an App is installed, as agent-bot cached it on connect or rotation. */
export interface IdentityInstallation {
  id: number;
  account: string;
  repositorySelection: 'all' | 'selected';
}

/**
 * The stored key's public fingerprint and when agent-bot stored it
 * (agent-bot-identity #547); `updatedAt` is null for a key an older
 * agent-bot stored.
 */
export interface IdentityKey {
  fingerprint: string;
  updatedAt: string | null;
}

/** One row of `agent-bot identity apps list --json`. */
export interface IdentityApp {
  slug: string;
  botLogin: string;
  issuerPresent: boolean;
  keyPresent: boolean;
  /** Null without a key, and from a bundle older than agent-bot 0.10.33. */
  key: IdentityKey | null;
  installations: IdentityInstallation[];
  harnesses: string[];
  souls: string[];
  liveMint: { status: 'ready' | 'failed' | 'unknown'; code?: string | null; checkedAt?: string | null };
}

/**
 * Which add-ons agent-bot's list reports on (agent-bot-identity #554); an
 * older bundle reports none, and the section then shows the switch read-only.
 */
export interface IdentityAddons {
  'github-identity': boolean;
}

/** The list envelope: the Apps, and the add-on state when agent-bot reports it. */
export interface IdentityAppsList {
  apps: IdentityApp[];
  addons: IdentityAddons | null;
}

/** What `identity app remove` forgot on this Mac: names only, never contents. */
export interface IdentityAppRemoved {
  slug: string;
  id: string | null;
  removed: { storeItem: { store: string; name: string; existed: boolean } | null; configRecord: boolean };
}

/** The add-on switch's answer. */
export interface IdentityAddonState {
  addon: string;
  enabled: boolean;
  changed: boolean;
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
  list: () => Promise<IdentityAppsList>;
  /** Owner-gated by agent-bot; resolves once its loopback page is listening. */
  create: () => Promise<{ handle: number; localUrl: string }>;
  createStatus: (handle: number) => Promise<IdentityCreateStatus>;
  cancelCreate: (handle: number) => Promise<void>;
  /** The creates still waiting for GitHub, including those from before GeniusBar last quit. */
  createPending: () => Promise<{ handle: number; localUrl: string }[]>;
  /**
   * The shell asks for the key file with `prompt`, or, with `passCli`, names
   * that pass-cli item to agent-bot instead; owner-gated by agent-bot.
   */
  connect: (id: string, prompt: string, passCli?: string) => Promise<IdentityAppResult>;
  rotateKey: (slug: string, prompt: string, passCli?: string) => Promise<IdentityAppResult>;
  assign: (slug: string, target: { soul: string } | { harness: string }) => Promise<unknown>;
  /** Forgets the App on this Mac; refused (`identity-app-assigned`) while a harness or soul uses it. Owner-gated. */
  remove: (slug: string) => Promise<IdentityAppRemoved>;
  /** Switches the add-on; works while it is off. Owner-gated. */
  setAddon: (name: keyof IdentityAddons, enabled: boolean) => Promise<IdentityAddonState>;
  /** Opens the create page or a github.com page in the owner's browser. */
  open: (url: string) => Promise<void>;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);
const strings = (value: unknown): string[] => (Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string') : []);

function normalizeKey(raw: unknown): IdentityKey | null {
  if (!isRecord(raw) || typeof raw.fingerprint !== 'string' || raw.fingerprint === '') return null;
  return { fingerprint: raw.fingerprint, updatedAt: typeof raw.updatedAt === 'string' && raw.updatedAt !== '' ? raw.updatedAt : null };
}

export function normalizeIdentityApp(raw: unknown): IdentityApp | null {
  if (!isRecord(raw) || typeof raw.slug !== 'string' || raw.slug === '') return null;
  const mint = isRecord(raw.liveMint) ? raw.liveMint : {};
  const status = mint.status === 'ready' || mint.status === 'failed' ? mint.status : 'unknown';
  return {
    slug: raw.slug,
    botLogin: typeof raw.botLogin === 'string' ? raw.botLogin : `${raw.slug}[bot]`,
    issuerPresent: raw.issuerPresent === true,
    keyPresent: raw.keyPresent === true,
    key: normalizeKey(raw.key),
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

/** The envelope; `addons` is null when agent-bot does not report the add-on (an older bundle). */
export function normalizeIdentityAppsList(raw: unknown): IdentityAppsList | null {
  const apps = normalizeIdentityApps(raw);
  if (apps === null || !isRecord(raw)) return null;
  const on = isRecord(raw.addons) ? raw.addons['github-identity'] : undefined;
  return { apps, addons: typeof on === 'boolean' ? { 'github-identity': on } : null };
}

function normalizeRemoved(raw: unknown): IdentityAppRemoved | null {
  if (!isRecord(raw) || typeof raw.slug !== 'string') return null;
  const removed = isRecord(raw.removed) ? raw.removed : {};
  const item = removed.storeItem;
  return {
    slug: raw.slug,
    id: typeof raw.id === 'string' ? raw.id : null,
    removed: {
      storeItem: isRecord(item) && typeof item.store === 'string' && typeof item.name === 'string'
        ? { store: item.store, name: item.name, existed: item.existed === true } : null,
      configRecord: removed.configRecord === true,
    },
  };
}

function normalizeAddon(raw: unknown): IdentityAddonState | null {
  if (!isRecord(raw) || typeof raw.addon !== 'string' || typeof raw.enabled !== 'boolean') return null;
  return { addon: raw.addon, enabled: raw.enabled, changed: raw.changed === true };
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

function normalizeCreateHandle(raw: unknown): { handle: number; localUrl: string } | null {
  return isRecord(raw) && typeof raw.handle === 'number' && typeof raw.localUrl === 'string'
    ? { handle: raw.handle, localUrl: raw.localUrl } : null;
}

const normalizeCreatePending = (raw: unknown) =>
  (Array.isArray(raw) ? raw.map(normalizeCreateHandle).filter((job): job is { handle: number; localUrl: string } => job !== null) : null);

/** Only a named item goes to the shell, so a connect by file is invoked as before. */
const withPassCli = (args: Record<string, unknown>, passCli?: string) => (passCli ? { ...args, passCli } : args);

export const liveIdentityApps: IdentityAppsSource = {
  list: () => call('identity_apps_list', {}, normalizeIdentityAppsList, 'agent-bot gave no App list'),
  create: () => call('identity_app_create', {}, normalizeCreateHandle, 'agent-bot gave no App creation page'),
  createStatus: (handle) => call('identity_app_create_status', { handle }, normalizeCreateStatus, 'agent-bot gave no App creation status'),
  cancelCreate: (handle) => call('identity_app_create_cancel', { handle }, () => undefined, ''),
  createPending: () => call('identity_app_create_pending', {}, normalizeCreatePending, 'agent-bot gave no App creations'),
  connect: (id, prompt, passCli) => call('identity_app_connect', withPassCli({ id, prompt }, passCli), normalizeResult, 'agent-bot gave no App'),
  rotateKey: (slug, prompt, passCli) => call('identity_app_rotate_key', withPassCli({ slug, prompt }, passCli), normalizeResult, 'agent-bot gave no App'),
  assign: (slug, target) => call('identity_app_assign', { slug, ...target }, anything, 'agent-bot gave no assignment'),
  remove: (slug) => call('identity_app_remove', { slug }, normalizeRemoved, 'agent-bot gave no removal'),
  setAddon: (name, enabled) => call('identity_addon_set', { name, enabled }, normalizeAddon, 'agent-bot gave no add-on state'),
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
  /** Null until the first read answers, and from an older bundle, which cannot switch the add-on. */
  addons: IdentityAddons | null;
  reload: () => void;
}

const HIDDEN: IdentityAppsApi = { source: null, hidden: true, apps: null, addons: null, reload: () => {} };
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
  const [list, setList] = useState<IdentityAppsList | null>(null);
  const [failed, setFailed] = useState(false);
  const ticket = useRef(0);
  const reload = useCallback(() => {
    if (!source) return;
    const mine = ++ticket.current;
    source.list().then(
      (next) => { if (ticket.current === mine) { setList(next); setFailed(false); } },
      () => { if (ticket.current === mine) { setList(null); setFailed(true); } },
    );
  }, [source]);
  const api = useMemo<IdentityAppsApi>(() => (source
    ? { source, hidden: failed, apps: failed ? null : list?.apps ?? null, addons: failed ? null : list?.addons ?? null, reload }
    : HIDDEN), [source, failed, list, reload]);
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
    // The action is called now (a caller's test sees the call at once), but
    // through a promise even when it throws or returns nothing: a refusal
    // belongs in `error`, not on the console.
    let outcome: Promise<T>;
    try { outcome = Promise.resolve(action(source)); } catch (e) { outcome = Promise.reject(e); }
    outcome
      .then((result) => done?.(result), (e: unknown) => setError(identityFailure(e, t)))
      .finally(() => { setBusy(null); reload(); });
  }, [source, reload, t]);
  return { busy, error, run, setError };
}

type IdentityRun = ReturnType<typeof useIdentityAction>['run'];

const smallButton = 'min-h-6 rounded border border-border px-2 font-sans text-[11px] hover:bg-accent disabled:opacity-50';
const smallPrimaryButton = 'min-h-6 rounded bg-primary px-2 font-sans text-[11px] text-primary-foreground hover:bg-primary/90 disabled:opacity-50';

const smallInput = 'h-6 rounded border border-input bg-transparent px-1.5 font-mono text-[11px] text-foreground';

/**
 * An App ID field and the key-file button that connects it; or, below, the
 * name of the key's pass-cli item, which agent-bot restores itself (the
 * shell checks the name, agent-bot the item).
 */
export function ConnectForm({ onConnected, label }: { onConnected?: (result: IdentityAppResult) => void; label?: string }) {
  const { t } = useI18n();
  const [id, setId] = useState('');
  const [item, setItem] = useState('');
  const { busy, error, run } = useIdentityAction();
  const valid = /^\d{1,20}$/.test(id.trim());
  const connect = (passCli?: string) =>
    run('connect', (s) => (passCli ? s.connect(id.trim(), '', passCli) : s.connect(id.trim(), t('identity.pickKey'))), (result) => onConnected?.(result));
  return (
    <div className="grid gap-1 font-sans">
      <div className="flex items-center gap-1">
        <input value={id} onChange={(e) => setId(e.target.value)} inputMode="numeric" placeholder={t('identity.appId')}
          aria-label={label ?? t('identity.appId')} className={`${smallInput} w-28`} />
        <button type="button" className={smallButton} disabled={!valid || busy !== null} onClick={() => connect()}>
          {t('identity.chooseKey')}
        </button>
      </div>
      <span className="text-[11px] text-muted-foreground">{t('identity.connectHint')}</span>
      <div className="flex items-center gap-1">
        <input value={item} onChange={(e) => setItem(e.target.value)} placeholder={t('identity.passItem')}
          aria-label={t('identity.passItem')} autoCapitalize="off" autoCorrect="off" spellCheck={false} className={`${smallInput} w-36`} />
        <button type="button" className={smallButton} disabled={!valid || item.trim() === '' || busy !== null}
          onClick={() => connect(item.trim())}>
          {t('identity.connectPass')}
        </button>
      </div>
      <span className="text-[11px] text-muted-foreground">{t('identity.passHint')}</span>
      {busy && <span className="text-[11px] text-muted-foreground" role="status">{t('identity.waiting')}</span>}
      {error && <span className="text-[11px] text-destructive" role="alert">{t('identity.failed', { message: error })}</span>}
    </div>
  );
}

/**
 * "Rotate from pass-cli…": asks for the key's item name in an inline field
 * (not `window.prompt`, which the web view blocks) and rotates `slug`'s key
 * from it; the file picker path stays beside it.
 */
export function RotateFromPass({ slug, disabled, run, onRotated }:
  { slug: string; disabled: boolean; run: IdentityRun; onRotated: (result: IdentityAppResult) => void }) {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  const [item, setItem] = useState('');
  if (!open) {
    return (
      <button type="button" className={smallButton} disabled={disabled} onClick={() => setOpen(true)}>{t('identity.rotatePass')}</button>
    );
  }
  const rotate = () => {
    setOpen(false);
    rotateKey(run, slug, t, onRotated, item.trim());
  };
  return (
    <span className="flex flex-wrap items-center gap-1">
      <input value={item} onChange={(e) => setItem(e.target.value)} placeholder={t('identity.passItem')} aria-label={t('identity.passItem')}
        autoFocus autoCapitalize="off" autoCorrect="off" spellCheck={false} className={`${smallInput} w-36`}
        onKeyDown={(e) => { if (e.key === 'Enter' && item.trim() !== '') { e.preventDefault(); rotate(); } }} />
      <button type="button" className={smallPrimaryButton} disabled={item.trim() === '' || disabled} onClick={rotate}>
        {t('identity.rotatePassGo')}
      </button>
      <button type="button" className={smallButton} onClick={() => setOpen(false)}>{t('cancel')}</button>
    </span>
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

/** The Apps with a key a companion could act as instead of `current`. */
export function assignChoices(apps: readonly IdentityApp[], current: IdentityApp | null): IdentityApp[] {
  return apps.filter((app) => app.keyPresent && app.slug !== current?.slug);
}

/** "Change…": assigns one of `choices` to the companion through agent-bot. */
export function AssignSelect({ agentId, name, choices, disabled, run }:
  { agentId: string; name: string; choices: readonly IdentityApp[]; disabled: boolean; run: IdentityRun }) {
  const { t } = useI18n();
  return (
    <select aria-label={t('identity.changeFor', { name })} value="" disabled={disabled}
      onChange={(e) => { const slug = e.target.value; if (slug) run('assign', (s) => s.assign(slug, { soul: agentId })); }}
      className="h-6 rounded border border-input bg-transparent px-1 font-sans text-[11px] text-foreground">
      <option value="">{t('identity.change')}</option>
      {choices.map((app) => <option key={app.slug} value={app.slug}>{app.botLogin}</option>)}
    </select>
  );
}

/** The waiting and refusal lines under an identity control. */
export function ActionLines({ busy, error }: { busy: string | null; error: string | null }) {
  const { t } = useI18n();
  return (
    <>
      {busy && <span className="block font-sans text-[11px] text-muted-foreground" role="status">{t('identity.waiting')}</span>}
      {error && <span className="block font-sans text-[11px] text-destructive" role="alert">{t('identity.failed', { message: error })}</span>}
    </>
  );
}

/**
 * Replaces `slug`'s key: the shell asks for the new key file, or names the
 * pass-cli `item` to agent-bot instead; agent-bot keeps the key.
 */
export function rotateKey(run: IdentityRun, slug: string, t: Translate, done: (result: IdentityAppResult) => void, item?: string) {
  run('rotate', (s) => (item ? s.rotateKey(slug, '', item) : s.rotateKey(slug, t('identity.pickNewKey', { app: slug }))), done);
}

/**
 * The Details tab's Acts as row value (#67, #122): the App this companion
 * acts as on GitHub, or "your account"; "Change…" lists the Apps with a key
 * to assign it to. Rotate and Connect live on the ⓘ sheet's GitHub App row.
 */
export function ActsAs({ agentId, name }: { agentId: string; name: string }) {
  const { t } = useI18n();
  const { apps } = useIdentityApps();
  const { busy, error, run } = useIdentityAction();
  if (!apps) return null;
  const current = appFor(apps, agentId);
  const choices = assignChoices(apps, current);
  return (
    <>
      <span>{current ? current.botLogin : t('identity.yourAccount')}</span>
      {choices.length > 0 && (
        <span className="mt-1 flex flex-wrap items-center gap-1">
          <AssignSelect agentId={agentId} name={name} choices={choices} disabled={busy !== null} run={run} />
        </span>
      )}
      <ActionLines busy={busy} error={error} />
    </>
  );
}

/** "Key issued {when}" in the owner's language, or null when the time is unknown or unreadable. */
function issuedText(updatedAt: string | null, t: Translate, lang: string): string | null {
  if (!updatedAt) return null;
  const when = new Date(updatedAt);
  return Number.isNaN(when.getTime()) ? null : t('keyd.issued', { when: when.toLocaleDateString(lang) });
}

/**
 * The ⓘ sheet's GitHub App row (Lovable `DetailsButton`): the App's key
 * fingerprint and when it was issued (agent-bot 0.10.33+), else the census's
 * App name; "Rotate key" for a managed App, "Connect GitHub App" otherwise,
 * which opens "Change…" (Apps with a key) or the App ID form under the row.
 * The buttons need agent-bot's managed Apps; without them the row is text.
 */
export function GitHubAppRow({ agentId, name, appSlug }: { agentId: string; name: string; appSlug: string | null }) {
  const { t, lang } = useI18n();
  const { apps, reload } = useIdentityApps();
  const { busy, error, run } = useIdentityAction();
  const [rotated, setRotated] = useState<IdentityAppResult | null>(null);
  const [connecting, setConnecting] = useState(false);
  // Read the list as the sheet opens, as the Details tab does per soul.
  useEffect(() => { reload(); setRotated(null); setConnecting(false); }, [reload, agentId]);
  const app = appFor(apps, agentId) ?? apps?.find((a) => a.slug === appSlug) ?? null;
  const connected = app !== null || appSlug !== null;
  let subtitle = t('keyd.none');
  if (app?.key) {
    const issued = issuedText(app.key.updatedAt, t, lang);
    subtitle = `${t('keyd.connectedKey', { fp: app.key.fingerprint })}${issued ? ` · ${issued}` : ''}`;
  } else if (connected) {
    subtitle = t('keyd.connected', { app: app?.slug ?? appSlug ?? '' });
  }
  const choices = apps ? assignChoices(apps, app) : [];
  return (
    <div className="p-3">
      <div className="flex items-center gap-3">
        <Github className="size-4 text-muted-foreground" aria-hidden />
        <div className="min-w-0 flex-1">
          <h3 className="m-0 text-sm">{t('keyd.title')}</h3>
          <p className="m-0 truncate font-mono text-[11px] text-muted-foreground" title={subtitle}>{subtitle}</p>
        </div>
        {app && (
          <>
            <button type="button" className={smallButton} disabled={busy !== null}
              onClick={() => { setRotated(null); rotateKey(run, app.slug, t, setRotated); }}>
              {t('keyd.rotate')}
            </button>
            <RotateFromPass slug={app.slug} disabled={busy !== null} run={run} onRotated={setRotated} />
          </>
        )}
        {apps && !connected && (
          <button type="button" className={smallPrimaryButton} aria-expanded={connecting}
            onClick={() => setConnecting((open) => !open)}>
            {t('keyd.connect')}
          </button>
        )}
      </div>
      {(connecting && apps && !connected) || busy || error || rotated ? (
        <div className="mt-2 grid gap-1 pl-7">
          {connecting && apps && !connected && (choices.length > 0
            ? <span><AssignSelect agentId={agentId} name={name} choices={choices} disabled={busy !== null} run={run} /></span>
            : <ConnectForm />)}
          <ActionLines busy={busy} error={error} />
          {rotated && <RotatedNotice result={rotated} />}
        </div>
      ) : null}
    </div>
  );
}
