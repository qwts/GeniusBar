import { useEffect, useId, useRef, useState } from 'react';
import { ChevronDown, Github, Trash2 } from 'lucide-react';
import { useI18n, type Translate } from '../lib/i18n';
import { displayName, type CensusRow } from '../model/census';
import { harnessOptions } from '../model/launch';
import {
  ActionLines, ConnectForm, identityFailure, identityStatus, RotatedNotice, STATUS_TEXT, useIdentityAction, useIdentityApps,
  type IdentityApp, type IdentityAppResult,
} from './IdentityApps';

const link = 'min-h-6 rounded border border-border px-2 text-[11px] hover:bg-accent disabled:opacity-50';

/**
 * Who uses an App: rostered companions by name, and the rest (archived
 * souls, other machines' pins) only as a count. agent-bot's list names
 * every soul ever assigned, which was a wall of IDs in the popup (#189).
 */
export function companionsText(souls: readonly string[], roster: readonly CensusRow[], t: Translate): string {
  const named = souls.flatMap((agentId) => {
    const soul = roster.find((s) => s.agentId === agentId);
    return soul ? [displayName(soul)] : [];
  });
  const more = souls.length - named.length;
  if (named.length === 0) return t('identity.companionsOff', { count: more });
  const list = named.join(', ');
  return more === 0 ? t('identity.companions', { list }) : t('identity.companionsMore', { list, count: more });
}

type Creating =
  | { phase: 'asking' }
  | { phase: 'waiting'; handle: number; localUrl: string }
  | { phase: 'created'; result: IdentityAppResult }
  | { phase: 'failed'; message: string };

/**
 * The manifest flow: agent-bot asks the owner, then listens on a loopback
 * page that GeniusBar opens in the browser; GitHub's answer comes back to
 * agent-bot, which stores the key. GeniusBar polls for the result and
 * offers the install page as the next step.
 */
function CreateApp({ pollMs }: { pollMs: number }) {
  const { t } = useI18n();
  const { source, reload } = useIdentityApps();
  const [creating, setCreating] = useState<Creating | null>(null);
  const handle = creating?.phase === 'waiting' ? creating.handle : null;
  const latest = useRef(0);
  useEffect(() => {
    if (!source || handle === null) return;
    let active = true;
    const timer = setInterval(() => {
      source.createStatus(handle).then((status) => {
        if (!active || status.status === 'pending') return;
        if (status.status === 'complete') { setCreating({ phase: 'created', result: status.result }); reload(); }
        else setCreating({ phase: 'failed', message: identityFailure(status.error, t) ?? status.error.message });
      }, (e: unknown) => { if (active) setCreating({ phase: 'failed', message: identityFailure(e, t) ?? String(e) }); });
    }, pollMs);
    return () => { active = false; clearInterval(timer); };
  }, [source, handle, pollMs, reload, t]);
  if (!source) return null;
  const start = () => {
    const mine = ++latest.current;
    setCreating({ phase: 'asking' });
    source.create().then(
      ({ handle: next, localUrl }) => {
        if (latest.current !== mine) return;
        setCreating({ phase: 'waiting', handle: next, localUrl });
        void source.open(localUrl).catch(() => {});
      },
      (e: unknown) => {
        if (latest.current !== mine) return;
        const message = identityFailure(e, t);
        setCreating(message ? { phase: 'failed', message } : null);
      },
    );
  };
  const cancel = () => {
    latest.current += 1;
    if (creating?.phase === 'waiting') void source.cancelCreate(creating.handle).catch(() => {});
    setCreating(null);
  };
  return (
    <div className="grid gap-1">
      <div className="flex items-center gap-2">
        <button type="button" className={link} disabled={creating?.phase === 'asking' || creating?.phase === 'waiting'} onClick={start}>
          {t('identity.create')}
        </button>
        <span className="text-[11px] text-muted-foreground">{t('identity.createHint')}</span>
      </div>
      {creating?.phase === 'asking' && <p className="m-0 text-[11px] text-muted-foreground" role="status">{t('identity.waiting')}</p>}
      {creating?.phase === 'waiting' && (
        <p className="m-0 flex flex-wrap items-center gap-1 text-[11px] text-muted-foreground" role="status">
          {t('identity.waitingGithub')}
          <button type="button" className={link} onClick={() => void source.open(creating.localUrl).catch(() => {})}>{t('identity.openAgain')}</button>
          <button type="button" className={link} onClick={cancel}>{t('cancel')}</button>
        </p>
      )}
      {creating?.phase === 'created' && (
        <p className="m-0 flex flex-wrap items-center gap-1 text-[11px]" role="status">
          {t('identity.created', { app: creating.result.slug })}
          <button type="button" className={link} onClick={() => void source.open(creating.result.installUrl).catch(() => {})}>
            {t('identity.install')}
          </button>
        </p>
      )}
      {creating?.phase === 'failed' && <p className="m-0 text-[11px] text-destructive" role="alert">{t('identity.failed', { message: creating.message })}</p>}
    </div>
  );
}

