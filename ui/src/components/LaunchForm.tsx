import { useEffect, useId, useState } from 'react';
import { displayName, type CensusRow } from '../model/census';
import { canLaunch, harnessOptions, type LaunchState } from '../model/launch';
import { useI18n } from '../lib/i18n';
import type { LaunchApi } from '../useLaunch';

interface LaunchFormProps {
  launcher: LaunchApi;
  /** Accounts and harnesses seen in the census, offered as suggestions. */
  accounts: readonly string[];
  harnesses: readonly string[];
  /** Pre-filled path when opened from Finder. */
  initialPackagePath?: string;
  /** File-open validation is performed by the shell using the Starter reader. */
  checkingPackage?: boolean;
  packageError?: string | null;
  /** Launch this existing soul; without it, the form launches a package. */
  soul?: CensusRow;
  /** The viewer's default harness, used when the soul has none. */
  defaultHarness?: string | null;
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

/**
 * Launch form for an existing soul or a soul package, in three steps:
 * what to launch, the harness that runs it, and the account it runs as.
 * One launch at a time; the result stays on screen and is never retried.
 */
export function LaunchForm({ launcher, accounts, harnesses, soul, defaultHarness = null, initialPackagePath = '',
  checkingPackage = false, packageError: initialPackageError = null }: LaunchFormProps) {
  const { t } = useI18n();
  const [account, setAccount] = useState(soul?.account ?? (accounts.length === 1 ? accounts[0] : ''));
  const [packagePath, setPackagePath] = useState(initialPackagePath);
  const [packageError, setPackageError] = useState(initialPackageError);
  const [harness, setHarness] = useState(soul?.harness ?? defaultHarness ?? '');
  const [name, setName] = useState('');
  // The launcher is shared: show its result only in the form that started it.
  const [started, setStarted] = useState(false);
  const ids = useId();
  const ready = canLaunch(launcher.state);
  const what = soul ? displayName(soul) : t('launch.aPackage');
  const options = harnessOptions(harnesses, soul?.harness);

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
        });
      }}
    >
      <datalist id={`${ids}-accounts`}>{accounts.map((a) => <option key={a} value={a} />)}</datalist>
      {/* Free text, as before: any harness string can be launched; the list only suggests. */}
      <datalist id={`${ids}-harnesses`}>{options.map((h) => <option key={h.id} value={h.id}>{h.label}</option>)}</datalist>
      <h3 className="launch-step">{t('launch.step.what')}</h3>
      {/* TODO(#65): offer SOP-provided soul templates here once agent-bot lists them. */}
      {soul ? (
        <p className="text-sm">{displayName(soul)}</p>
      ) : (
        <label>
          <span>{t('launch.package')}</span>
          <input value={packagePath} placeholder={t('launch.packagePlaceholder')} onChange={(e) => {
            setPackagePath(e.target.value);
            setPackageError(null);
          }} />
        </label>
      )}
      <label>
        <span>{t('launch.name')}</span>
        <input value={name} placeholder={t('launch.nameOptional')} onChange={(e) => setName(e.target.value)} />
      </label>
      <h3 className="launch-step">{t('launch.step.harness')}</h3>
      <label>
        <span>{t('field.harness')}</span>
        <input value={harness} list={`${ids}-harnesses`} placeholder={t('launch.harnessPick')}
          onChange={(e) => setHarness(e.target.value)} />
      </label>
      <p className="muted small">{t('launch.harnessHint')}</p>
      <h3 className="launch-step">{t('launch.step.account')}</h3>
      <label>
        <span>{t('field.account')}</span>
        <input value={account} readOnly={Boolean(soul)} list={`${ids}-accounts`} onChange={(e) => setAccount(e.target.value)} />
      </label>
      {/* TODO(#66): sandboxing through persona accounts; until then this states who it runs as. */}
      <p className="muted small">{account.trim() ? t('launch.runsAs', { account: account.trim() }) : t('launch.runsAsNone')}</p>
      {checkingPackage && <p className="muted small" role="status">{t('launch.checking')}</p>}
      {packageError && <p className="error small" role="alert">{packageError}</p>}
      {started ? <LaunchStatus state={launcher.state} />
        : !ready && <p className="muted small">{t('launch.busy')}</p>}
      <div className="detail-actions">
        <button type="submit" disabled={!ready || checkingPackage || Boolean(packageError)}>{t('launch.go')}</button>
      </div>
    </form>
  );
}
