import { useEffect, useRef, useState } from 'react';
import { Github } from 'lucide-react';
import { useI18n } from '../lib/i18n';
import { displayName, type CensusRow } from '../model/census';
import {
  ConnectForm, identityFailure, identityStatus, RotatedNotice, STATUS_TEXT, useIdentityAction, useIdentityApps,
  type IdentityApp, type IdentityAppResult,
} from './IdentityApps';

const link = 'min-h-6 rounded border border-border px-2 text-[11px] hover:bg-accent disabled:opacity-50';

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
      {creating?.phase === 'failed' && <p className="error m-0 text-[11px]" role="alert">{t('identity.failed', { message: creating.message })}</p>}
    </div>
  );
}

/** One App: its bot login, status, where it is installed, and who uses it. */
function AppRow({ app, names }: { app: IdentityApp; names: (agentId: string) => string }) {
  const { t } = useI18n();
  const { source } = useIdentityApps();
  const { busy, error, run } = useIdentityAction();
  const [rotated, setRotated] = useState<IdentityAppResult | null>(null);
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
        <span className="text-[11px] text-muted-foreground">{t('identity.companions', { list: app.souls.map(names).join(', ') })}</span>
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
      </span>
      {busy && <span className="text-[11px] text-muted-foreground" role="status">{t('identity.waiting')}</span>}
      {error && <span className="error text-[11px]" role="alert">{t('identity.failed', { message: error })}</span>}
      {rotated && <RotatedNotice result={rotated} />}
    </li>
  );
}

/**
 * The menu's GitHub identity section (#67). There is no Lovable screen for
 * it yet: it follows the Sandboxing card's style and sits below it. The
 * add-on is shown read-only, because agent-bot has no command to switch
 * it; an empty list means it is off or holds no Apps.
 */
export function IdentityAppsCard({ roster = [], pollMs = 2000 }: { roster?: readonly CensusRow[]; pollMs?: number }) {
  const { t } = useI18n();
  const { hidden, apps, reload } = useIdentityApps();
  const [connecting, setConnecting] = useState(false);
  useEffect(() => { reload(); }, [reload]);
  if (hidden || !apps) return null;
  const names = (agentId: string) => {
    const soul = roster.find((s) => s.agentId === agentId);
    return soul ? displayName(soul) : agentId;
  };
  const on = apps.length > 0;
  return (
    <section className="grid gap-2 border-t border-border p-3 text-xs" aria-label={t('identity.title')}>
      <div className="flex items-center gap-2">
        <Github className={`size-3.5 ${on ? 'text-success' : 'text-muted-foreground'}`} aria-hidden />
        <h3 className="m-0 flex-1 text-sm font-medium">{t('identity.title')}</h3>
        <input type="checkbox" role="switch" aria-label={t('identity.addOn')} checked={on} disabled readOnly />
      </div>
      <p className="m-0 text-muted-foreground">{t('identity.desc')}</p>
      {!on && <p className="m-0 text-[11px] text-muted-foreground">{t('identity.addOnHint')}</p>}
      {on && (
        <ul className="m-0 grid list-none gap-1.5 p-0" aria-label={t('identity.apps')}>
          {apps.map((app) => <AppRow key={app.slug} app={app} names={names} />)}
        </ul>
      )}
      <CreateApp pollMs={pollMs} />
      {connecting ? <ConnectForm onConnected={() => setConnecting(false)} /> : (
        <div className="flex items-center gap-2">
          <button type="button" className={link} onClick={() => setConnecting(true)}>{t('identity.connectExisting')}</button>
        </div>
      )}
    </section>
  );
}
