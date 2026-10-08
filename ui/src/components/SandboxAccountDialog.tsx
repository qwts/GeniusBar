import { useEffect, useId, useRef, useState, type FormEvent } from 'react';
import { createPortal } from 'react-dom';
import { X } from 'lucide-react';
import { useI18n } from '../lib/i18n';
import type { MessageKey } from '../locales/en';
import { focusReturnOf } from './AboutDialog';
import { useSandbox, type SandboxSoul, type SandboxStatus, type SandboxStep } from './Sandbox';
import { errorLine } from './ui';

/**
 * agent-bot's own short-name rule (`sandbox.mjs` ACCOUNT_NAME), mirrored
 * here only as a hint while typing; agent-bot judges the name on Save and
 * its refusal is shown as it is.
 */
export const ACCOUNT_HINT = /^[a-z_][a-z0-9_-]{0,30}$/;

/** Who runs one of agent-bot's steps, by its `run`. */
export const RUN_TEXT: Record<string, MessageKey> = {
  'owner-admin': 'sandbox.run.admin',
  owner: 'sandbox.run.owner',
  account: 'sandbox.run.account',
};

type Phase =
  | { kind: 'editing' }
  | { kind: 'saving' }
  /** agent-bot gave no clear answer: the status is being read again before anything else is shown. */
  | { kind: 'rereading' }
  /** agent-bot confirmed the name, and the status was read again. */
  | { kind: 'set'; account: string }
  /** agent-bot refused, in its own words, and the status was read again. */
  | { kind: 'refused'; message: string }
  /** The re-read after an unclear answer landed; the status says what the account is now. */
  | { kind: 'reread'; requested: string; message: string | null };

/** The steps still owed for the account, from the status; none once it is ready or cannot exist here. */
function owedSteps(status: SandboxStatus | null): SandboxStep[] {
  if (!status || status.status === 'ready' || status.status === 'unsupported') return [];
  return status.steps.filter((step) => step.done !== true);
}

/**
 * The Sandboxing card's "Edit account…" dialog (#66, design handoff of
 * 2026-10-08): which existing standard account sandboxed souls run as, as
 * `agent-bot sandbox account NAME` sets it. The current and the new account
 * are shown apart; a name is checked while typing only as a hint, and on
 * Save agent-bot validates it, asks the owner and answers. Nothing here
 * creates, renames or moves a macOS user or a soul's files, and a pairing
 * stays the owner's own explicit approval on the card.
 *
 * With a soul (from its sandbox chip), the title names it; when the SOP
 * pack decided that soul (`source: sop`) the field is read-only, Save is
 * hidden and the pack's repository, commit and rule are shown. Without one
 * (from the card) it is GeniusBar's default, which every sandboxed soul
 * the pack does not decide shares.
 *
 * After Save the status is read again before anything is claimed: a
 * confirmed name says only "Account set to …", and when that account does
 * not exist yet the owner's steps are listed, each with who runs it. A
 * refusal is shown as agent-bot worded it. An unclear answer says so while
 * the re-read runs, and the re-read's account is what is shown then.
 * A bundle without `sandbox account` keeps Save disabled and says why.
 *
 * The New account field has focus first; Enter saves when the name may be
 * saved, Escape cancels except while saving, and focus returns to what
 * opened the dialog.
 */
