import { useEffect, useRef, useState } from 'react';
import { Check, Circle, Loader2 } from 'lucide-react';
import { displayName, type CensusRow } from '../model/census';
import { savedBrief } from '../bridge';
import { canLaunch, harnessOptions, MAX_BRIEF, MAX_HARNESS, normalPackagePath, preferredHarness, prefillHarness, suggestedName, type LaunchStage, type LaunchState } from '../model/launch';
import { useI18n } from '../lib/i18n';
import { radioGroupKeys } from '../lib/radioGroup';
import { chosenTemplate, CUSTOM_SOUL, initialChoice } from '../model/templates';
import type { LaunchApi } from '../useLaunch';
import { useSoulTemplates, type TemplateLister } from '../useSoulTemplates';
import { ModelField } from './ModelField';
import { Select } from './Select';

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
  /** The package's soul.json description (#120), shown read-only under the name. */
  packageDescription?: string;
  /**
   * The opened folder is a copy of this companion's folder (#110): the
   * launch must be named, and agent-bot's daemon forks it into a new soul.
   */
  copyOf?: { name: string | null; agentId: string };
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
  /**
   * Called once when this form's launch reports `launched` (#116), with the
   * new soul's agent id when the daemon gave one; the dialog closes on it.
   */
  onLaunched?: (agentId: string | null) => void;
  /**
   * The census, whose souls' harness model lists (#128) the Model field
   * offers; without it the field offers the default and "Other…" only.
   */
  roster?: readonly CensusRow[];
  /**
   * Lists agent-bot's soul templates (#65), offered as the design's soul
   * choices beside "Custom soul" when the form launches a package. Without
   * it, or on an agent-bot without `soul templates`, the form has the
   * package path field alone.
   */
  listTemplates?: TemplateLister;
  /**
   * Reads the brief an existing soul's last launch saved (#120), prefilled
   * on relaunch; null when it has none. Defaults to agent-bot's census.
   */
  loadBrief?: (agentId: string) => Promise<string | null>;
}

export function LaunchStatus({ state }: { state: LaunchState }) {
  const { t } = useI18n();
  switch (state.phase) {
    case 'idle':
      return null;
    case 'requesting':
      return <p className="muted small" role="status">{t('launch.requesting')}</p>;
    case 'pending':
      return (
        <p className="muted small" role="status">
          {t('launch.pending')} <span className="selectable">({state.requestId})</span>.
          {state.note && <span className="block">{state.note}</span>}
        </p>
      );
    case 'launched':
      return (
        <p className="small" role="status">
          {state.agentId ? <span className="selectable">{t('launch.launchedAs', { agentId: state.agentId })}</span> : t('launch.launched')}
        </p>
      );
    case 'failed':
      return (
        <p className="error small" role="alert">
          {t('launch.failed', { detail: state.detail ?? t('launch.failedNoDetail') })}
        </p>
      );
    case 'error':
      return <p className="error small" role="alert">{state.text}</p>;
  }
}

const PROGRESS = ['launch.progress.request', 'launch.progress.daemon', 'launch.progress.joined'] as const;

/** The daemon's stages that mean it is past starting and joining the companion. */
const JOINING_STAGES: readonly LaunchStage[] = ['joining', 'harness', 'session'];

/**
 * The design's launch progress (Lovable launch dialog while busy): the
 * request, the daemon starting it, and the companion joining, each done,
 * running or waiting. The daemon's reported stage (agent-bot-identity
 * #536) moves the list: `checking` and `account` are the daemon starting
 * it, `joining` onwards is the companion joining; with no report the list
 * waits on the daemon until it answers.
 */
