import { useEffect, useId, useRef, useState } from 'react';
import { Archive } from 'lucide-react';
import { removalPlan, removeSoul, soulComms, type RemovalPlan, type RemovalPlanEntry, type RemovalScope, type RemovedSoul } from '../bridge';
import { displayName, type CensusRow } from '../model/census';
import { useI18n, type Translate } from '../lib/i18n';
import { focusReturnOf } from './AboutDialog';

/** How GeniusBar archives a soul (#94, #283); the app's is agent-bot's, previews pass a fake. */
export interface Archiver {
  /** Archives the soul, or with `scope` (#283) what the engine's plan for that scope says; omitted is the single remove every engine knows. */
  remove: (agentId: string, scope?: RemovalScope) => Promise<RemovedSoul>;
  /**
   * What archiving would touch (#283), per scope, as the engine computes it;
   * null when the engine cannot say (no `--plan`), and the dialog then
   * shows only the soul and never guesses its team's fate.
   */
  plan: (agentId: string, scope: RemovalScope) => Promise<RemovalPlan | null>;
  /** Whether the soul runs now, the comms switch's lock; null when agent-bot cannot say. */
  running: (agentId: string) => Promise<boolean | null>;
}

// An engine without `--plan` answers its usage line every time; asked once
// per app run, then remembered, so each dialog does not run it again. The
// next app start asks afresh, which is when a bundle changes.
let planUnsupported = false;

export const liveArchiver: Archiver = {
  remove: (agentId, scope) => removeSoul(agentId, scope ?? null),
  plan: async (agentId, scope) => {
    if (planUnsupported) return null;
    const plan = await removalPlan(agentId, scope);
    if (plan === null) planUnsupported = true;
    return plan;
  },
  running: (agentId) => soulComms(agentId).then((state) => state?.running ?? null),
};

/** A plan's one-word state for a soul: what the engine said, nothing inferred. */
function entryState(entry: RemovalPlanEntry, t: Translate): string {
  if (entry.status === 'retired') return t('bar.planRetired');
  if (entry.running === true) return t('bar.planRunning');
  if (entry.running === false) return t('bar.planOffline');
  return t('bar.planActive');
}

