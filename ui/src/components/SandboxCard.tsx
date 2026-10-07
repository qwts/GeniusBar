import { useEffect, useState } from 'react';
import { Check, Circle, Copy, Loader2, Shield } from 'lucide-react';
import { useI18n, type Translate } from '../lib/i18n';
import type { MessageKey } from '../locales/en';
import { useSandbox, type SandboxStatus, type SandboxStep } from './Sandbox';
import { Select } from './Select';

const RUN_TEXT: Record<string, MessageKey> = {
  'owner-admin': 'sandbox.run.admin',
  owner: 'sandbox.run.owner',
  account: 'sandbox.run.account',
};

export function sandboxStatusText(status: SandboxStatus, t: Translate): string {
  const account = status.account;
  if (status.status === 'ready') return t('sandbox.ready', { account });
  if (status.status === 'creating') return t('sandbox.creating', { account });
  if (status.status === 'unsupported') return t('sandbox.unsupported');
  return t('sandbox.missing', { account });
}

/**
 * The menu's Sandboxing card (Lovable `SandboxCard`, screens 03 and 16):
 * title and switch, the description, and while on the provider, the
 * account's status and the owner's steps that are not done yet. Every state
 * is agent-bot's (`sandbox status`); it is read each time the card shows
 * and after every change. Hidden while the bundled agent-bot has no
 * `sandbox`.
 */
export function SandboxCard() {
  const { t } = useI18n();
  const sb = useSandbox();
  const { reload } = sb;
  useEffect(() => { reload(); }, [reload]);
  if (sb.hidden) return null;
  const status = sb.status;
  const readFailure = sb.failure?.scope === 'read' ? sb.failure.message : null;
  if (!status && !readFailure) return null;
  const saving = sb.saving === 'switch';
  const switchFailure = sb.failure?.scope === 'switch' ? sb.failure.message : null;
  const on = status?.enabled === true;
  const steps = status && on && status.status !== 'ready' && status.status !== 'unsupported'
    ? status.steps.filter((step) => step.done !== true) : [];
  return (
    <section className="grid gap-2 border-t border-border p-3 text-xs" aria-label={t('sandbox.title')}>
      <div className="flex items-center gap-2">
        <Shield className={`size-3.5 ${on ? 'text-success' : 'text-muted-foreground'}`} aria-hidden />
        <h3 className="m-0 flex-1 text-sm font-medium">{t('sandbox.title')}</h3>
        {status && (
          <input type="checkbox" role="switch" className="switch-sm" aria-label={t('sandbox.title')} checked={on} disabled={saving}
            onChange={(e) => sb.setEnabled(e.target.checked)} />
        )}
      </div>
      <p className="m-0 text-muted-foreground">{t('sandbox.desc')}</p>
      {saving && <p className="m-0 text-[11px] text-muted-foreground" role="status">{t('sandbox.saving')}</p>}
      {switchFailure && <p className="error m-0 text-[11px]" role="alert">{t('sandbox.failed', { message: switchFailure })}</p>}
      {readFailure && <p className="error m-0 text-[11px]" role="alert">{t('sandbox.readFailed', { message: readFailure })}</p>}
      {status && on && (
        <>
          <Select wrapperClassName="w-full" aria-label={t('sandbox.provider')} value="standard_macos_account" onChange={() => {}}
            className="h-7 pl-3 text-xs">
            <option value="standard_macos_account">{t('sandbox.standard')}</option>
            <option value="__soon" disabled>{t('sandbox.soon')}</option>
          </Select>
          <p role="status" className="m-0 flex items-center gap-1.5 text-muted-foreground">
            {status.status === 'ready' ? <Check className="size-3 text-success" aria-hidden />
              : status.status === 'creating' ? <Loader2 className="size-3 animate-spin text-primary" aria-hidden />
              : <Circle className="size-3" aria-hidden />}
            {sandboxStatusText(status, t)}
          </p>
          {steps.length > 0 && <SandboxSteps steps={steps} account={status.account} />}
        </>
      )}
    </section>
  );
}

/** The owner's undone steps: who runs each, its commands with a copy button, and its note. */
function SandboxSteps({ steps, account }: { steps: readonly SandboxStep[]; account: string }) {
  const { t } = useI18n();
  const [copied, setCopied] = useState<string | null>(null);
  const copy = (command: string) => {
    const clipboard = typeof navigator !== 'undefined' ? navigator.clipboard : undefined;
    if (!clipboard?.writeText) return;
    clipboard.writeText(command).then(() => setCopied(command), () => {});
  };
  return (
    <div className="grid gap-2">
      <p className="m-0 font-medium">{t('sandbox.steps')}</p>
      <p className="m-0 text-muted-foreground">{t('sandbox.stepsHint')}</p>
      <ol className="m-0 grid list-decimal gap-2 pl-4" aria-label={t('sandbox.steps')}>
        {steps.map((step) => (
          <li key={step.id} className="grid gap-1">
            <span className="font-medium text-foreground">{step.title}</span>
            <span className="text-[11px] text-muted-foreground">
              {t(RUN_TEXT[step.run] ?? 'sandbox.run.owner', { account })}
              {step.done === null && <> · {t('sandbox.unchecked')}</>}
            </span>
            {step.commands.map((command) => (
              <span key={command} className="flex items-center gap-1 rounded bg-muted px-1.5 py-1">
                <code className="selectable min-w-0 flex-1 font-mono text-[11px] [overflow-wrap:anywhere]">{command}</code>
                <button type="button" onClick={() => copy(command)} aria-label={t('sandbox.copyLabel', { command })}
                  title={copied === command ? t('sandbox.copied') : t('sandbox.copy')}
                  className="shrink-0 rounded p-0.5 text-muted-foreground hover:text-foreground">
                  {copied === command ? <Check className="size-3 text-success" aria-hidden /> : <Copy className="size-3" aria-hidden />}
                </button>
              </span>
            ))}
            {step.note && <span className="text-[11px] text-muted-foreground">{step.note}</span>}
          </li>
        ))}
      </ol>
    </div>
  );
}
