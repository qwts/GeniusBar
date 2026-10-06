import { useEffect, useState } from 'react';
import { displayName, type CensusRow } from '../model/census';
import { canLaunch, harnessOptions, MAX_HARNESS, preferredHarness, suggestedName, type LaunchState } from '../model/launch';
import { useI18n } from '../lib/i18n';
import type { LaunchApi } from '../useLaunch';

interface LaunchFormProps {
  launcher: LaunchApi;
  /** Accounts and harnesses seen in the census, offered as suggestions. */
  accounts: readonly string[];
  harnesses: readonly string[];
  /** Pre-filled path when opened from Finder. */
  initialPackagePath?: string;
  /** What the opened package's soul.json says (#120); prefilled until edited. */
  packageName?: string;
  preferredHarnesses?: readonly string[];
  /** File-open validation is performed by the shell using the Starter reader. */
  checkingPackage?: boolean;
  packageError?: string | null;
  /** Launch this existing soul; without it, the form launches a package. */
  soul?: CensusRow;
  /** The viewer's default harness, used when the soul has none. */
  defaultHarness?: string | null;
  /**
   * The soul's current agent comms setting (#71). New packages default to on.
   * For an existing soul, undefined means not known yet: the switch is hidden
   * and the launch leaves the soul's own setting.
   */
  initialComms?: boolean;
  /** Shown as Cancel beside Launch, when the form sits in a dialog. */
  onCancel?: () => void;
}

export function LaunchStatus({ state }: { state: LaunchState }) {
  switch (state.phase) {
    case 'idle':
      return null;
    case 'requesting':
      return <p className="muted small" role="status">Requesting launch…</p>;
    case 'pending':
      return (
        <p className="muted small" role="status">
          Waiting for the daemon to report <span className="selectable">({state.requestId})</span>.
          {state.note && <span className="block">{state.note}</span>}
        </p>
      );
    case 'launched':
      return (
        <p className="small" role="status">
          Launched{state.agentId && <> as <span className="selectable">{state.agentId}</span></>}.
        </p>
      );
    case 'failed':
      return (
        <p className="error small" role="alert">
          Launch failed: {state.detail ?? 'the daemon reported no details.'}
        </p>
      );
    case 'error':
      return <p className="error small" role="alert">{state.text}</p>;
  }
}

const OTHER = '__other';
const legend = 'mb-2 font-mono text-[11px] font-semibold uppercase tracking-wide text-muted-foreground';
const field = 'h-9 w-full rounded-md border border-input bg-transparent px-3 text-sm text-foreground';

/**
 * Launch form for an existing soul or a soul package, drawn as Lovable's
 * launch dialog (20.03.51) in four steps: the soul, the harness that runs
 * it, the account it runs as, and its agent comms. Harness and account are
 * picked from what GeniusBar knows, and "Other…" still takes any value.
 * One launch at a time; the result stays on screen and is never retried.
 */