/** One of the plan's lists: every name, nested by depth, with its state and count. */
function PlanList({ label, entries }: { label: string; entries: RemovalPlanEntry[] }) {
  const { t } = useI18n();
  if (entries.length === 0) return null;
  return (
    <div>
      <p className="m-0 text-[11px] font-medium text-muted-foreground">{label} ({entries.length})</p>
      <ul aria-label={label} className="m-0 grid list-none gap-0.5 p-0 text-xs">
        {entries.map((entry) => (
          <li key={entry.agentId} style={{ paddingLeft: `${entry.depth * 12}px` }}>
            {entry.displayName}{entry.name && entry.name !== entry.displayName ? ` (${entry.name})` : ''}
            <span className="text-muted-foreground"> · {entryState(entry, t)}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

type PlanState =
  | { kind: 'loading' }
  | { kind: 'ready'; plan: RemovalPlan }
  /** The engine has no `--plan`: the single-soul dialog, saying so. */
  | { kind: 'unsupported' }
  | { kind: 'failed'; reason: string };

/**
 * Asks before archiving a soul (#94, #283), naming it and saying what
 * happens. Not `window.confirm`, which the Tauri web view blocks. With an
 * engine that plans (agent-bot-identity #625) it shows the exact souls each
 * scope touches, from the engine's plan; without one it archives only this
 * soul and says so, inferring nothing about its team. Archive is locked
 * while any soul it would archive runs; agent-bot asks the owner (Touch ID)
 * and its refusals show here as-is, and the souls stay. Cancel is focused
 * first; Escape, the backdrop and Cancel change nothing, and focus goes back
 * to what opened the dialog.
 */
export function ArchiveDialog({ soul, archiver, onCancel, onArchived }: {
  soul: CensusRow;
  archiver: Archiver;
  onCancel: () => void;
  onArchived: (soul: CensusRow, result: RemovedSoul) => void;
}) {
  const { t } = useI18n();
  const name = displayName(soul);
  const titleId = useId();
  const scopeId = useId();
  const [running, setRunning] = useState<boolean | null | 'checking'>('checking');
  const [scope, setScope] = useState<RemovalScope>('soul');
  const [plans, setPlans] = useState<Partial<Record<RemovalScope, PlanState>>>({});
  const [archiving, setArchiving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const cancel = useRef<HTMLButtonElement>(null);
  const opener = useRef<HTMLElement | null>(null);
  useEffect(() => {
    let active = true;
    setRunning('checking');
    archiver.running(soul.agentId).catch(() => null).then((value) => { if (active) setRunning(value); });
    return () => { active = false; };
  }, [archiver, soul.agentId]);
  // The plan for the chosen scope, asked again whenever the scope changes;
  // the first (the soul alone) also says whether it leads anyone, and then
  // the team's plan is fetched for its count.
  useEffect(() => {
    let active = true;
    setPlans((p) => ({ ...p, [scope]: { kind: 'loading' } }));
    archiver.plan(soul.agentId, scope).then(
      (plan) => {
        if (!active) return;
        setPlans((p) => ({ ...p, [scope]: plan ? { kind: 'ready', plan } : { kind: 'unsupported' } }));
        if (plan && scope === 'soul' && plan.capabilities.team && leadsOthers(plan)) {
          archiver.plan(soul.agentId, 'team').then(
            (team) => { if (active && team) setPlans((p) => (p.team ? p : { ...p, team: { kind: 'ready', plan: team } })); },
            () => { /* the team's count waits for its own selection */ },
          );
        }
      },
      (e: unknown) => { if (active) setPlans((p) => ({ ...p, [scope]: { kind: 'failed', reason: messageOf(e) } })); },
    );
    return () => { active = false; };
  }, [archiver, soul.agentId, scope]);
  useEffect(() => {
    opener.current = focusReturnOf(document.activeElement);
    cancel.current?.focus();
    return () => { if (opener.current?.isConnected) opener.current.focus(); };
  }, []);
  const close = () => { if (!archiving) onCancel(); };
  const soulPlan = plans.soul;
  const current = plans[scope] ?? { kind: 'loading' as const };
  const supported = soulPlan?.kind !== 'unsupported';
  const plan = current.kind === 'ready' ? current.plan : null;
  const leads = soulPlan?.kind === 'ready' && soulPlan.plan.capabilities.team && leadsOthers(soulPlan.plan);
  const teamCount = plans.team?.kind === 'ready' ? plans.team.plan.archived.length : null;
  const archive = () => {
    setArchiving(true);
    setError(null);
    archiver.remove(soul.agentId, plan ? scope : undefined).then(
      (result) => onArchived(soul, result),
      (e: unknown) => {
        setError(messageOf(e));
        setArchiving(false);
      },
    );
  };
  // A running soul anywhere in what would be archived locks the button, as
  // the engine would refuse it; the comms check covers an engine without a plan.
  const runningEntry = plan?.archived.find((entry) => entry.running === true) ?? null;
  const runningOther = runningEntry && runningEntry.agentId !== soul.agentId ? runningEntry : null;
  const blocked = running === 'checking' || running === true || current.kind === 'loading' || runningEntry !== null;
  const lock = running === true || (runningEntry && !runningOther) ? t('bar.archiveRunning')
    : runningOther ? t('bar.archiveTeamRunning', { name: runningOther.displayName }) : null;
  const action = plan && plan.archived.length > 1 ? t('bar.archiveMany', { count: plan.archived.length }) : t('bar.archiveOne', { name });
  return (
    <div className="fixed inset-0 z-50 grid place-items-center bg-black/80 p-4"
      onClick={(e) => { if (e.target === e.currentTarget) close(); }}>
      <section role="alertdialog" aria-modal="true" aria-labelledby={titleId}
        onKeyDown={(e) => { if (e.key === 'Escape') { e.stopPropagation(); close(); } }}
        className="grid max-h-full w-full max-w-sm gap-3 overflow-y-auto rounded-lg border border-border bg-background p-5 text-sm shadow-lg">
        <h2 id={titleId} className="m-0 flex items-center gap-2 text-base font-semibold tracking-tight">
          <Archive className="size-4 text-destructive" aria-hidden /> {t('bar.archiveConfirm', { name })}
        </h2>
        <p className="m-0 font-mono text-[11px] text-muted-foreground">{t('bar.archiveId', { id: soul.agentId })}</p>
        <p className="m-0">{t('bar.archiveBody', { name })}</p>
        <div>
          <p className="m-0 text-muted-foreground">{t('bar.archiveWhat')}</p>
          <ul className="m-0 mt-1 grid gap-0.5 pl-5">
            <li>{t('bar.archiveWhatWake')}</li>
            <li>{t('bar.archiveWhatComms')}</li>
            <li>{t('bar.archiveWhatRetire')}</li>
            <li>{t('bar.archiveWhatFolder')}</li>
            <li>{t('bar.archiveWhatKept')}</li>
          </ul>
        </div>
        {leads && (
          <fieldset className="m-0 grid gap-1.5 rounded-md border border-border p-3" aria-labelledby={scopeId}>
            <legend id={scopeId} className="px-1 text-[11px] font-medium text-muted-foreground">{t('bar.archiveScope')}</legend>
            {(['soul', 'team'] as const).map((option) => (
              <label key={option} className="flex items-start gap-2">
                <input type="radio" name={`${scopeId}-scope`} value={option} checked={scope === option} disabled={archiving}
                  onChange={() => setScope(option)} className="mt-0.5 accent-primary" />
                <span>
                  {option === 'soul' ? t('bar.archiveScopeSoul', { name })
                    : teamCount !== null ? t('bar.archiveScopeTeamCount', { name, count: teamCount }) : t('bar.archiveScopeTeam', { name })}
                </span>
              </label>
            ))}
          </fieldset>
        )}
        {plan && (
          <div className="grid gap-2 rounded-md border border-border p-3">
            <PlanList label={t('bar.archivePlanArchived')} entries={plan.archived} />
            <PlanList label={t('bar.archivePlanIndependent')} entries={plan.independent} />
            <PlanList label={t('bar.archivePlanUnchanged')} entries={plan.unchanged} />
          </div>
        )}
        {current.kind === 'loading' && <p className="m-0 text-[11px] text-muted-foreground">{t('bar.archivePlanLoading')}</p>}
        {!supported && <p className="m-0 text-[11px] text-muted-foreground">{t('bar.archivePlanUnsupported', { name })}</p>}
        {current.kind === 'failed' && <p className="m-0 text-[11px] text-muted-foreground">{t('bar.archivePlanFailed', { reason: current.reason })}</p>}
        <p className="m-0 text-[11px] text-muted-foreground">{t('bar.archiveNoRestore')}</p>
        {lock && <p className="m-0 text-[11px] text-muted-foreground">{lock}</p>}
        {running === 'checking' && <p className="m-0 text-[11px] text-muted-foreground">{t('bar.archiveChecking')}</p>}
        {archiving && <p className="m-0 text-[11px] text-muted-foreground" role="status">{t('bar.archiving')}</p>}
        {error && <p className="m-0 text-[11px] text-destructive" role="alert">{error}</p>}
        <div className="flex justify-end gap-2">
          <button ref={cancel} type="button" onClick={close} disabled={archiving}
            className="h-9 rounded-md px-4 text-sm font-medium hover:bg-accent disabled:opacity-50">{t('cancel')}</button>
          <button type="button" onClick={archive} disabled={blocked || archiving}
            title={lock ?? undefined}
            className="h-9 rounded-md bg-destructive px-4 text-sm font-medium text-destructive-foreground hover:bg-destructive/90 disabled:opacity-50">
            {action}
          </button>
        </div>
      </section>
    </div>
  );
}

/** True when the soul's own plan lists anyone under it: the scope choice is then worth showing. */
function leadsOthers(plan: RemovalPlan): boolean {
  return plan.independent.length > 0 || plan.unchanged.length > 0;
}

function messageOf(e: unknown): string {
  const message = (e as { message?: unknown })?.message;
  return typeof message === 'string' && message ? message : String(e);
}

/**
 * The notice after an archive: every soul the engine archived and every one
 * it made independent (its `effects`, #283), or the single soul and a comms
 * leave still pending, as before.
 */
export function archivedNotice(t: Translate, name: string, result: RemovedSoul): string {
  const effects = result.effects;
  const archived = effects?.archived.map((e) => e.name ?? e.agentId) ?? [];
  const lines: string[] = [];
  if (archived.length > 1) lines.push(t('bar.archivedMany', { names: archived.join(', ') }));
  else lines.push(result.comms === 'left' ? t('bar.archived', { name }) : t('bar.archivedPending', { name, reason: result.comms.replace(/^not left: /, '') }));
  if (effects && effects.independent.length > 0) lines.push(t('bar.archivedIndependent', { names: effects.independent.map((e) => e.displayName).join(', ') }));
  return lines.join(' · ');
}

/** The design's toast after an archive: a short line that fades on its own. */
export function ArchivedNotice({ text, onDone }: { text: string; onDone: () => void }) {
  useEffect(() => {
    const timer = setTimeout(onDone, 4000);
    return () => clearTimeout(timer);
  }, [text, onDone]);
  return (
    <p role="status" className="fixed right-6 bottom-6 z-50 m-0 w-[356px] max-w-[calc(100vw-3rem)] rounded-lg border border-border bg-background p-4 text-[13px] text-foreground shadow-lg">
      {text}
    </p>
  );
}
