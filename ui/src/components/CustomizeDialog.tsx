import { useContext, useEffect, useId, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { ArrowLeft, X } from 'lucide-react';
import type { SoulProfileFileEntry } from '../bridge';
import { displayHarness, displayName, type CensusRow } from '../model/census';
import { useI18n, type Translate } from '../lib/i18n';
import { ProfileSourceContext, useSoulProfile } from '../useSoulProfile';
import { SoulDudle } from './FleetList';

type Tab = 'profile' | 'context';
const TABS: readonly Tab[] = ['profile', 'context'];

const field = 'w-full rounded-md border border-input bg-transparent px-3 py-2 text-sm text-foreground disabled:cursor-default disabled:opacity-100';
const label = 'block text-sm font-medium';
const sectionTitle = 'm-0 mb-1 text-xs font-medium text-muted-foreground';
const shortCommit = (commit: string) => commit.slice(0, 10);

/**
 * The design's Customize… dialog (Lovable `EditDialog`, #64), read-only:
 * Profile (name, role, description) and Context (the SOP, skills,
 * credentials and the files the harness loads), from agent-bot `soul
 * profile`, read each time it opens. Inputs show their values and cannot
 * be changed; there is no Save until agent-bot can take owner-approved
 * revisions (agent-bot #293). A file row opens its text in a read-only
 * viewer. Escape, ×, Close or a backdrop click closes it.
 */
export function CustomizeDialog({ soul, onClose }: { soul: CensusRow; onClose: () => void }) {
  const { t } = useI18n();
  const ids = useId();
  const titleId = `${ids}-title`;
  const { profile, loading, error } = useSoulProfile(soul.agentId, true);
  const [tab, setTab] = useState<Tab>('profile');
  const [viewing, setViewing] = useState<string | null>(null);
  const firstTab = useRef<HTMLButtonElement>(null);
  const pressedBackdrop = useRef(false);
  const close = useRef(onClose);
  close.current = onClose;
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') close.current(); };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, []);
  useEffect(() => { firstTab.current?.focus(); }, []);
  const name = profile?.profile.displayName ?? displayName(soul);
  const harness = profile?.profile.harness ?? displayHarness(soul);

  // Portalled to the body, as the ⓘ sheet: the companion window's transform
  // would contain the fixed overlay, and its title bar would take the drag.
  return createPortal(
    <div className="fixed inset-0 z-50 grid place-items-center bg-black/50 p-4"
      onPointerDown={(e) => { e.stopPropagation(); pressedBackdrop.current = e.target === e.currentTarget; }}
      onClick={(e) => { if (e.target === e.currentTarget && pressedBackdrop.current) onClose(); }}>
      <section role="dialog" aria-modal="true" aria-labelledby={titleId}
        onKeyDown={(e) => { if (e.key === 'Escape') { e.stopPropagation(); onClose(); } }}
        className="relative grid max-h-full w-full max-w-2xl gap-4 overflow-y-auto rounded-lg border border-border bg-popover p-6 shadow-2xl">
        <button type="button" onClick={onClose} aria-label={t('close')}
          className="absolute top-4 right-4 rounded p-1 text-muted-foreground hover:text-foreground">
          <X className="size-4" aria-hidden />
        </button>
        <div className="flex items-center gap-3 pr-8">
          <SoulDudle soul={soul} size={36} paused={false} />
          <h2 id={titleId} className="m-0 truncate text-lg font-semibold tracking-tight">{name}</h2>
          <span className="rounded border border-border px-1.5 py-0.5 font-mono text-[11px] text-muted-foreground">{harness}</span>
        </div>
        {/* The session's segmented tabs, as the design's. */}
        <div role="tablist" aria-label={t('edit.title')} className="flex w-fit gap-0.5 rounded-lg bg-muted p-1"
          onKeyDown={(e) => {
            const step = e.key === 'ArrowRight' ? 1 : e.key === 'ArrowLeft' ? -1 : 0;
            if (!step) return;
            const next = TABS[(TABS.indexOf(tab) + step + TABS.length) % TABS.length];
            setTab(next);
            document.getElementById(`${ids}-tab-${next}`)?.focus();
          }}>
          {TABS.map((id) => (
            <button key={id} ref={id === 'profile' ? firstTab : undefined} id={`${ids}-tab-${id}`} type="button" role="tab"
              aria-selected={tab === id} aria-controls={`${ids}-panel`} tabIndex={tab === id ? 0 : -1}
              onClick={() => setTab(id)}
              className={`rounded-md px-2.5 py-1 text-sm font-medium ${tab === id
                ? 'bg-background text-foreground shadow-sm' : 'text-muted-foreground hover:text-foreground'}`}>
              {t(`edit.${id}`)}
            </button>
          ))}
        </div>
        <div id={`${ids}-panel`} role="tabpanel" aria-labelledby={`${ids}-tab-${tab}`} className="grid min-w-0 gap-3">
          {loading && !profile && <p className="m-0 text-sm text-muted-foreground" role="status">{t('edit.loading')}</p>}
          {error && <p className="error m-0 text-sm" role="alert">{t('edit.failed', { message: error })}</p>}
          {tab === 'profile' && (
            <ProfilePanel ids={ids} name={name} description={profile?.profile.description ?? ''} facts={profile ? [
              [t('edit.handle'), profile.profile.name],
              [t('field.harness'), profile.profile.harness],
              [t('edit.package'), profile.profile.package],
              [t('edit.revision'), profile.profile.revision],
              [t('edit.template'), profile.profile.template === null ? null : profile.profile.template ? t('yes') : t('no')],
              [t('field.parent'), profile.profile.parentId],
              [t('edit.status'), profile.profile.status],
            ] : []} />
          )}
          {tab === 'context' && profile && (viewing
            ? <FileViewer agentId={soul.agentId} path={viewing} onBack={() => setViewing(null)} />
            : <ContextPanel profile={profile} onOpen={setViewing} />)}
          {profile?.errors.map((e, index) => (
            <p key={index} className="m-0 text-[11px] text-muted-foreground">
              {e.area ? t('edit.error', { area: e.area, message: e.message }) : e.message}
            </p>
          ))}
        </div>
        <div className="flex justify-end">
          <button type="button" onClick={onClose}
            className="min-h-8 rounded-md px-4 text-sm font-medium text-foreground hover:bg-accent">
            {t('close')}
          </button>
        </div>
      </section>
    </div>,
    document.body,
  );
}

/** The design's Profile tab: Name and Role, then Description, shown read-only; then the profile's other facts. */
function ProfilePanel({ ids, name, description, facts }: { ids: string; name: string; description: string; facts: [string, string | null][] }) {
  const { t } = useI18n();
  return (
    <>
      <div className="grid grid-cols-2 gap-2">
        <div className="grid gap-1">
          <label htmlFor={`${ids}-name`} className={label}>{t('launch.name')}</label>
          <input id={`${ids}-name`} className={field} value={name} readOnly disabled />
        </div>
        <div className="grid gap-1">
          <label htmlFor={`${ids}-role`} className={label}>{t('edit.role')}</label>
          {/* agent-bot's profile carries no role yet. */}
          <input id={`${ids}-role`} className={field} value="" placeholder={t('none')} readOnly disabled />
        </div>
      </div>
      <div className="grid gap-1">
        <label htmlFor={`${ids}-desc`} className={label}>{t('edit.description')}</label>
        <textarea id={`${ids}-desc`} className={`${field} resize-none`} rows={3} value={description}
          placeholder={t('edit.descriptionHint')} readOnly disabled />
      </div>
      {facts.length > 0 && (
        <dl className="m-0 divide-y divide-border rounded-md border border-border text-sm">
          {facts.map(([term, value]) => (
            <div key={term} className="flex gap-3 px-3 py-1.5">
              <dt className="w-28 shrink-0 text-muted-foreground">{term}</dt>
              <dd className="m-0 min-w-0 flex-1 font-mono text-xs leading-5 [overflow-wrap:anywhere]">{value ?? t('none')}</dd>
            </div>
          ))}
        </dl>
      )}
    </>
  );
}

function List({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section>
      <h3 className={sectionTitle}>{title}</h3>
      <ul className="m-0 list-none divide-y divide-border rounded-md border border-border p-0 text-xs">{children}</ul>
    </section>
  );
}

const row = 'flex items-baseline gap-2 px-3 py-1.5';
const commitText = (commit: string | null, t: Translate) => (commit ? t('edit.commit', { commit: shortCommit(commit) }) : t('edit.noCommit'));

/**
 * The Context tab, per the owner's comment on #64: the SOP the soul resolves
 * (with its pinned commit) and its own override, the SOP's skills and the
 * soul's own, its credentials (names and status, never values), and the
 * files the harness loads, each text file opening in the viewer.
 */
function ContextPanel({ profile, onOpen }: { profile: NonNullable<ReturnType<typeof useSoulProfile>['profile']>; onOpen: (path: string) => void }) {
  const { t } = useI18n();
  const { resolved, override } = profile.sop;
  return (
    <>
      <p className="m-0 text-xs text-muted-foreground">{t('edit.contextHint')}</p>
      <List title={t('edit.sop')}>
        <li className={row}>
          <span className="w-20 shrink-0 text-muted-foreground">{t('edit.sopResolved')}</span>
          {resolved
            ? <span className="min-w-0 font-mono [overflow-wrap:anywhere]">{resolved.source} <span className="text-muted-foreground">{commitText(resolved.commit, t)}</span></span>
            : <span className="text-muted-foreground">{t('none')}</span>}
        </li>
        <li className={row}>
          <span className="w-20 shrink-0 text-muted-foreground">{t('edit.sopOverride')}</span>
          {override
            ? (
              <span className="min-w-0 font-mono [overflow-wrap:anywhere]">
                {override.path}
                {override.workflows.map((w) => <span key={w} className="block text-muted-foreground">{w}</span>)}
              </span>
            )
            : <span className="text-muted-foreground">{t('none')}</span>}
        </li>
      </List>
      <List title={t('edit.skills')}>
        {profile.skills.length === 0 && <li className={`${row} text-muted-foreground`}>{t('none')}</li>}
        {profile.skills.map((s) => (
          <li key={`${s.source}:${s.name}:${s.path ?? ''}`} className={row}>
            <span className="min-w-0 flex-1 font-mono [overflow-wrap:anywhere]">{s.name}</span>
            <span className="rounded border border-border px-1 text-[11px] text-muted-foreground">{s.source === 'sop' ? t('edit.skillSop') : t('edit.skillSoul')}</span>
            <span className="font-mono text-[11px] text-muted-foreground">{commitText(s.commit, t)}</span>
          </li>
        ))}
      </List>
      <List title={t('edit.credentials')}>
        {profile.credentials.length === 0 && <li className={`${row} text-muted-foreground`}>{t('none')}</li>}
        {profile.credentials.map((c) => (
          <li key={`${c.provider ?? ''}:${c.name}`} className={row}>
            <span className="min-w-0 flex-1 font-mono [overflow-wrap:anywhere]">{c.name}</span>
            {c.provider && <span className="text-[11px] text-muted-foreground">{c.provider}</span>}
            <span className="text-[11px] text-muted-foreground">{c.status ?? t('unknown')}</span>
          </li>
        ))}
      </List>
      <List title={t('edit.files')}>
        {profile.files.length === 0 && <li className={`${row} text-muted-foreground`}>{t('none')}</li>}
        {profile.files.map((f) => <FileRow key={f.path} file={f} onOpen={onOpen} />)}
      </List>
    </>
  );
}

function FileRow({ file, onOpen }: { file: SoulProfileFileEntry; onOpen: (path: string) => void }) {
  const { t } = useI18n();
  const facts = <span className="shrink-0 text-[11px] text-muted-foreground">{file.kind}{file.size !== null && ` · ${t('edit.bytes', { count: file.size })}`}</span>;
  if (!file.text) {
    return (
      <li className={`${row} text-muted-foreground`}>
        <span className="min-w-0 flex-1 truncate font-mono">{file.path}</span>
        {facts}
        <span className="shrink-0 text-[11px]">{t('edit.notText')}</span>
      </li>
    );
  }
  return (
    <li>
      <button type="button" onClick={() => onOpen(file.path)}
        className={`${row} w-full text-left hover:bg-accent/50`}>
        <span className="min-w-0 flex-1 truncate font-mono text-foreground">{file.path}</span>
        {facts}
      </button>
    </li>
  );
}

/** One file's text, read-only, from `soul profile --file`. */
function FileViewer({ agentId, path, onBack }: { agentId: string; path: string; onBack: () => void }) {
  const { t } = useI18n();
  const source = useContext(ProfileSourceContext);
  const [read, setRead] = useState<{ contents: string | null; error: string | null }>({ contents: null, error: null });
  const back = useRef<HTMLButtonElement>(null);
  useEffect(() => { back.current?.focus(); }, []);
  useEffect(() => {
    setRead({ contents: null, error: null });
    if (!source) return;
    let current = true;
    source.file(agentId, path).then(
      (file) => { if (current) setRead({ contents: file.contents, error: null }); },
      (failure: unknown) => {
        if (!current) return;
        const e = failure as { message?: unknown };
        setRead({ contents: null, error: typeof e?.message === 'string' ? e.message : String(failure) });
      },
    );
    return () => { current = false; };
  }, [agentId, path, source]);
  return (
    <section className="grid gap-2">
      <div className="flex items-center gap-2">
        <button ref={back} type="button" onClick={onBack} aria-label={t('edit.back')} title={t('edit.back')}
          className="rounded p-1 text-muted-foreground hover:bg-accent hover:text-foreground">
          <ArrowLeft className="size-4" aria-hidden />
        </button>
        <h3 className="m-0 min-w-0 truncate font-mono text-sm">{path}</h3>
      </div>
      {read.error && <p className="error m-0 text-sm" role="alert">{t('edit.fileFailed', { path, message: read.error })}</p>}
      {!read.error && read.contents === null && <p className="m-0 text-sm text-muted-foreground" role="status">{t('edit.opening')}</p>}
      {read.contents !== null && (
        <pre aria-label={path} tabIndex={0}
          className="m-0 h-72 overflow-auto rounded-md border border-border bg-muted/40 p-3 font-mono text-xs whitespace-pre-wrap [overflow-wrap:anywhere] text-foreground">
          {read.contents}
        </pre>
      )}
    </section>
  );
}
