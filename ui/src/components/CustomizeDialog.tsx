import { useContext, useEffect, useId, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { invoke } from '@tauri-apps/api/core';
import { X } from 'lucide-react';
import { BridgeError, inApp, type SoulProfileFileEntry } from '../bridge';
import { displayName, type CensusRow } from '../model/census';
import { harnessLabel, MAX_ROLE, soulHarnessLabel } from '../model/launch';
import { useI18n, type Translate } from '../lib/i18n';
import { ProfileSourceContext, useSoulProfile } from '../useSoulProfile';
import { derivedHue } from '../model/dudle';
import { radioGroupKeys } from '../lib/radioGroup';
import { tabStep } from '../lib/keys';
import { SoulDudle } from './FleetList';

type Tab = 'profile' | 'context';
const TABS: readonly Tab[] = ['profile', 'context'];
/** What the Context tab's right pane shows: one of the sections, or a file. */
type Pane = { section: 'sop' | 'skills' | 'credentials' } | { file: string };
const SECTIONS = ['sop', 'skills', 'credentials'] as const;

// As the design's shadcn Input and Textarea, and their labels.
const fieldBase = 'w-full rounded-md border border-input bg-transparent px-3 text-sm text-foreground shadow-sm disabled:cursor-default disabled:opacity-100';
const field = `h-9 py-1 ${fieldBase}`;
const textareaField = `min-h-[60px] py-2 ${fieldBase}`;
const label = 'block text-sm leading-none font-medium';
const sectionTitle = 'm-0 mb-1 text-xs font-medium text-muted-foreground';
const shortCommit = (commit: string) => commit.slice(0, 10);
const shortRevision = (revision: string) => revision.replace(/^sha256:/, '').slice(0, 12);

/** The owner's edits, as `soul_revision_edit` takes them: only what changed. */
export interface RevisionEditRequest {
  /** The revision the dialog read; the bridge refuses when it moved. */
  expectedRevision: string | null;
  reason: string;
  /**
   * `appearance`: the soul.json key to write (`{ hue }`, 0..359) or remove
   * (null, back to the hue derived from the agent ID); absent leaves it.
   * `role`: soul.json's `role` (agent-bot-identity #535), at most 60
   * characters; empty removes it; absent leaves it.
   */
  edit: { name?: string; description?: string; appearance?: { hue: number } | null; role?: string; files: Record<string, string> };
}

/** The design's colour swatches, in degrees. */
export const SWATCHES: readonly number[] = [0, 30, 60, 120, 170, 210, 250, 280, 320];

/** Records the owner's edits as a new revision; resolves with its hash. */
export type SaveRevision = (agentId: string, request: RevisionEditRequest) => Promise<{ revision: string }>;

/** agent-bot's `soul revision edit`, through the bridge (#64). */
const saveRevision: SaveRevision = async (agentId, { expectedRevision, reason, edit }) => {
  if (!inApp()) throw new BridgeError('soul-revision-unavailable', 'not in the app');
  let raw: unknown;
  try {
    raw = await invoke<unknown>('soul_revision_edit', { agent: agentId, expectedRevision, reason, edit });
  } catch (failure) {
    const e = failure as { code?: unknown; message?: unknown };
    throw new BridgeError(typeof e?.code === 'string' ? e.code : 'soul-revision-failed',
      typeof e?.message === 'string' ? e.message : String(failure));
  }
  const revision = (raw as { revision?: unknown } | null)?.revision;
  if (typeof revision !== 'string') throw new BridgeError('soul-revision-failed', 'agent-bot recorded no revision');
  return { revision };
};

/** soul-builder's output (agent-bot's generated harness paths): rebuilt, never edited. */
const GENERATED = ['.claude/', '.codex/', '.cursor/', '.opencode/', '.devin/', '.gemini/',
  '.github/copilot-instructions.md', '.mcp.json', 'CLAUDE.md', 'GEMINI.md', 'opencode.json'];
const GENERATED_MARKER = '<!-- agent-bot soul-builder: generated -->';

/**
 * A file the owner may edit here, as the bridge checks it again: the soul's
 * instructions, AGENTS.md and its skills, as text. Never soul.json (its
 * name and description are the Profile fields), harness settings,
 * working state or a generated file.
 */
export function editableFile(file: SoulProfileFileEntry): boolean {
  return file.text && ['soul', 'context', 'skill'].includes(file.kind) && file.path !== 'soul.json'
    && !file.path.startsWith('.soul-state/')
    && !GENERATED.some((g) => (g.endsWith('/') ? file.path.startsWith(g) : file.path === g));
}

type Drafts = Record<string, { original: string; current: string }>;

/**
 * The design's Customize… dialog (Lovable `EditDialog`, #64): Profile
 * (name, role, description, colour) and Context (the SOP, skills, credentials and
 * the files the harness loads), from agent-bot `soul profile`, read each
 * time it opens. Name, description and colour, and the soul's own instruction and
 * skill files, can be edited; Save records them as one owner-approved
 * revision of the soul's package (agent-bot `soul revision edit`, which asks
 * the owner itself), with a one-line reason. Role is edited too: `soul
 * profile` has none, so it starts from the census row's role (agent-bot's
 * population list, agent-bot-identity #535). The other files open in a
 * read-only viewer.
 * Escape, ×, Close or a backdrop click closes it.
 */
export function CustomizeDialog({ soul, onClose, save = saveRevision }: { soul: CensusRow; onClose: () => void; save?: SaveRevision }) {
  // Reload starts over: a fresh read of the profile, the edits dropped.
  const [generation, setGeneration] = useState(0);
  const pressedBackdrop = useRef(false);

  // Portalled to the body, as the ⓘ sheet: the companion window's transform
  // would contain the fixed overlay, and its title bar would take the drag.
  return createPortal(
    <div className="fixed inset-0 z-50 grid place-items-center bg-black/80 p-4"
      onPointerDown={(e) => { e.stopPropagation(); pressedBackdrop.current = e.target === e.currentTarget; }}
      onClick={(e) => { if (e.target === e.currentTarget && pressedBackdrop.current) onClose(); }}>
      <CustomizeBody key={generation} soul={soul} onClose={onClose} save={save} onReload={() => setGeneration((g) => g + 1)} />
    </div>,
    document.body,
  );
}

function CustomizeBody({ soul, onClose, save, onReload }: { soul: CensusRow; onClose: () => void; save: SaveRevision; onReload: () => void }) {
  const { t } = useI18n();
  const ids = useId();
  const titleId = `${ids}-title`;
  const { profile, loading, error } = useSoulProfile(soul.agentId, true);
  const [tab, setTab] = useState<Tab>('profile');
  // The Context tab's left pane selection (Lovable's file list); the SOP first.
  const [pane, setPane] = useState<Pane>({ section: 'sop' });
  const viewing = 'file' in pane ? pane.file : null;
  // hue: a number is a declared colour, null the derived one; undefined untouched.
  const [draft, setDraft] = useState<{ name?: string; description?: string; hue?: number | null; role?: string }>({});
  const [saved, setSaved] = useState<{ name?: string; description?: string; hue?: number | null; role?: string }>({});
  const [files, setFiles] = useState<Drafts>({});
  const [reason, setReason] = useState(() => t('edit.reasonDefault'));
  const [saving, setSaving] = useState(false);
  const [result, setResult] = useState<string | null>(null);
  const [saveError, setSaveError] = useState<{ code: string; message: string } | null>(null);
  const firstTab = useRef<HTMLButtonElement>(null);
  const close = useRef(onClose);
  close.current = onClose;
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') close.current(); };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, []);
  useEffect(() => { firstTab.current?.focus(); }, []);
  const baseName = saved.name ?? profile?.profile.displayName ?? displayName(soul);
  const baseDescription = saved.description ?? profile?.profile.description ?? '';
  const name = draft.name ?? baseName;
  const description = draft.description ?? baseDescription;
  // The profile has no role, so the census row's (population list) is the base.
  const baseRole = saved.role ?? soul.role ?? '';
  const role = draft.role ?? baseRole;
  // Until the profile answers, the census's population hue stands in.
  const baseHue = saved.hue !== undefined ? saved.hue
    : profile ? profile.profile.appearance?.hue ?? null : soul.hue ?? null;
  const hue = draft.hue !== undefined ? draft.hue : baseHue;
  const harness = profile?.profile.harness ? harnessLabel(profile.profile.harness) : soulHarnessLabel(soul);
  const nameChanged = draft.name !== undefined && draft.name.trim() !== baseName;
  const descriptionChanged = draft.description !== undefined && draft.description.trim() !== baseDescription.trim();
  const changedFiles = Object.entries(files).filter(([, f]) => f.current !== f.original);
  const hueChanged = draft.hue !== undefined && draft.hue !== baseHue;
  const roleChanged = draft.role !== undefined && draft.role.trim() !== baseRole.trim();
  const dirty = nameChanged || descriptionChanged || hueChanged || roleChanged || changedFiles.length > 0;
  const valid = (!nameChanged || name.trim() !== '') && (!descriptionChanged || description.trim() !== '') && reason.trim() !== '';
  const editable = profile !== null;

  const edited = () => { setResult(null); setSaveError(null); };
  const onSave = async () => {
    if (!profile || !dirty || !valid || saving) return;
    const edit: RevisionEditRequest['edit'] = { files: Object.fromEntries(changedFiles.map(([path, f]) => [path, f.current])) };
    if (nameChanged) edit.name = name.trim();
    if (descriptionChanged) edit.description = description.trim();
    if (hueChanged) edit.appearance = draft.hue === null || draft.hue === undefined ? null : { hue: draft.hue };
    if (roleChanged) edit.role = role.trim();
    setSaving(true);
    edited();
    try {
      const record = await save(profile.agentId, { expectedRevision: profile.profile.revision, reason: reason.trim(), edit });
      setResult(record.revision);
      setSaved((s) => ({ name: edit.name ?? s.name, description: edit.description ?? s.description,
        hue: edit.appearance === undefined ? s.hue : edit.appearance?.hue ?? null,
        // The saved role shows here before the next population read brings it.
        role: edit.role ?? s.role }));
      setDraft({});
      setFiles((all) => Object.fromEntries(Object.entries(all).map(([path, f]) => [path, { original: f.current, current: f.current }])));
    } catch (failure) {
      const e = failure as { code?: unknown; message?: unknown };
      setSaveError({ code: typeof e?.code === 'string' ? e.code : 'soul-revision-failed', message: typeof e?.message === 'string' ? e.message : String(failure) });
    } finally {
      setSaving(false);
    }
  };

  return (
    <section role="dialog" aria-modal="true" aria-labelledby={titleId}
      onKeyDown={(e) => { if (e.key === 'Escape') { e.stopPropagation(); onClose(); } }}
      className="relative grid max-h-full w-full max-w-2xl gap-4 overflow-y-auto rounded-lg border border-border bg-background p-6 shadow-lg">
      <button type="button" onClick={onClose} aria-label={t('close')}
        className="absolute top-4 right-4 rounded-sm text-foreground opacity-70 outline-none hover:opacity-100 focus-visible:ring-2 focus-visible:ring-ring">
        <X className="size-4" aria-hidden />
      </button>
      <div className="flex items-center gap-3 pr-8">
        {/* The chosen colour, live, as the design's title. */}
        <SoulDudle soul={hue === null ? { ...soul, hue: undefined } : { ...soul, hue }} size={36} paused={false} />
        <h2 id={titleId} className="m-0 truncate text-lg leading-none font-semibold tracking-tight">{name.trim() || baseName}</h2>
        <span className="rounded border border-border px-1.5 py-0.5 font-mono text-[10px] text-muted-foreground">{harness}</span>
      </div>
      {/* The session's segmented tabs, as the design's. */}
      <div role="tablist" aria-label={t('edit.title')} className="flex w-fit gap-0.5 rounded-lg bg-muted p-1"
        onKeyDown={(e) => {
          const next = tabStep(e.key, TABS, tab);
          if (!next) return;
          e.preventDefault();
          setTab(next);
          document.getElementById(`${ids}-tab-${next}`)?.focus();
        }}>
        {TABS.map((id) => (
          <button key={id} ref={id === 'profile' ? firstTab : undefined} id={`${ids}-tab-${id}`} type="button" role="tab"
            aria-selected={tab === id} aria-controls={`${ids}-panel`} tabIndex={tab === id ? 0 : -1}
            onClick={() => setTab(id)}
            className={`rounded-md px-3 py-1 text-sm font-medium outline-none focus-visible:ring-2 focus-visible:ring-ring ${tab === id
              ? 'bg-background text-foreground shadow' : 'text-muted-foreground hover:text-foreground'}`}>
            {t(`edit.${id}`)}
          </button>
        ))}
      </div>
      <div id={`${ids}-panel`} role="tabpanel" aria-labelledby={`${ids}-tab-${tab}`} className="grid min-w-0 gap-3">
        {loading && !profile && <p className="m-0 text-sm text-muted-foreground" role="status">{t('edit.loading')}</p>}
        {error && <p className="m-0 text-sm text-destructive" role="alert">{t('edit.failed', { message: error })}</p>}
        {tab === 'profile' && (
          <ProfilePanel ids={ids} name={name} description={description} editable={editable}
            onName={(value) => { setDraft((d) => ({ ...d, name: value })); edited(); }}
            onDescription={(value) => { setDraft((d) => ({ ...d, description: value })); edited(); }}
            role={role} onRole={(value) => { setDraft((d) => ({ ...d, role: value })); edited(); }}
            hue={hue ?? derivedHue(soul.agentId)} declared={hue !== null}
            onHue={(value) => { setDraft((d) => ({ ...d, hue: value })); edited(); }}
            facts={profile ? [
              [t('edit.handle'), profile.profile.name],
              [t('field.harness'), profile.profile.harness],
              [t('edit.package'), profile.profile.package],
              [t('edit.revision'), profile.profile.revision],
              [t('edit.template'), profile.profile.template === null ? null : profile.profile.template ? t('yes') : t('no')],
              [t('field.parent'), profile.profile.parentId],
              [t('edit.status'), profile.profile.status],
            ] : []} />
        )}
        {tab === 'context' && profile && (
          <ContextPanel profile={profile} pane={pane} onPane={setPane}
            edited={new Set(changedFiles.map(([path]) => path))}>
            {viewing && (profile.files.some((f) => f.path === viewing && editableFile(f))
              ? <FileEditor key={viewing} agentId={soul.agentId} path={viewing} draft={files[viewing]}
                onLoad={(contents) => setFiles((all) => (all[viewing] ? all : { ...all, [viewing]: { original: contents, current: contents } }))}
                onChange={(contents) => { setFiles((all) => ({ ...all, [viewing]: { original: all[viewing]?.original ?? contents, current: contents } })); edited(); }} />
              : <FileViewer key={viewing} agentId={soul.agentId} path={viewing} />)}
          </ContextPanel>
        )}
        {profile?.errors.map((e, index) => (
          <p key={index} className="m-0 text-[11px] text-muted-foreground">
            {e.area ? t('edit.error', { area: e.area, message: e.message }) : e.message}
          </p>
        ))}
      </div>
      {editable && (
        <div className="grid gap-1">
          <label htmlFor={`${ids}-reason`} className={label}>{t('edit.reason')}</label>
          <input id={`${ids}-reason`} className={field} value={reason} maxLength={200}
            onChange={(e) => { setReason(e.target.value); edited(); }} placeholder={t('edit.reasonHint')} />
        </div>
      )}
      {saving && <p className="m-0 text-sm text-muted-foreground" role="status">{t('edit.saving')}</p>}
      {result && <p className="m-0 text-sm text-muted-foreground" role="status">{t('edit.saved', { revision: shortRevision(result) })}</p>}
      {saveError && (
        <div className="flex items-start gap-2">
          <p className="m-0 min-w-0 flex-1 text-sm text-destructive" role="alert">
            {saveError.code === 'soul-revision-stale' ? t('edit.stale')
              : saveError.code === 'owner-credential-required' ? t('edit.ownerRequired', { message: saveError.message })
                : t('edit.saveFailed', { message: saveError.message })}
          </p>
          {saveError.code === 'soul-revision-stale' && (
            <button type="button" onClick={onReload}
              className="min-h-8 shrink-0 rounded-md border border-border px-3 text-sm font-medium text-foreground hover:bg-accent">
              {t('edit.reload')}
            </button>
          )}
        </div>
      )}
      <div className="flex justify-end gap-2">
        <button type="button" onClick={onClose}
          className="min-h-8 rounded-md px-4 text-sm font-medium text-foreground hover:bg-accent">
          {t('cancel')}
        </button>
        {editable && (
          <button type="button" onClick={() => { void onSave(); }} disabled={!dirty || !valid || saving}
            className="min-h-8 rounded-md bg-primary px-4 text-sm font-medium text-primary-foreground shadow hover:bg-primary/90 disabled:opacity-50">
            {t('edit.save')}
          </button>
        )}
      </div>
    </section>
  );
}

/** The design's Profile tab: Name and Role, then Description; then the profile's other facts. */
function ProfilePanel({ ids, name, description, editable, onName, onDescription, role, onRole, hue, declared, onHue, facts }: {
  ids: string; name: string; description: string; editable: boolean;
  onName: (value: string) => void; onDescription: (value: string) => void;
  /** The role shown (soul.json `role`, from the census row); empty when none. */
  role: string; onRole: (value: string) => void;
  /** The hue shown, 0..359; `declared` false when it is the derived one. */
  hue: number; declared: boolean; onHue: (value: number | null) => void;
  facts: [string, string | null][];
}) {
  const { t } = useI18n();
  return (
    <>
      <div className="grid grid-cols-2 gap-2">
        <div className="grid gap-1">
          <label htmlFor={`${ids}-name`} className={label}>{t('launch.name')}</label>
          <input id={`${ids}-name`} className={field} value={name} maxLength={30} required
            disabled={!editable} onChange={(e) => onName(e.target.value)} />
        </div>
        <div className="grid gap-1">
          <label htmlFor={`${ids}-role`} className={label}>{t('edit.role')}</label>
          {/* agent-bot's profile carries no role; it comes from the population list. Empty removes it. */}
          <input id={`${ids}-role`} className={field} value={role} maxLength={MAX_ROLE}
            disabled={!editable} onChange={(e) => onRole(e.target.value)} />
        </div>
      </div>
      <div className="grid gap-1">
        <label htmlFor={`${ids}-desc`} className={label}>{t('edit.description')}</label>
        <textarea id={`${ids}-desc`} className={`${textareaField} resize-none`} rows={3} value={description} maxLength={500}
          placeholder={t('edit.descriptionHint')} disabled={!editable} onChange={(e) => onDescription(e.target.value)} />
      </div>
      <ColourField ids={ids} hue={hue} declared={declared} editable={editable} onHue={onHue} />
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

/**
 * The design's colour control: a hue slider and nine swatches (a radio
 * group, arrow keys move and select), and a way back to the hue derived
 * from the agent ID.
 */
function ColourField({ ids, hue, declared, editable, onHue }: {
  ids: string; hue: number; declared: boolean; editable: boolean; onHue: (value: number | null) => void;
}) {
  const { t } = useI18n();
  const onSwatch = SWATCHES.includes(hue);
  return (
    <div className="grid gap-2">
      <label htmlFor={`${ids}-hue`} className={label}>{t('edit.color')}</label>
      <input id={`${ids}-hue`} type="range" min={0} max={359} step={1} value={hue} disabled={!editable}
        aria-valuetext={declared ? t('edit.hueValue', { hue }) : t('edit.hueDerived', { hue })}
        onChange={(e) => onHue(Number(e.target.value))} className="w-full accent-primary" />
      <div className="flex flex-wrap items-center gap-1.5">
        <div role="radiogroup" aria-label={t('edit.color')} onKeyDown={radioGroupKeys} className="flex flex-wrap gap-1.5">
          {SWATCHES.map((h) => (
            <button key={h} type="button" role="radio" aria-checked={hue === h} aria-label={`${h}°`} disabled={!editable}
              tabIndex={hue === h || (!onSwatch && h === SWATCHES[0]) ? 0 : -1} onClick={() => onHue(h)}
              className={`size-6 rounded-full outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50 ${hue === h ? 'ring-2 ring-foreground' : ''}`}
              style={{ background: `oklch(0.7 0.15 ${h})` }} />
          ))}
        </div>
        {declared && editable && (
          <button type="button" onClick={() => onHue(null)}
            className="ml-auto rounded-md px-2 py-1 text-xs text-muted-foreground hover:bg-accent hover:text-foreground">
            {t('edit.colorDefault')}
          </button>
        )}
      </div>
    </div>
  );
}

function List({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section>
      <h3 className={sectionTitle}>{title}</h3>
      <ul className="m-0 list-none divide-y divide-border p-0 text-xs">{children}</ul>
    </section>
  );
}

const row = 'flex items-baseline gap-2 py-1.5';
const commitText = (commit: string | null, t: Translate) => (commit ? t('edit.commit', { commit: shortCommit(commit) }) : t('edit.noCommit'));
// Lovable's file list entry (mono text-xs, active bg-accent).
const entry = 'flex w-full items-center gap-1 truncate px-2 py-1 text-left font-mono text-xs outline-none focus-visible:ring-2 focus-visible:ring-ring';

/**
 * The Context tab, per the owner's comment on #64, as the design's two panes
 * (Lovable `EditDialog`): a list on the left of the SOP the soul resolves
 * (with its pinned commit) and its own override, the SOP's skills and the
 * soul's own, its credentials (names and status, never values), and the
 * files the harness loads; the right pane shows the chosen one, a text file
 * in the viewer or editor (`children`).
 */
function ContextPanel({ profile, pane, onPane, edited, children }: {
  profile: NonNullable<ReturnType<typeof useSoulProfile>['profile']>;
  pane: Pane; onPane: (pane: Pane) => void; edited: ReadonlySet<string>; children: ReactNode;
}) {
  const { t } = useI18n();
  const { resolved, override } = profile.sop;
  const file = 'file' in pane ? profile.files.find((f) => f.path === pane.file) ?? null : null;
  const sectionTitles = { sop: t('edit.sop'), skills: t('edit.skills'), credentials: t('edit.credentials') };
  return (
    <>
      <p className="m-0 text-xs text-muted-foreground">{t('edit.contextHint')}</p>
      <div className="flex h-72 overflow-hidden rounded-md border border-border">
        <ul className="m-0 w-44 shrink-0 list-none overflow-y-auto border-r border-border bg-muted/40 px-0 py-1" aria-label={t('edit.context')}>
          {SECTIONS.map((id) => {
            const active = 'section' in pane && pane.section === id;
            return (
              <li key={id}>
                <button type="button" onClick={() => onPane({ section: id })} aria-current={active ? 'true' : undefined}
                  className={`${entry} font-sans ${active ? 'bg-accent text-foreground' : 'text-muted-foreground hover:bg-accent/50'}`}>
                  {sectionTitles[id]}
                </button>
              </li>
            );
          })}
          <li className="px-2 pt-2 pb-0.5 font-mono text-[10px] tracking-wider text-muted-foreground uppercase" aria-hidden>{t('edit.files')}</li>
          {profile.files.length === 0 && <li className="px-2 py-1 text-xs text-muted-foreground">{t('none')}</li>}
          {profile.files.map((f) => (
            <FileEntry key={f.path} file={f} edited={edited.has(f.path)} active={'file' in pane && pane.file === f.path}
              onOpen={() => onPane({ file: f.path })} />
          ))}
        </ul>
        <div className="flex min-w-0 flex-1 flex-col">
          {'section' in pane && (
            <div className="min-h-0 flex-1 overflow-y-auto px-3 py-2">
              {pane.section === 'sop' && (
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
              )}
              {pane.section === 'skills' && (
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
              )}
              {pane.section === 'credentials' && (
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
              )}
            </div>
          )}
          {'file' in pane && (
            <>
              <div className="flex items-baseline gap-2 border-b border-border px-3 py-1.5">
                <h3 className="m-0 min-w-0 flex-1 truncate font-mono text-xs font-medium">{pane.file}</h3>
                {file && <FileFacts file={file} edited={edited.has(file.path)} />}
              </div>
              {file && !file.text
                ? <p className="m-0 p-3 text-xs text-muted-foreground">{t('edit.notText')}</p>
                : children}
            </>
          )}
        </div>
      </div>
    </>
  );
}

function FileFacts({ file, edited }: { file: SoulProfileFileEntry; edited: boolean }) {
  const { t } = useI18n();
  return (
    <span className="shrink-0 text-[11px] text-muted-foreground">
      {file.kind}{file.size !== null && ` · ${t('edit.bytes', { count: file.size })}`}{edited && ` · ${t('edit.edited')}`}
    </span>
  );
}

/** One file in the left pane: a text file opens on the right; any other says why not. */
function FileEntry({ file, edited, active, onOpen }: { file: SoulProfileFileEntry; edited: boolean; active: boolean; onOpen: () => void }) {
  const { t } = useI18n();
  if (!file.text) {
    return (
      <li className="flex items-center gap-1 truncate px-2 py-1 font-mono text-xs text-muted-foreground/70" title={`${file.path} · ${t('edit.notText')}`}>
        <span className="min-w-0 truncate">{file.path}</span>
        <span className="sr-only">, {t('edit.notText')}</span>
      </li>
    );
  }
  return (
    <li>
      <button type="button" onClick={onOpen} aria-current={active ? 'true' : undefined} title={file.path}
        className={`${entry} ${active ? 'bg-accent text-foreground' : 'text-muted-foreground hover:bg-accent/50'}`}>
        <span className="min-w-0 truncate">{file.path}</span>
        {edited && <><span className="ml-auto shrink-0 text-primary" aria-hidden>•</span><span className="sr-only">, {t('edit.edited')}</span></>}
      </button>
    </li>
  );
}

/** One file's text, read-only, from `soul profile --file`. */
function FileViewer({ agentId, path }: { agentId: string; path: string }) {
  const { t } = useI18n();
  const source = useContext(ProfileSourceContext);
  const [read, setRead] = useState<{ contents: string | null; error: string | null }>({ contents: null, error: null });
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
    <>
      {read.error && <p className="m-0 p-3 text-xs text-destructive" role="alert">{t('edit.fileFailed', { path, message: read.error })}</p>}
      {!read.error && read.contents === null && <p className="m-0 p-3 text-xs text-muted-foreground" role="status">{t('edit.opening')}</p>}
      {read.contents !== null && (
        <pre aria-label={path} tabIndex={0}
          className="m-0 min-h-0 flex-1 overflow-auto p-3 font-mono text-xs whitespace-pre-wrap [overflow-wrap:anywhere] text-foreground">
          {read.contents}
        </pre>
      )}
    </>
  );
}

/**
 * One editable file, from `soul profile --file` the first time it opens;
 * after that the dialog's draft. A file that carries soul-builder's mark
 * stays read-only (the bridge refuses it too).
 */
function FileEditor({ agentId, path, draft, onLoad, onChange }: {
  agentId: string; path: string; draft: { current: string } | undefined;
  onLoad: (contents: string) => void; onChange: (contents: string) => void;
}) {
  const { t } = useI18n();
  const source = useContext(ProfileSourceContext);
  const [error, setError] = useState<string | null>(null);
  const load = useRef(onLoad);
  load.current = onLoad;
  const loaded = draft !== undefined;
  useEffect(() => {
    if (loaded || !source) return;
    let current = true;
    setError(null);
    source.file(agentId, path).then(
      (file) => { if (current) load.current(file.contents); },
      (failure: unknown) => {
        if (!current) return;
        const e = failure as { message?: unknown };
        setError(typeof e?.message === 'string' ? e.message : String(failure));
      },
    );
    return () => { current = false; };
  }, [agentId, path, source, loaded]);
  const generated = draft?.current.includes(GENERATED_MARKER) ?? false;
  return (
    <>
      {error && <p className="m-0 p-3 text-xs text-destructive" role="alert">{t('edit.fileFailed', { path, message: error })}</p>}
      {!error && !draft && <p className="m-0 p-3 text-xs text-muted-foreground" role="status">{t('edit.opening')}</p>}
      {draft && (
        // As the design's pane Textarea: borderless, filling the right pane.
        <textarea aria-label={path} value={draft.current} spellCheck={false} readOnly={generated}
          onChange={(e) => onChange(e.target.value)}
          className="m-0 h-full min-h-0 w-full flex-1 resize-none overflow-auto rounded-none border-0 bg-transparent p-3 font-mono text-xs text-foreground" />
      )}
    </>
  );
}
