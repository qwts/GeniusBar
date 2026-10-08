import { useContext, useEffect, useState } from 'react';
import type { ModelChoice } from '../bridge';
import type { CensusRow } from '../model/census';
import { MAX_MODEL } from '../model/launch';
import { useI18n, type Translate } from '../lib/i18n';
import { Select } from './Select';
import { SoulSourceContext } from './SoulNotices';

const DEFAULT = '__default';
const OTHER = '__other';

/**
 * The models the harness listed for any census soul it runs (#128), each
 * once, read through agent-bot once per harness choice. Empty until the
 * reads settle, and when no soul on that harness has run a turn yet; the
 * form never waits on it.
 */
export function useHarnessModels(roster: readonly CensusRow[], harness: string): ModelChoice[] {
  const source = useContext(SoulSourceContext);
  const id = harness.trim();
  const agents = id ? [...new Set(roster.filter((s) => s.harness === id).map((s) => s.agentId))].sort() : [];
  const key = agents.join('\n');
  const [state, setState] = useState<{ key: string; harness: string; models: ModelChoice[] }>({ key: '', harness: '', models: [] });
  useEffect(() => {
    let active = true;
    if (!key) return;
    void Promise.all(key.split('\n').map((agentId) => source.model(agentId).catch(() => null))).then((settings) => {
      if (!active) return;
      const models: ModelChoice[] = [];
      for (const setting of settings) {
        for (const choice of setting?.available ?? []) {
          if (!models.some((m) => m.modelId === choice.modelId)) models.push(choice);
        }
      }
      setState({ key, harness: id, models });
    });
    return () => { active = false; };
  }, [id, key, source]);
  return state.key === key && state.harness === id ? state.models : [];
}

/** The longest option label drawn; the full text stays in the option's title and the Stored line. */
const MAX_LABEL = 56;

/** A harness's own "(recommended)" or "(default)" suffix, which the design's wording carries instead. */
const RECOMMENDED_SUFFIX = /\s*\((recommended|default)\)\s*$/i;

/**
 * A listed model's option text (#284): the harness's recommended entry is
 * "{label} (harness's recommended) · {id}", any other its name (its id when
 * the harness named it so). Long labels end in an ellipsis; `title` holds
 * the whole text, the id and the harness's description.
 */
export function modelOptionLabel(choice: ModelChoice, t: Translate): { text: string; title: string } {
  const full = choice.recommended
    ? t('model.recommended', { label: choice.name.replace(RECOMMENDED_SUFFIX, '') || choice.modelId, id: choice.modelId })
    : choice.name;
  const text = full.length > MAX_LABEL ? `${full.slice(0, MAX_LABEL - 1)}…` : full;
  const title = [full.includes(choice.modelId) ? full : `${full} · ${choice.modelId}`, choice.description].filter(Boolean).join(' — ');
  return { text, title };
}

interface ModelSelectProps {
  /** The chosen model; null is the harness default. */
  value: string | null;
  choices: readonly ModelChoice[];
  /** The select's accessible name. */
  label: string;
  disabled?: boolean;
  /**
   * `live` reports every keystroke of "Other…" (a form field); `submit`
   * reports it on Enter or Use (a setting agent-bot asks the owner about).
   */
  commit: 'live' | 'submit';
  onChange: (model: string | null) => void;
  className?: string;
}

/**
 * The model control, drawn as the launch form's Harness select: "Harness
 * default (inherit — nothing stored)", the harness's own list (its
 * recommended entry named as such, with its exact id), then "Other…" with
 * free text. A chosen model the list lacks stays as an option of its own.
 * Under it, what is stored and what runs (#284): the stored value as it is,
 * and the effective model, which no engine field reports today, so it reads
 * Unknown rather than a guess. The same copy in Launch and Details.
 */
export function ModelSelect({ value, choices, label, disabled = false, commit, onChange, className = '' }: ModelSelectProps) {
  const { t } = useI18n();
  const [other, setOther] = useState(false);
  const [draft, setDraft] = useState('');
  const listed = value === null || choices.some((m) => m.modelId === value);
  const typed = draft.trim();
  const submit = () => {
    if (!typed || typed.length > MAX_MODEL) return;
    setOther(false);
    setDraft('');
    if (typed !== value) onChange(typed);
  };
  return (
    <span className="grid gap-1">
      {/* The design's Select trigger; its padding leaves the chevron room on the right. */}
      <Select aria-label={label} value={other ? OTHER : value ?? DEFAULT} disabled={disabled} wrapperClassName="w-full"
        className={className.replace(/(^|\s)px-(\S+)/, '$1pl-$2')}
        onChange={(e) => {
          const next = e.target.value;
          if (next === OTHER) {
            setOther(true);
            setDraft('');
            if (commit === 'live') onChange(null);
            return;
          }
          setOther(false);
          const model = next === DEFAULT ? null : next;
          if (commit === 'live' || model !== value) onChange(model);
        }}>
        <option value={DEFAULT} title={t('model.storedNone')}>{t('model.default')}</option>
        {choices.map((m) => {
          const { text, title } = modelOptionLabel(m, t);
          return <option key={m.modelId} value={m.modelId} title={title}>{text}</option>;
        })}
        {!listed && value !== null && <option value={value} title={value}>{value.length > MAX_LABEL ? `${value.slice(0, MAX_LABEL - 1)}…` : value}</option>}
        <option value={OTHER}>{t('model.other')}</option>
      </Select>
      {other && (
        <span className="flex items-center gap-2">
          <input type="text" aria-label={t('model.otherLabel')} placeholder={t('model.otherPlaceholder')} value={draft}
            maxLength={MAX_MODEL} autoComplete="off" autoCapitalize="off" autoCorrect="off" spellCheck={false} disabled={disabled} className={`${className} min-w-0 flex-1 font-mono text-xs`}
            onChange={(e) => {
              setDraft(e.target.value);
              if (commit === 'live') onChange(e.target.value.trim() || null);
            }}
            onKeyDown={(e) => {
              if (commit === 'submit' && e.key === 'Enter') { e.preventDefault(); submit(); }
            }} />
          {commit === 'submit' && (
            <button type="button" disabled={disabled || !typed} onClick={submit}
              className="h-8 shrink-0 rounded-md bg-primary px-3 font-sans text-xs font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-50">
              {t('model.use')}
            </button>
          )}
        </span>
      )}
      <span className="block break-all font-mono text-[11px] text-muted-foreground" data-testid="model-stored">
        {value === null ? t('model.storedNone') : t('model.stored', { value })}
      </span>
      <span className="block font-sans text-[11px] text-muted-foreground" data-testid="model-effective">{t('model.effectiveUnknown')}</span>
    </span>
  );
}

const field = 'h-9 w-full rounded-md border border-input bg-transparent px-3 text-sm text-foreground';

/**
 * The launch form's Model field (#128), under the harness: "Harness
 * default" sends no model; a choice from the census souls' lists on this
 * harness, or any typed id, is saved for the new soul before its first turn.
 */
export function ModelField({ roster, harness, value, onChange }:
  { roster: readonly CensusRow[]; harness: string; value: string | null; onChange: (model: string | null) => void }) {
  const { t } = useI18n();
  const choices = useHarnessModels(roster, harness);
  return (
    <div className="grid gap-1">
      <span className="text-sm font-medium" aria-hidden>{t('model.label')}</span>
      <ModelSelect key={harness} value={value} choices={choices} label={t('model.label')} commit="live" onChange={onChange} className={field} />
    </div>
  );
}