export function SandboxAccountDialog({ soul, onClose }: {
  /** The soul whose account this is, from its chip; null for GeniusBar's default, from the card. */
  soul: SandboxSoul | null;
  onClose: () => void;
}) {
  const { t } = useI18n();
  const sb = useSandbox();
  const ids = useId();
  const [draft, setDraft] = useState('');
  const [phase, setPhase] = useState<Phase>({ kind: 'editing' });
  // null until agent-bot answered whether it has `sandbox account`.
  const [supported, setSupported] = useState<boolean | null>(null);
  const input = useRef<HTMLInputElement>(null);
  const closer = useRef<HTMLButtonElement>(null);
  const opener = useRef<HTMLElement | null>(null);
  const alive = useRef(true);
  const { accountSupported } = sb;
  // The live row for the soul, which the re-read refreshes; the prop is the fallback.
  const row = soul ? sb.soul(soul.agentId) ?? soul : null;
  const locked = row?.source === 'sop';
  const status = sb.status;
  const current = row && row.sandboxed ? row.runsAs : status?.account ?? '';
  const name = row ? row.name : t('sandbox.account.everyone');
  useEffect(() => {
    alive.current = true;
    opener.current = focusReturnOf(document.activeElement);
    return () => {
      alive.current = false;
      if (opener.current?.isConnected) opener.current.focus();
    };
  }, []);
  useEffect(() => {
    if (locked) return;
    accountSupported().then((value) => { if (alive.current) setSupported(value); });
  }, [accountSupported, locked]);
  const editable = !locked && supported === true && phase.kind !== 'set';
  useEffect(() => {
    if (editable && (phase.kind === 'editing' || phase.kind === 'refused' || phase.kind === 'reread')) input.current?.focus();
    else if (!editable && supported !== null) closer.current?.focus();
  }, [editable, supported, phase.kind]);
  const busy = phase.kind === 'saving' || phase.kind === 'rereading';
  const proposed = draft.trim();
  const validation = proposed === '' ? null
    : !ACCOUNT_HINT.test(proposed) ? t('sandbox.account.invalid')
    : proposed === current ? t('sandbox.account.same') : null;
  const canSave = editable && !busy && proposed !== '' && validation === null;
  const close = () => { if (!busy) onClose(); };
  const save = async (e: FormEvent) => {
    e.preventDefault();
    if (!canSave) return;
    setPhase({ kind: 'saving' });
    const outcome = await sb.setAccount(proposed);
    if (!alive.current) return;
    if (outcome.kind === 'unknown') setPhase({ kind: 'rereading' });
    // Every outcome is followed by a fresh read; what it says is what is shown.
    await sb.reload();
    if (!alive.current) return;
    if (outcome.kind === 'set') { setPhase({ kind: 'set', account: outcome.account }); setDraft(''); }
    else if (outcome.kind === 'refused') setPhase({ kind: 'refused', message: outcome.message });
    else setPhase({ kind: 'reread', requested: proposed, message: outcome.message });
  };
  // An unclear answer whose re-read shows the requested account: it was set after all.
  const set = phase.kind === 'set' ? phase.account : phase.kind === 'reread' && current === phase.requested ? phase.requested : null;
  const refusal = phase.kind === 'refused' ? phase.message : phase.kind === 'reread' && set === null ? phase.message : null;
  const steps = set !== null ? owedSteps(status) : [];
  const order: [key: 'pack' | 'soul' | 'default', text: string][] = [
    ['pack', t('sandbox.account.orderPack')],
    ['soul', t('sandbox.account.orderSoul')],
    ['default', t('sandbox.account.orderDefault')],
  ];
  const winner = locked ? 'pack' : 'default';
  const describedBy = [validation ? `${ids}-validation ${ids}-note` : null, locked ? `${ids}-locked` : null, supported === false ? `${ids}-gated` : null]
    .filter((id): id is string => id !== null).join(' ');
  const field = 'h-9 w-full rounded-md border border-input bg-background px-3 font-mono text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring read-only:bg-muted read-only:text-muted-foreground disabled:opacity-50';
  const quiet = 'm-0 text-[11px] text-muted-foreground';
  // Portalled to the body, as About: a companion window's transform would
  // contain the fixed overlay; a press in it stays here, not the title bar's drag.
  return createPortal(
    <div className="fixed inset-0 z-50 grid place-items-center bg-black/80 p-4"
      onPointerDown={(e) => e.stopPropagation()}
      onClick={(e) => { if (e.target === e.currentTarget) close(); }}>
      <form role="dialog" aria-modal="true" aria-labelledby={`${ids}-title`} aria-describedby={`${ids}-explainer`}
        onSubmit={(e) => { void save(e); }}
        onKeyDown={(e) => { if (e.key === 'Escape') { e.stopPropagation(); close(); } }}
        className="m-0 grid max-h-full w-full max-w-sm gap-3 overflow-y-auto rounded-lg border border-border bg-background p-5 text-sm shadow-lg outline-none">
        <div className="flex items-start gap-3">
          <h2 id={`${ids}-title`} className="m-0 flex-1 text-base font-semibold tracking-tight">{t('sandbox.account.title', { name })}</h2>
          <button type="button" onClick={close} disabled={busy} aria-label={t('close')}
            className="-mt-1 -mr-1 shrink-0 rounded-sm p-1 text-muted-foreground outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50">
            <X className="size-4" aria-hidden />
          </button>
        </div>
        <p id={`${ids}-explainer`} className="m-0 text-xs text-muted-foreground">{t('sandbox.account.explainer', { name })}</p>
        {/* agent-bot keeps one account (`sandbox account NAME`): a soul the pack does not decide shares GeniusBar's default, so saving here changes it for every such soul. */}
        {row && !locked && <p className="m-0 text-xs text-muted-foreground">{t('sandbox.account.shared', { name })}</p>}
        <p className="m-0 text-xs text-muted-foreground">
          {t('sandbox.account.current')}: <code className="selectable font-mono text-foreground">{current}</code>
        </p>
        <div className="grid gap-1">
          <label htmlFor={`${ids}-new`} className="text-xs font-medium">{t('sandbox.account.new')}</label>
          <input ref={input} id={`${ids}-new`} value={locked ? current : draft} readOnly={locked} disabled={!locked && (supported === false || busy || set !== null)}
            onChange={(e) => { setDraft(e.target.value); if (phase.kind !== 'editing' && phase.kind !== 'saving' && phase.kind !== 'rereading') setPhase({ kind: 'editing' }); }}
            autoComplete="off" autoCapitalize="off" autoCorrect="off" spellCheck={false}
            aria-invalid={validation !== null && proposed !== current ? true : undefined} aria-describedby={describedBy}
            className={field} />
          {!locked && (
            <p id={`${ids}-validation`} aria-live="polite" className={`m-0 text-[11px] ${validation ? 'text-destructive' : 'text-muted-foreground'}`}>
              {validation ?? ''}
              {validation && <span id={`${ids}-note`} className="block text-muted-foreground">{t('sandbox.account.note')}</span>}
            </p>
          )}
        </div>
        <p className={quiet}>
          {t('sandbox.account.order')}{' '}
          {order.map(([key, text], i) => (
            <span key={key}>
              {i > 0 && ' > '}
              {key === winner ? <strong aria-current="true" className="font-medium text-foreground">{text}</strong> : text}
            </span>
          ))}
        </p>
        {locked && (
          <p id={`${ids}-locked`} className="m-0 text-xs text-muted-foreground">
            {t('sandbox.account.locked', { repo: status?.sop?.repository ?? '', commit: (status?.sop?.commit ?? '').slice(0, 7), rule: row?.rule ?? '' })}
          </p>
        )}
        {!locked && supported === false && <p id={`${ids}-gated`} className="m-0 text-xs text-muted-foreground">{t('sandbox.account.gated')}</p>}
        {phase.kind === 'saving' && <p role="status" className={quiet}>{t('sandbox.account.saving')}</p>}
        {phase.kind === 'rereading' && <p role="status" className="m-0 text-xs text-muted-foreground">{t('sandbox.account.unknown')}</p>}
        {set !== null && (
          <div className="grid gap-2">
            <p role="status" className="m-0 text-xs font-medium">{t('sandbox.account.set', { account: set })}</p>
            {status?.status === 'missing' && <p className="m-0 text-xs text-muted-foreground">{t('sandbox.account.missing', { account: set })}</p>}
            {steps.length > 0 && (
              <ol className="m-0 grid list-decimal gap-1 pl-4 text-xs" aria-label={t('sandbox.steps')}>
                {steps.map((step) => (
                  <li key={step.id}>
                    <span className="font-medium">{step.title}</span>
                    <span className="block text-[11px] text-muted-foreground">{t(RUN_TEXT[step.run] ?? 'sandbox.run.owner', { account: set })}</span>
                  </li>
                ))}
              </ol>
            )}
          </div>
        )}
        {refusal && <p role="alert" className={errorLine}>{refusal}</p>}
        <div className="flex justify-end gap-2">
          <button ref={closer} type="button" onClick={close} disabled={busy}
            className="h-9 rounded-md px-4 text-sm font-medium hover:bg-accent disabled:opacity-50">
            {set !== null || locked ? t('close') : t('cancel')}
          </button>
          {!locked && set === null && (
            <button type="submit" disabled={!canSave}
              className="h-9 rounded-md bg-primary px-4 text-sm font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-50">
              {busy ? t('sandbox.account.saving') : t('sandbox.account.save')}
            </button>
          )}
        </div>
      </form>
    </div>,
    document.body,
  );
}
