import { useCallback } from 'react';
import { ShieldCheck, Zap } from 'lucide-react';
import { useI18n } from '../lib/i18n';
import type { CensusRow } from '../model/census';
import { useFleetMode } from './SoulNotices';

/**
 * The design's footer mode pill (Lovable `GeniusBarItem`): Safe Mode with a
 * shield, Auto-Pilot with a bolt in the warning colour, and the switch. Here
 * it stands for every companion at once (#122): "Mixed" with an
 * indeterminate switch while they differ. Absent while agent-bot cannot say
 * for any of them.
 */
export function FleetMode({ roster }: { roster: readonly CensusRow[] }) {
  const { t } = useI18n();
  const { mode, saving, error, change } = useFleetMode(roster);
  // A callback ref sets the DOM-only indeterminate flag at commit, with the
  // render it belongs to; an effect ran after paint and CI saw the gap.
  const input = useCallback((el: HTMLInputElement | null) => { if (el) el.indeterminate = mode === 'mixed'; }, [mode]);
  if (!mode) return null;
  const auto = mode === 'autopilot';
  const mixed = mode === 'mixed';
  const label = mixed ? t('mode.mixed') : auto ? t('mode.autopilot') : t('mode.safe');
  return (
    <span className="flex min-w-0 items-center gap-1.5">
      <label title={t('mode.fleetHint')}
        className={`inline-flex shrink-0 items-center gap-1.5 rounded-full border px-2 py-0.5 font-sans text-xs ${auto ? 'border-warning text-warning' : 'border-border'}`}>
        {auto || mixed ? <Zap className={`size-3 ${mixed ? 'text-warning' : ''}`} aria-hidden /> : <ShieldCheck className="size-3 text-success" aria-hidden />}
        <span>{label}</span>
        <input ref={input} type="checkbox" role="switch" className="switch-sm switch-warning" checked={auto} disabled={saving}
          aria-label={t('mode.fleetToggle')} aria-checked={mixed ? 'mixed' : auto}
          onChange={(e) => { void change(e.target.checked ? 'autopilot' : 'safe'); }} />
      </label>
      {error && <span className="min-w-0 truncate text-[11px] text-destructive" role="alert">{t('mode.failed', { message: error })}</span>}
    </span>
  );
}