export function LaunchProgress({ state }: { state: LaunchState }) {
  const { t } = useI18n();
  const step = state.phase === 'requesting' ? 0
    : state.phase === 'pending' ? (state.stage && JOINING_STAGES.includes(state.stage) ? 2 : 1)
    : 3;
  return (
    <div className="grid gap-2">
      <ol className="m-0 grid list-none gap-2 p-0 text-sm" aria-live="polite" aria-label={t('launch.progress')}>
        {PROGRESS.map((key, i) => (
          <li key={key} className={`flex items-center gap-2 ${i <= step ? 'text-foreground' : 'text-muted-foreground'}`}>
            {i < step ? <Check className="size-4 shrink-0 text-success" aria-hidden />
              : i === step ? <Loader2 className="size-4 shrink-0 animate-spin text-primary" aria-hidden />
              : <Circle className="size-4 shrink-0" aria-hidden />}
            {t(key)}
            <span className="sr-only">{i < step ? t('launch.progress.done') : i === step ? t('launch.progress.running') : ''}</span>
          </li>
        ))}
      </ol>
      {state.phase === 'pending' && (
        <p className="m-0 font-mono text-[11px] text-muted-foreground">
          <span className="selectable">{state.requestId}</span>
          {state.stage && <span> · {state.stage}</span>}
          {state.note && <span className="block font-sans">{state.note}</span>}
        </p>
      )}
    </div>
  );
}

const OTHER = '__other';

const radio = 'inline-flex min-h-9 items-center justify-center gap-1 rounded-md border px-2 py-1.5 text-xs outline-none focus-visible:ring-2 focus-visible:ring-ring';
const radioOn = 'border-primary bg-primary/10 text-foreground';
const radioOff = 'border-border text-muted-foreground hover:bg-accent';
const legend = 'mb-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground';
const field = 'h-9 w-full rounded-md border border-input bg-transparent px-3 text-sm text-foreground';

/**
 * Launch form for an existing soul or a soul package, drawn as Lovable's
 * launch dialog (20.03.51) in four steps: the soul (and its brief, #120,
 * not yet in the design), the harness that runs it (and its model, #128,
 * not yet in the design), the account it runs as, and its agent comms. Harness, model and account are picked from what
 * GeniusBar knows, and "Other…" still takes any value.
 * One launch at a time; the result stays on screen and is never retried.
 */
