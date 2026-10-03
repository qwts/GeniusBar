import { harnessOptions } from '../model/launch';
import { preferenceActions, usePreferences } from '../state/preferences';
import { useI18n } from '../lib/i18n';

/**
 * The menu's default harness: new launches start with it unless the
 * companion already has one. Kept per viewer; none asks every time.
 */
export function DefaultHarness({ harnesses }: { harnesses: readonly string[] }) {
  const { t } = useI18n();
  const { defaultHarness } = usePreferences();
  const options = harnessOptions(harnesses, defaultHarness);
  return (
    <section className="grid gap-1.5 border-t border-border px-3.5 py-2.5 text-xs" aria-label={t('harness.defaultTitle')}>
      <label className="grid gap-1.5">
        <span className="text-sm font-medium">{t('harness.defaultTitle')}</span>
        <select value={defaultHarness ?? ''} onChange={(e) => preferenceActions.setDefaultHarness(e.target.value || null)}>
          <option value="">{t('harness.none')}</option>
          {options.map((h) => <option key={h.id} value={h.id}>{h.label}</option>)}
        </select>
      </label>
      <p className="m-0 text-muted-foreground">{t('harness.defaultHint')}</p>
    </section>
  );
}