/**
 * Asks before forgetting an App on this Mac (agent-bot-identity #554), as
 * the Archive dialog asks before archiving a soul: not `window.confirm`,
 * which the Tauri web view blocks. agent-bot asks the owner and refuses
 * while a harness or soul still uses the App; its message names them and
 * shows here as-is, and the App stays.
 */
function RemoveDialog({ app, onClose }: { app: IdentityApp; onClose: (removed: boolean) => void }) {
  const { t } = useI18n();
  const { source, reload } = useIdentityApps();
  const titleId = useId();
  const [removing, setRemoving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const cancel = useRef<HTMLButtonElement>(null);
  useEffect(() => cancel.current?.focus(), []);
  const close = () => { if (!removing) onClose(false); };
  const remove = () => {
    if (!source) return;
    setRemoving(true);
    setError(null);
    source.remove(app.slug).then(
      () => { reload(); onClose(true); },
      (e: unknown) => { setError(identityFailure(e, t)); setRemoving(false); reload(); },
    );
  };
  return (
    <div className="fixed inset-0 z-50 grid place-items-center bg-black/80 p-4"
      onClick={(e) => { if (e.target === e.currentTarget) close(); }}>
      <section role="alertdialog" aria-modal="true" aria-labelledby={titleId}
        onKeyDown={(e) => { if (e.key === 'Escape') { e.stopPropagation(); close(); } }}
        className="grid max-h-full w-full max-w-sm gap-3 overflow-y-auto rounded-lg border border-border bg-background p-5 text-sm shadow-lg">
        <h2 id={titleId} className="m-0 flex items-center gap-2 text-base font-semibold tracking-tight">
          <Trash2 className="size-4 text-destructive" aria-hidden /> {t('identity.removeConfirm', { app: app.botLogin })}
        </h2>
        <ul className="m-0 grid gap-0.5 pl-5 text-muted-foreground">
          <li>{t('identity.removeWhatLocal')}</li>
          <li>{t('identity.removeWhatGithub')}</li>
        </ul>
        {removing && <p className="m-0 text-[11px] text-muted-foreground" role="status">{t('identity.waiting')}</p>}
        {error && <p className="m-0 text-[11px] text-destructive" role="alert">{t('identity.failed', { message: error })}</p>}
        <div className="flex justify-end gap-2">
          <button ref={cancel} type="button" onClick={close} disabled={removing}
            className="h-9 rounded-md px-4 text-sm font-medium hover:bg-accent disabled:opacity-50">{t('cancel')}</button>
          <button type="button" onClick={remove} disabled={removing}
            className="h-9 rounded-md bg-destructive px-4 text-sm font-medium text-destructive-foreground hover:bg-destructive/90 disabled:opacity-50">
            {t('identity.removeButton')}
          </button>
        </div>
      </section>
    </div>
  );
}

/**
 * "Use for a harness…": assigns the App to a harness through agent-bot,
 * which replaces that harness's App; mirrors the souls' Change… select.
 */
function HarnessSelect({ app, harnesses, disabled, onPick }:
  { app: IdentityApp; harnesses: readonly { id: string; label: string }[]; disabled: boolean; onPick: (harness: string) => void }) {
  const { t } = useI18n();
  const choices = harnesses.filter((h) => !app.harnesses.includes(h.id));
  if (choices.length === 0) return null;
  return (
    <select aria-label={t('identity.useForLabel', { app: app.botLogin })} value="" disabled={disabled}
      onChange={(e) => { if (e.target.value) onPick(e.target.value); }}
      className="h-6 rounded border border-input bg-transparent px-1 font-sans text-[11px] text-foreground">
      <option value="">{t('identity.useFor')}</option>
      {choices.map((h) => <option key={h.id} value={h.id}>{h.label}</option>)}
    </select>
  );
}

/**
 * One App: its bot login, status, where it is installed, and who uses it;
 * Rotate, Use for a harness, and Remove (agent-bot-identity #554, so only
 * when agent-bot reports the add-on: `canRemove`).
 */
function AppRow({ app, roster, harnesses, canRemove, onRemoved }: {
  app: IdentityApp;
  roster: readonly CensusRow[];
  harnesses: readonly { id: string; label: string }[];
  canRemove: boolean;
  onRemoved: (app: IdentityApp) => void;
}) {
  const { t } = useI18n();
  const { source } = useIdentityApps();
  const { busy, error, run } = useIdentityAction();
  const [rotated, setRotated] = useState<IdentityAppResult | null>(null);
  const [removing, setRemoving] = useState(false);
  const status = identityStatus(app);
  const tone = status === 'ready' ? 'text-success' : status === 'unknown' ? 'text-muted-foreground' : 'text-destructive';
  const installed = app.installations.map((i) => t(i.repositorySelection === 'all' ? 'identity.installedAll' : 'identity.installedSome', { account: i.account }));
  const installUrl = `https://github.com/apps/${app.slug}/installations/new`;
  return (
    <li className="grid gap-0.5 rounded border border-border p-2">
      <span className="flex items-center gap-2">
        <span className="selectable min-w-0 flex-1 truncate font-mono text-[11px]">{app.botLogin}</span>
        <span className={`text-[11px] ${tone}`}>{t(STATUS_TEXT[status])}</span>
      </span>
      <span className="text-[11px] text-muted-foreground">
        {installed.length > 0 ? installed.join(', ') : t('identity.notInstalled')}
      </span>
      {app.harnesses.length > 0 && (
        <span className="text-[11px] text-muted-foreground">{t('identity.harnesses', { list: app.harnesses.join(', ') })}</span>
      )}
      {app.souls.length > 0 && (
        <span className="text-[11px] text-muted-foreground">{companionsText(app.souls, roster, t)}</span>
      )}
      <span className="mt-1 flex flex-wrap gap-1">
        {app.keyPresent && (
          <button type="button" className={link} disabled={busy !== null}
            onClick={() => { setRotated(null); run('rotate', (s) => s.rotateKey(app.slug, t('identity.pickNewKey', { app: app.slug })), setRotated); }}>
            {t('identity.rotate')}
          </button>
        )}
        {source && (
          <button type="button" className={link} onClick={() => void source.open(installUrl).catch(() => {})}>
            {t('identity.repositories')}
          </button>
        )}
        {app.keyPresent && (
          <HarnessSelect app={app} harnesses={harnesses} disabled={busy !== null}
            onPick={(harness) => run('assign', (s) => s.assign(app.slug, { harness }))} />
        )}
        {canRemove && (
          <button type="button" className={link} disabled={busy !== null} onClick={() => setRemoving(true)}>
            {t('identity.remove')}
          </button>
        )}
      </span>
      {busy && <span className="text-[11px] text-muted-foreground" role="status">{t('identity.waiting')}</span>}
      {error && <span className="text-[11px] text-destructive" role="alert">{t('identity.failed', { message: error })}</span>}
      {rotated && <RotatedNotice result={rotated} />}
      {removing && <RemoveDialog app={app} onClose={(removed) => { setRemoving(false); if (removed) onRemoved(app); }} />}
    </li>
  );
}

/**
 * The menu's GitHub identity section (#67). There is no Lovable screen for
 * it yet: it follows the Sandboxing card's style and sits below it. When
 * agent-bot's list reports the add-on (agent-bot-identity #554) the switch
 * turns it on and off through agent-bot, which asks the owner; an older
 * bundle reports nothing and cannot switch it, so the switch is read-only
 * there and shows on while the list holds Apps. The section starts
 * folded to one summary line, and its App list scrolls inside a bounded
 * box, so a roster of twenty Apps never pushes the fleet out of the popup
 * (#189).
 */
export function IdentityAppsCard({ roster = [], pollMs = 2000 }: { roster?: readonly CensusRow[]; pollMs?: number }) {
  const { t } = useI18n();
  const { hidden, apps, addons, reload } = useIdentityApps();
  const { busy, error, run } = useIdentityAction();
  const [connecting, setConnecting] = useState(false);
  const [open, setOpen] = useState(false);
  const [removed, setRemoved] = useState<string | null>(null);
  useEffect(() => { reload(); }, [reload]);
  if (hidden || !apps) return null;
  const live = addons !== null;
  const on = addons ? addons['github-identity'] : apps.length > 0;
  const ready = apps.filter((app) => identityStatus(app) === 'ready').length;
  // The harnesses the desk knows: agent-bot's, the companions', and any an App already serves.
  const harnesses = harnessOptions([...roster.flatMap((s) => (s.harness ? [s.harness] : [])), ...apps.flatMap((app) => app.harnesses)]);
  const toggle = () => { setRemoved(null); run('addon', (s) => s.setAddon('github-identity', !on)); };
  return (
    <section className="grid gap-2 border-t border-border p-3 text-xs" aria-label={t('identity.title')}>
      <div className="flex items-center gap-2">
        <Github className={`size-3.5 ${on ? 'text-success' : 'text-muted-foreground'}`} aria-hidden />
        <h3 className="m-0 flex-1 text-sm font-medium">{t('identity.title')}</h3>
        {live
          ? <input type="checkbox" role="switch" aria-label={t('identity.addOn')} checked={on} disabled={busy !== null} onChange={toggle} />
          : <input type="checkbox" role="switch" aria-label={t('identity.addOn')} checked={on} disabled readOnly />}
        <button type="button" aria-label={t(open ? 'identity.hide' : 'identity.show')} aria-expanded={open}
          onClick={() => setOpen(!open)} className="rounded p-1 text-muted-foreground hover:text-foreground">
          <ChevronDown className={`size-4 transition-transform ${open ? '' : '-rotate-90'}`} aria-hidden />
        </button>
      </div>
      <p className="m-0 text-muted-foreground">{on && !open ? t('identity.summary', { count: apps.length, ready }) : t('identity.desc')}</p>
      <ActionLines busy={busy} error={error} />
      {removed && <p className="m-0 text-[11px] text-muted-foreground" role="status">{t('identity.removed', { app: removed })}</p>}
      {open && (
        <>
          {!on && <p className="m-0 text-[11px] text-muted-foreground">{t(live ? 'identity.addOnOffHint' : 'identity.addOnHint')}</p>}
          {on && apps.length > 0 && (
            <ul className="m-0 grid max-h-64 list-none gap-1.5 overflow-y-auto p-0" aria-label={t('identity.apps')}>
              {apps.map((app) => (
                <AppRow key={app.slug} app={app} roster={roster} harnesses={harnesses} canRemove={live}
                  onRemoved={(gone) => setRemoved(gone.botLogin)} />
              ))}
            </ul>
          )}
          <CreateApp pollMs={pollMs} />
          {connecting ? <ConnectForm onConnected={() => setConnecting(false)} /> : (
            <div className="flex items-center gap-2">
              <button type="button" className={link} onClick={() => setConnecting(true)}>{t('identity.connectExisting')}</button>
            </div>
          )}
        </>
      )}
    </section>
  );
}
