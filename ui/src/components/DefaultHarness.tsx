import { useState } from 'react';
import { harnessOptions, MAX_HARNESS } from '../model/launch';
import { preferenceActions, usePreferences } from '../state/preferences';
import { useI18n } from '../lib/i18n';

/**
 * The menu's default harness: new launches start with it unless the
 * companion already has one. Kept per viewer; none asks every time.
 * "Other…" takes any harness command, as the design's select does; it
 * becomes the default on blur or Enter, so a half-typed command never does.
 */
export function DefaultHarness({ harnesses }: { harnesses: readonly string[] }) {
  const { t } = useI18n();
  const { defaultHarness } = usePreferences();
  const [other, setOther] = useState(false);
  const [text, setText] = useState('');
  const options = harnessOptions(harnesses, defaultHarness);
  const commit = () => preferenceActions.setDefaultHarness(text.trim() || null);
  return (
    <section className="grid gap-1.5 border-t border-border p-3 text-xs" aria-label={t('harness.defaultTitle')}>
      <label className="grid gap-1.5">
        <span className="text-sm font-medium">{t('harness.defaultTitle')}</span>
        <select value={other ? '__other' : defaultHarness ?? ''}
          onChange={(e) => {
            if (e.target.value === '__other') { setOther(true); setText(''); return; }
            setOther(false);
            preferenceActions.setDefaultHarness(e.target.value || null);
          }}
          className="h-7 w-full rounded-md border border-input bg-transparent px-2 text-xs text-foreground">
          <option value="">{t('harness.none')}</option>
          {options.map((h) => <option key={h.id} value={h.id}>{h.label}</option>)}
          <option value="__other">{t('harness.other')}</option>
        </select>
      </label>
      {other && (
        <input type="text" aria-label={t('harness.otherLabel')} placeholder={t('harness.otherPlaceholder')} value={text} maxLength={MAX_HARNESS}
          className="h-7 font-mono text-xs"
          onChange={(e) => setText(e.target.value)} onBlur={commit}
          onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); commit(); } }} />
      )}
      <p className="m-0 text-muted-foreground">{t('harness.defaultHint')}</p>
    </section>
  );
}