export function LaunchForm({ launcher, accounts, harnesses, soul, defaultHarness = null, initialPackagePath = '', packageName, preferredHarnesses,
  checkingPackage = false, packageError: initialPackageError = null, initialComms, onCancel }: LaunchFormProps) {
  const { t } = useI18n();
  const [account, setAccount] = useState(soul?.account ?? (accounts.length === 1 ? accounts[0] : ''));
  const [otherAccount, setOtherAccount] = useState(!soul && accounts.length === 0);
  const [packagePath, setPackagePath] = useState(initialPackagePath);
  const [packageError, setPackageError] = useState(initialPackageError);
  const packageHarness = soul ? null : preferredHarness(preferredHarnesses, harnesses);
  const [harness, setHarness] = useState(soul?.harness ?? defaultHarness ?? packageHarness ?? '');
  const [otherHarness, setOtherHarness] = useState(false);
  const [name, setName] = useState(soul ? '' : suggestedName(packageName));
  // The package's manifest arrives after the form opened (agent-bot's locate
  // runs behind the Finder open): it prefills what the owner has not typed yet.
  const [touched, setTouched] = useState<{ name?: boolean; harness?: boolean }>({});
  useEffect(() => {
    if (!soul && !touched.name) setName(suggestedName(packageName));
  }, [packageName]);
  useEffect(() => {
    if (!soul && !touched.harness && !defaultHarness && packageHarness) setHarness(packageHarness);
  }, [packageHarness]);
  // Follows the soul's setting as it arrives, until the owner changes it here.
  const [chosenComms, setComms] = useState<boolean | undefined>(undefined);
  const comms = chosenComms ?? initialComms ?? (soul ? undefined : true);
  // The launcher is shared: show its result only in the form that started it.
  const [started, setStarted] = useState(false);
  const ready = canLaunch(launcher.state);
  const what = soul ? displayName(soul) : t('launch.aPackage');
  const options = harnessOptions(harnesses, soul?.harness, defaultHarness);

  useEffect(() => setPackageError(initialPackageError), [initialPackageError]);

  return (
    <form
      className="launch"
      aria-label={t('launch.formLabel', { what })}
      onSubmit={(e) => {
        e.preventDefault();
        if (!ready || checkingPackage || packageError) return;
        setStarted(true);
        void launcher.launch({
          account,
          target: soul ? { soul: soul.agentId } : { package: packagePath },
          harness,
          name,
          ...(comms === undefined ? {} : { comms }),
        });
      }}
    >
      <fieldset>
        <legend className={legend}>{t('launch.step.what')}</legend>
        {/* TODO(#65): offer SOP-provided soul templates (the design's presets) once agent-bot lists them. */}
        {soul ? (
          <p className="text-sm font-medium">{displayName(soul)}</p>
        ) : (
          <input value={packagePath} aria-label={t('launch.package')} placeholder={t('launch.packagePlaceholder')} className={field}
            onChange={(e) => {
              setPackagePath(e.target.value);
              setPackageError(null);
            }} />
        )}
        <label className="grid gap-1">
          <span className="text-sm font-medium">{t('launch.name')}</span>
          {/* Not a person's name: keep the web view from offering contact AutoFill (#80). */}
          <input value={name} placeholder={t('launch.nameOptional')} autoComplete="off" className={field}
            onChange={(e) => { setTouched((was) => ({ ...was, name: true })); setName(e.target.value); }} />
        </label>
      </fieldset>
      <fieldset>
        <legend className={legend}>{t('launch.step.harness')}</legend>
        {/* Free text, as before: "Other…" launches any harness string; the list only suggests. */}
        <select aria-label={t('field.harness')} value={otherHarness ? OTHER : harness} className={field}
          onChange={(e) => {
            const other = e.target.value === OTHER;
            setOtherHarness(other);
            setTouched((was) => ({ ...was, harness: true }));
            setHarness(other ? '' : e.target.value);
          }}>
          {!harness && !otherHarness && <option value="" disabled>{t('launch.harnessPick')}</option>}
          {options.map((h) => <option key={h.id} value={h.id}>{h.label}{h.id === defaultHarness ? ` · ${t('launch.harnessDefault')}` : ''}</option>)}
          <option value={OTHER}>{t('harness.other')}</option>
        </select>
        {otherHarness && (
          <input type="text" aria-label={t('harness.otherLabel')} placeholder={t('harness.otherPlaceholder')} value={harness}
            maxLength={MAX_HARNESS} className={`${field} font-mono text-xs`}
            onChange={(e) => { setTouched((was) => ({ ...was, harness: true })); setHarness(e.target.value); }} />
        )}
        <p className="text-xs text-muted-foreground">{t('launch.harnessHint')}</p>
      </fieldset>
      <fieldset>
        <legend className={legend}>{t('launch.step.account')}</legend>
        {soul ? (
          <input value={account} readOnly aria-label={t('field.account')} className={`${field} font-mono text-xs`} />
        ) : (
          <>
            {accounts.length > 0 && (
              <select aria-label={t('field.account')} value={otherAccount ? OTHER : account} className={`${field} font-mono text-xs`}
                onChange={(e) => {
                  const other = e.target.value === OTHER;
                  setOtherAccount(other);
                  setAccount(other ? '' : e.target.value);
                }}>
                {!account && !otherAccount && <option value="" disabled>{t('launch.accountPick')}</option>}
                {accounts.map((a) => <option key={a} value={a}>{a}</option>)}
                <option value={OTHER}>{t('launch.accountOther')}</option>
              </select>
            )}
            {otherAccount && (
              <input type="text" value={account} aria-label={accounts.length > 0 ? t('launch.accountOtherLabel') : t('field.account')}
                placeholder={t('launch.accountPlaceholder')} autoComplete="off" className={`${field} font-mono text-xs`}
                onChange={(e) => setAccount(e.target.value)} />
            )}
          </>
        )}
        {/* TODO(#66): sandboxing through persona accounts; until then this states who it runs as. */}
        <p className="font-mono text-xs text-muted-foreground">{account.trim() ? t('launch.runsAs', { account: account.trim() }) : t('launch.runsAsNone')}</p>
      </fieldset>
      {comms !== undefined && (
        <fieldset>
          <legend className={legend}>{t('launch.step.comms')}</legend>
          <label className="flex items-center gap-2 text-sm">
            <input type="checkbox" role="switch" aria-label={t('launch.comms')} checked={comms} onChange={(e) => setComms(e.target.checked)} />
            {comms ? t('comms.managed') : t('comms.unmanaged')}
          </label>
          <p className="text-xs text-muted-foreground">{t('launch.commsHint')}</p>
        </fieldset>
      )}
      {checkingPackage && <p className="muted small" role="status">{t('launch.checking')}</p>}
      {packageError && <p className="error small" role="alert">{packageError}</p>}
      {started ? <LaunchStatus state={launcher.state} />
        : !ready && <p className="muted small">{t('launch.busy')}</p>}
      <div className="flex items-center justify-end gap-2 pt-1">
        {onCancel && (
          <button type="button" onClick={onCancel} className="h-9 rounded-md px-4 text-sm font-medium hover:bg-accent">{t('cancel')}</button>
        )}
        <button type="submit" disabled={!ready || checkingPackage || Boolean(packageError)}
          className="h-9 rounded-md bg-primary px-4 text-sm font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-50">
          {t('launch.go')}
        </button>
      </div>
    </form>
  );
}
