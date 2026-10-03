import { ArrowRightLeft, Check, Circle, Loader2 } from 'lucide-react';
import { useI18n } from '../lib/i18n';
import { describeExisting, SETUP_STEPS, type ExistingServices, type SetupState } from '../model/setup';

const MARK = { pending: Circle, running: Loader2, done: Check } as const;

/** Setup can keep another install's services or move them to GeniusBar. */
export function SetupPanel({ setup, onSetup, existing }: {
  setup: SetupState;
  onSetup: (migrate?: boolean) => void;
  existing?: ExistingServices | null;
}) {
  const { t } = useI18n();
  const found = describeExisting(existing, t);
  return (
    <section className="space-y-3 border-b border-border px-3.5 py-4 text-sm" aria-label={t('setup.label')}>
      <p className="font-medium">{t('setup.intro')}</p>
      <ol className="space-y-2 text-xs" aria-live="polite">
        {SETUP_STEPS.map(({ step }) => {
          const state = setup.steps[step];
          const Mark = MARK[state];
          return (
            <li key={step} className={`flex items-center gap-2 ${state === 'pending' ? 'text-muted-foreground' : 'text-foreground'}`}>
              <Mark className={`size-4 shrink-0 ${state === 'done' ? 'text-success' : state === 'running' ? 'text-primary' : ''} ${state === 'running' ? 'motion-safe:animate-spin' : ''}`} aria-hidden />
              {t(`setup.${step}`)}
            </li>
          );
        })}
      </ol>
      {found && !setup.running && (
        <p className="rounded-md border border-border bg-muted p-3 text-xs leading-relaxed text-muted-foreground" role="note">
          {t('setup.migration', { services: found })}
        </p>
      )}
      {setup.error && <p className="text-xs text-destructive" role="alert">{setup.error}</p>}
      {found ? (
        <div className="flex flex-wrap justify-end gap-2">
          <button type="button" className="inline-flex items-center justify-center gap-1.5 rounded-md border border-border bg-secondary px-2.5 py-1 text-xs text-secondary-foreground hover:bg-accent disabled:opacity-50" onClick={() => onSetup(false)} disabled={setup.running}>{t('setup.keep')}</button>
          <button type="button" className="inline-flex items-center justify-center gap-1.5 rounded-md border border-border bg-secondary px-2.5 py-1 text-xs text-secondary-foreground hover:bg-accent disabled:opacity-50" onClick={() => onSetup(true)} disabled={setup.running}>
            <ArrowRightLeft className="size-3.5" aria-hidden />
            {setup.running ? t('setup.settingUp') : t('setup.move')}
          </button>
        </div>
      ) : (
        <button type="button" className="inline-flex items-center justify-center gap-1.5 rounded-md border border-border bg-secondary px-2.5 py-1 text-xs text-secondary-foreground hover:bg-accent disabled:opacity-50" onClick={() => onSetup()} disabled={setup.running}>
          {setup.running ? t('setup.settingUp') : setup.error ? t('setup.retry') : t('setup.go')}
        </button>
      )}
    </section>
  );
}
