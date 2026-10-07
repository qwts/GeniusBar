import { useEffect, useRef, useState } from 'react';
import { Shield, ShieldOff } from 'lucide-react';
import { useI18n, type Translate } from '../lib/i18n';
import { displayName, type CensusRow } from '../model/census';
import { useSandbox, type SandboxOverride, type SandboxSoul } from './Sandbox';

/** "Runs as …": the sandbox account with its kind, or the owner's own account. */
export function runsAsText(row: SandboxSoul, t: Translate): string {
  return t('sandbox.runsAs', { user: row.sandboxed ? `${row.runsAs} (${t('sandbox.standard')})` : t('sandbox.you', { user: row.runsAs }) });
}

/**
 * The companion window's sandbox pill (Lovable `SandboxChip`, screens 07 and
 * 10): Sandboxed or Unrestricted as agent-bot resolves the soul, and a menu
 * with "Runs as …" and the three overrides. A change goes to agent-bot
 * (`sandbox override`), which asks the owner, then the status is read
 * again. Absent while agent-bot has no `sandbox` or no row for the soul.
 */
export function SandboxChip({ soul }: { soul: CensusRow }) {
  const { t } = useI18n();
  const sb = useSandbox();
  const { reload } = sb;
  const [open, setOpen] = useState(false);
  const box = useRef<HTMLDivElement>(null);
  const button = useRef<HTMLButtonElement>(null);
  useEffect(() => { reload(); }, [reload, soul.agentId]);
  useEffect(() => {
    if (!open) return;
    const away = (e: PointerEvent) => { if (!box.current?.contains(e.target as Node)) setOpen(false); };
    document.addEventListener('pointerdown', away);
    return () => document.removeEventListener('pointerdown', away);
  }, [open]);
  const failure = sb.failure?.scope === soul.agentId ? sb.failure.message : null;
  // A refusal reopens the menu to say why the override stayed.
  useEffect(() => { if (failure) setOpen(true); }, [failure]);
  const row = sb.soul(soul.agentId);
  if (!row || !sb.status) return null;
  const on = row.sandboxed;
  const saving = sb.saving === soul.agentId;
  const global = sb.status.enabled ? t('sandbox.on') : t('sandbox.off');
  const choices: [SandboxOverride, string][] = [
    ['inherit', t('sandbox.inherit', { value: global })],
    ['sandboxed', t('sandbox.always')],
    ['unrestricted', t('sandbox.never')],
  ];
  const choose = (value: SandboxOverride) => {
    setOpen(false);
    button.current?.focus();
    if (value !== row.override) sb.setOverride(soul.agentId, value);
  };
  return (
    <div ref={box} className="relative shrink-0"
      onPointerDown={(e) => e.stopPropagation()}
      onKeyDown={(e) => { if (e.key === 'Escape' && open) { e.stopPropagation(); setOpen(false); button.current?.focus(); } }}>
      <button ref={button} type="button" aria-haspopup="menu" aria-expanded={open} disabled={saving}
        aria-label={t('sandbox.label', { name: displayName(soul), state: on ? t('sandbox.on') : t('sandbox.off') })}
        title={runsAsText(row, t)}
        onClick={() => setOpen(!open)}
        className={`flex items-center gap-1 rounded-full border px-2 py-0.5 text-[11px] outline-none focus-visible:ring-2 focus-visible:ring-ring ${on ? 'border-success/50 text-success' : 'border-border text-muted-foreground'}`}>
        {on ? <Shield className="size-3" aria-hidden /> : <ShieldOff className="size-3" aria-hidden />}
        {on ? t('sandbox.on') : t('sandbox.off')}
      </button>
      {open && (
        <div role="menu" aria-label={t('sandbox.title')}
          className="absolute top-full right-0 z-50 mt-1 w-64 rounded-md border border-border bg-popover p-1 shadow-md">
          <p className="m-0 px-2 py-1.5 text-xs text-muted-foreground">{runsAsText(row, t)}</p>
          {failure && <p role="alert" className="m-0 px-2 pb-1.5 text-[11px] text-destructive">{t('sandbox.failed', { message: failure })}</p>}
          <div role="separator" className="-mx-1 my-1 h-px bg-muted" />
          {choices.map(([value, label]) => (
            <button key={value} type="button" role="menuitemradio" aria-checked={row.override === value}
              onClick={() => choose(value)}
              className="relative flex w-full items-center rounded-sm py-1.5 pr-2 pl-8 text-left text-sm hover:bg-accent focus-visible:bg-accent focus-visible:outline-none">
              {/* As Radix DropdownMenuRadioItem: the dot centred in a 3.5 box. */}
              <span className="absolute left-2 flex size-3.5 items-center justify-center" aria-hidden>
                {row.override === value && <span className="size-2 rounded-full bg-current" />}
              </span>
              {label}
            </button>
          ))}
        </div>
      )}
      {saving && <span className="sr-only" role="status">{t('sandbox.saving')}</span>}
    </div>
  );
}