export function LaunchForm({ launcher, accounts, harnesses, soul, defaultHarness = null, initialPackagePath = '', packageName, preferredHarnesses,
  packageDescription, copyOf: openedCopyOf, checkingPackage: checkingOpened = false, packageError: initialPackageError = null, initialComms, onCancel, onLaunched,
  roster = [], listTemplates, loadBrief }: LaunchFormProps) {
  const { t } = useI18n();
  // The design's soul choices (#65): agent-bot's templates, then "Custom
  // soul", which is the package path field. Asked once; never waited on.
  const { templates, supported: templatesListed, error: templateError } = useSoulTemplates(soul ? undefined : listTemplates);
  const picker = !soul && templatesListed && templates.length > 0;
  const [choice, setChoice] = useState<string | null>(null);
  const [account, setAccount] = useState(soul?.account ?? (accounts.length === 1 ? accounts[0] : ''));
  const [otherAccount, setOtherAccount] = useState(!soul && accounts.length === 0);
  const [packagePath, setPackagePath] = useState(() => normalPackagePath(initialPackagePath));
  const [packageError, setPackageError] = useState(initialPackageError);
  const selected = picker ? choice ?? initialChoice(templates, packagePath, Boolean(initialPackagePath || openedCopyOf)) : CUSTOM_SOUL;
  const template = chosenTemplate(templates, selected);
  const custom = template === null;
  // What the opened package says applies to "Custom soul" only; a template is its own package.
  const copyOf = custom ? openedCopyOf : undefined;
  const checkingPackage = custom && checkingOpened;
  const packageHarness = soul ? null : preferredHarness(preferredHarnesses, harnesses);
  // The package's own preference wins over the viewer's default (#120).
  const [harness, setHarness] = useState(prefillHarness(soul?.harness, packageHarness, defaultHarness));
  const [otherHarness, setOtherHarness] = useState(false);
  // The model (#128): null is the harness default; a new harness starts over.
  const [model, setModel] = useState<string | null>(null);
  useEffect(() => setModel(null), [harness]);
  // An existing soul keeps its name (#79): the form has no Name for it.
  // A copied folder starts blank, since it becomes a new companion (#110).
  const [name, setName] = useState(soul || copyOf ? '' : suggestedName(packageName));
  // The package's manifest arrives after the form opened (agent-bot's locate
  // runs behind the Finder open): it prefills what the owner has not typed yet.
  // The brief (#120): what this companion is here to do. A relaunch reads
  // the brief agent-bot saved and prefills it; while that loads the field
  // waits, and when it fails the field stays blank. Blank or unchanged sends
  // none, which keeps the brief agent-bot already has. The launch never
  // waits on it, and what the owner typed wins over a late answer.
  const [brief, setBrief] = useState('');
  const [saved, setSaved] = useState<string | null>(null);
  const [briefLoading, setBriefLoading] = useState(Boolean(soul));
  const briefTyped = useRef(false);
  const relaunched = soul?.agentId;
  useEffect(() => {
    if (!relaunched) return;
    let live = true;
    setBriefLoading(true);
    // Asked inside the promise, so a reader that throws leaves the field blank too.
    Promise.resolve().then(() => (loadBrief ?? savedBrief)(relaunched)).then((text) => {
      if (!live || !text) return;
      setSaved(text);
      if (!briefTyped.current) setBrief(text);
    }, () => {}).finally(() => { if (live) setBriefLoading(false); });
    return () => { live = false; };
  }, [relaunched]);
  const briefLength = brief.trim().length;
  const briefTooLong = briefLength > MAX_BRIEF;
  const [touched, setTouched] = useState<{ name?: boolean; harness?: boolean }>({});
  useEffect(() => {
    if (!soul && !copyOf && !touched.name) setName(suggestedName(packageName));
  }, [packageName]);
  useEffect(() => {
    if (!soul && !touched.harness && packageHarness && custom) setHarness(packageHarness);
  }, [packageHarness]);
  // A template's default harness is prefilled like a package's (#65), until the owner picks one.
  const templateHarness = template?.defaultHarness ?? null;
  useEffect(() => {
    if (!picker || touched.harness) return;
    setHarness(prefillHarness(templateHarness, custom ? packageHarness : null, defaultHarness));
  }, [selected, picker]);
  // Follows the soul's setting as it arrives, until the owner changes it here.
  const [chosenComms, setComms] = useState<boolean | undefined>(undefined);
  const comms = chosenComms ?? initialComms ?? (soul ? undefined : true);
  // The launcher is shared: show its result only in the form that started it.
  const [started, setStarted] = useState(false);
  // A dialog's launch that succeeded is finished (#116): Launch never arms
  // again in the same dialog, so a second click cannot start a duplicate.
  const launched = started && launcher.state.phase === 'launched';
  const ready = canLaunch(launcher.state) && !(launched && onCancel);
  const reported = useRef(false);
  const launchedAgent = launcher.state.phase === 'launched' ? launcher.state.agentId : null;
  useEffect(() => {
    if (!launched || reported.current || !onLaunched) return;
    reported.current = true;
    onLaunched(launchedAgent);
  }, [launched, launchedAgent, onLaunched]);
  const what = soul ? displayName(soul) : t('launch.aPackage');
  // A copy launches only under a new name; the daemon refuses it unnamed.
  const needsName = Boolean(copyOf && !soul) && name.trim() === '';
  const options = harnessOptions(harnesses, soul?.harness, templateHarness, defaultHarness);
  const pathError = custom ? packageError : null;

  useEffect(() => setPackageError(initialPackageError), [initialPackageError]);
  // While this form's launch runs, the design shows only its progress.
  const busy = started && !canLaunch(launcher.state);

  return (
    <form
      className="launch"
      aria-label={t('launch.formLabel', { what })}
      onSubmit={(e) => {
        e.preventDefault();
        if (!ready || checkingPackage || pathError || needsName || briefTooLong) return;
        setStarted(true);
        const path = normalPackagePath(packagePath);
        if (!soul && custom) setPackagePath(path);
        void launcher.launch({
          account,
          target: soul ? { soul: soul.agentId } : { package: template ? template.package : path },
          harness,
          name: soul ? '' : name,
          ...(comms === undefined ? {} : { comms }),
          ...(model?.trim() ? { model: model.trim() } : {}),
          ...(brief.trim() && brief !== saved ? { brief } : {}),
        });
      }}
    >
      {busy ? <LaunchProgress state={launcher.state} /> : <>
      <fieldset>
        <legend className={legend}>{t('launch.step.what')}</legend>
        {picker && (
          <div role="radiogroup" aria-label={t('launch.template')} onKeyDown={radioGroupKeys} className="grid grid-cols-3 gap-1.5">
            {templates.map((tp) => (
              <button key={tp.package} type="button" role="radio" aria-checked={selected === tp.package} tabIndex={selected === tp.package ? 0 : -1}
                title={tp.description || undefined} onClick={() => setChoice(tp.package)}
                className={`${radio} ${selected === tp.package ? radioOn : radioOff}`}>
                {tp.name}
              </button>
            ))}
            <button type="button" role="radio" aria-checked={custom} tabIndex={custom ? 0 : -1} onClick={() => setChoice(CUSTOM_SOUL)}
              className={`${radio} ${custom ? radioOn : radioOff}`}>
              {t('launch.custom')}
            </button>
          </div>
        )}
        {picker && template?.description && <p className="text-xs text-muted-foreground">{template.description}</p>}
        {picker && templateError && <p className="text-xs text-muted-foreground" title={templateError}>{t('launch.templateErrors')}</p>}
        {soul ? (
          <p className="text-sm font-medium">{displayName(soul)}</p>
        ) : custom && (
          <input value={packagePath} aria-label={t('launch.package')} placeholder={t('launch.packagePlaceholder')} className={field}
            onChange={(e) => {
              if (picker) setChoice(CUSTOM_SOUL);
              setPackagePath(e.target.value);
              setPackageError(null);
            }}
            onBlur={(e) => setPackagePath(normalPackagePath(e.target.value))} />
        )}
        {!soul && (
          <label className="grid gap-1">
            <span className="text-sm font-medium">{t('launch.name')}</span>
            {/* Not a person's name: keep the web view from offering contact AutoFill (#80). */}
            <input value={name} placeholder={copyOf ? t('launch.nameRequired') : t('launch.nameOptional')} autoComplete="off" className={field}
              required={Boolean(copyOf)} aria-describedby={copyOf ? 'launch-copy-hint' : undefined}
              onChange={(e) => { setTouched((was) => ({ ...was, name: true })); setName(e.target.value); }} />
          </label>
        )}
        {!soul && copyOf && (
          <p id="launch-copy-hint" className="text-xs text-muted-foreground">{t('launch.copyHint', { name: copyOf.name || copyOf.agentId })}</p>
        )}
        {!soul && custom && packageDescription && <p className="text-xs text-muted-foreground">{packageDescription}</p>}
        <label className="grid gap-1">
          <span className="text-sm font-medium">{t('launch.brief')}</span>
          <textarea value={brief} rows={3} placeholder={t('launch.briefPlaceholder')} autoComplete="off" disabled={briefLoading}
            aria-describedby="launch-brief-hint launch-brief-count" aria-invalid={briefTooLong || undefined}
            className="min-h-16 w-full resize-y rounded-md border border-input bg-transparent px-3 py-2 text-sm text-foreground disabled:opacity-50"
            onChange={(e) => { briefTyped.current = true; setBrief(e.target.value); }} />
        </label>
        <p className="flex justify-between gap-2 text-xs text-muted-foreground">
          <span id="launch-brief-hint" role={briefLoading ? 'status' : undefined}>
            {briefLoading ? t('launch.briefLoading') : soul ? t('launch.briefKeep') : t('launch.briefHint')}
          </span>
          <span id="launch-brief-count" className={`shrink-0 font-mono ${briefTooLong ? 'text-destructive' : ''}`}>{briefLength} / {MAX_BRIEF}</span>
        </p>
        {briefTooLong && <p className="error small" role="alert">{t('launch.briefTooLong', { max: MAX_BRIEF })}</p>}
      </fieldset>
      <fieldset>
        <legend className={legend}>{t('launch.step.harness')}</legend>
        {/* Free text, as before: "Other…" launches any harness string; the list only suggests. */}
        <Select aria-label={t('field.harness')} value={otherHarness ? OTHER : harness} wrapperClassName="w-full" className="h-9 pl-3 text-sm"
          onChange={(e) => {
            const other = e.target.value === OTHER;
            setOtherHarness(other);
            setTouched((was) => ({ ...was, harness: true }));
            setHarness(other ? '' : e.target.value);
          }}>
          {!harness && !otherHarness && <option value="" disabled>{t('launch.harnessPick')}</option>}
          {options.map((h) => <option key={h.id} value={h.id}>{h.label}{h.id === defaultHarness ? ` · ${t('launch.harnessDefault')}` : ''}</option>)}
          <option value={OTHER}>{t('harness.other')}</option>
        </Select>
        {otherHarness && (
          <input type="text" aria-label={t('harness.otherLabel')} placeholder={t('harness.otherPlaceholder')} value={harness}
            maxLength={MAX_HARNESS} autoCapitalize="off" autoCorrect="off" spellCheck={false} autoComplete="off"
            className={`${field} font-mono text-xs`}
            onChange={(e) => { setTouched((was) => ({ ...was, harness: true })); setHarness(e.target.value); }} />
        )}
        <p className="text-xs text-muted-foreground">{t('launch.harnessHint')}</p>
        <ModelField roster={roster} harness={harness} value={model} onChange={setModel} />
      </fieldset>
      <fieldset>
        <legend className={legend}>{t('launch.step.account')}</legend>
        {soul ? (
          <input value={account} readOnly aria-label={t('field.account')} className={`${field} font-mono text-xs`} />
        ) : (
          <>
            {accounts.length > 0 && (
              <Select aria-label={t('field.account')} value={otherAccount ? OTHER : account} wrapperClassName="w-full" className="h-9 pl-3 font-mono text-xs"
                onChange={(e) => {
                  const other = e.target.value === OTHER;
                  setOtherAccount(other);
                  setAccount(other ? '' : e.target.value);
                }}>
                {!account && !otherAccount && <option value="" disabled>{t('launch.accountPick')}</option>}
                {accounts.map((a) => <option key={a} value={a}>{a}</option>)}
                <option value={OTHER}>{t('launch.accountOther')}</option>
              </Select>
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
      </>}
      {checkingPackage && <p className="muted small" role="status">{t('launch.checking')}</p>}
      {pathError && <p className="error small" role="alert">{pathError}</p>}
      {started ? !busy && <LaunchStatus state={launcher.state} />
        : !ready && <p className="muted small">{t('launch.busy')}</p>}
      {!busy && <div className="flex items-center justify-end gap-2 pt-1">
        {onCancel && (
          <button type="button" onClick={onCancel} className="h-9 rounded-md px-4 text-sm font-medium hover:bg-accent">{t('cancel')}</button>
        )}
        <button type="submit" disabled={!ready || checkingPackage || Boolean(pathError) || needsName || briefTooLong}
          className="h-9 rounded-md bg-primary px-4 text-sm font-medium text-primary-foreground shadow hover:bg-primary/90 disabled:opacity-50">
          {t('launch.go')}
        </button>
      </div>}
    </form>
  );
}
