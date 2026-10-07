// Health header and status text, ported from R1's ContentView/AppState.
// The view state is a plain snapshot so the bridge (#7) can fill it and
// tests can drive every branch without a broker.
import { translate, type Lang, type Translate } from '../lib/i18n';
import type { MessageKey } from '../locales/en';

const english: Translate = (key, vars) => translate('en', key, vars);

/** Broker health as the R1 health op reported it. */
export interface BrokerHealth {
  ok: boolean;
  uptimeMs: number;
  eventLogBytes: number;
  pairings: { accounts: number; principals: number };
  watches: number;
}

export interface ConnectionSnapshot {
  /** False until the Node bridge is up; R1 had no equivalent state. */
  bridgeConnected: boolean;
  loadingCredential: boolean;
  unpaired: boolean;
  /** Set while unreachable; the last census stays on screen as "Last known". */
  brokerUnreachable: boolean;
  health: BrokerHealth | null;
  /**
   * The last failure: one of `statusErrors` (a locale key, translated where
   * it shows; see `errorText`), or the broker's own prose when it had some.
   */
  lastError: string | null;
  lastRefresh: Date | null;
  /**
   * Installed but not answering yet (#118): GeniusBar's services are
   * registered and no census has succeeded in this run, so a busy Mac is
   * still starting them. Setup stays hidden until STARTING_WINDOW_MS of
   * continuous failures has passed.
   */
  starting?: boolean;
  /** When the current run of unreachable-broker failures began. */
  failingSince?: Date | null;
}

/** How long installed services may stay silent before setup is offered again (#118). */
export const STARTING_WINDOW_MS = 5 * 60_000;

export const disconnected: ConnectionSnapshot = {
  bridgeConnected: false,
  loadingCredential: false,
  unpaired: false,
  brokerUnreachable: false,
  health: null,
  lastError: null,
  lastRefresh: null,
  starting: false,
  failingSince: null,
};

/**
 * The failures GeniusBar words itself, stored in `lastError` as their locale
 * keys and translated where they show (`errorText`).
 */
export const statusErrors = {
  // The setup panel shows whenever the app is unpaired, so this points there
  // rather than at a terminal (R4: a friend has none).
  unpaired: 'status.error.unpaired',
  notApproved: 'status.error.notApproved',
  unreachable: 'status.error.unreachable',
  unknown: 'status.error.unknown',
  bridge: 'status.error.bridge',
} as const satisfies Record<string, MessageKey>;

const errorKeys: ReadonlySet<string> = new Set(Object.values(statusErrors));

/** `lastError` in the app's language: a code is translated, the broker's prose shown as it is. */
export function errorText(error: string, t: Translate = english): string {
  return errorKeys.has(error) ? t(error as MessageKey) : error;
}

export const unpairedMessage = translate('en', statusErrors.unpaired);
export const pendingApprovalMessage = translate('en', statusErrors.notApproved);

/**
 * What `lastError` stores for a broker error: a code GeniusBar translates,
 * or the broker's own message. Pairing errors point at the fix; the
 * broker's message is prose, so its code is never echoed.
 */
export function brokerErrorCode(code: string, message: string): string {
  if (code === 'unauthenticated') return statusErrors.unpaired;
  if (code === 'not-approved') return statusErrors.notApproved;
  if (code === 'broker-unreachable' || code === 'broker-timeout' || code === 'broker-untrusted') {
    return statusErrors.unreachable;
  }
  return message === '' ? statusErrors.unknown : message;
}

/** User-facing text for a broker error, in the given language (English by default). */
export function brokerErrorMessage(code: string, message: string, t: Translate = english): string {
  return errorText(brokerErrorCode(code, message), t);
}

export function formatUptime(ms: number): string {
  const s = Math.trunc(ms / 1000);
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.trunc(s / 60)}m`;
  return `${Math.trunc(s / 3600)}h ${Math.trunc((s % 3600) / 60)}m`;
}

/** Hour and minute in the app's language, as the chat's timestamps. */
export function formatTime(date: Date, lang: Lang = 'en'): string {
  return new Intl.DateTimeFormat(lang, { hour: '2-digit', minute: '2-digit' }).format(date);
}

export type Tone = 'ok' | 'bad' | 'unknown';

export interface HeaderState {
  tone: Tone;
  title: string;
  detail: string | null;
  /** Combined spoken label; the dot colour is never the only signal. */
  label: string;
}

export function healthHeader(s: ConnectionSnapshot, t: Translate = english, lang: Lang = 'en'): HeaderState {
  if (!s.bridgeConnected) {
    const title = t('status.connecting');
    return { tone: 'unknown', title, detail: null, label: title };
  }
  // Installed services still starting after login (#118): not an outage yet.
  if (s.starting && s.brokerUnreachable) {
    const title = t('status.starting');
    const detail = t('status.startingDetail');
    return { tone: 'unknown', title, detail, label: `${title} ${detail}` };
  }
  if (s.brokerUnreachable) {
    const title = t('status.unreachable');
    if (s.lastRefresh) {
      const time = formatTime(s.lastRefresh, lang);
      return {
        tone: 'bad',
        title,
        detail: t('status.lastUpdated', { time }),
        label: t('status.unreachableSince', { time }),
      };
    }
    const detail = t('status.appearOnConnect');
    return { tone: 'bad', title, detail, label: t('status.unreachableLabel', { detail }) };
  }
  if (s.health) {
    const title = t('status.connected');
    return { tone: 'ok', title, detail: null, label: title };
  }
  // The principal client has no health op; a census proves the broker is up.
  if (s.lastRefresh) {
    const title = t('status.connected');
    return { tone: 'ok', title, detail: null, label: title };
  }
  const title = t('status.checking');
  return { tone: 'unknown', title, detail: null, label: title };
}

/** Credential line under the header, or null when there is nothing to say. */
export function credentialNote(s: ConnectionSnapshot, t: Translate = english): string | null {
  if (!s.bridgeConnected) return null;
  if (s.loadingCredential) return t('status.loadingCredential');
  if (s.unpaired) return t('status.unpaired');
  return null;
}

/**
 * Text for an empty roster. Null before the bridge connects, when nothing
 * is known about the machine yet.
 */
export function emptyRosterText(s: ConnectionSnapshot, t: Translate = english): string | null {
  if (!s.bridgeConnected) return null;
  return s.brokerUnreachable ? t('status.appearOnConnect') : t('fleet.empty');
}

export interface FooterState {
  text: string;
  isError: boolean;
}

/** Footer status: outage age first, then the last error, then freshness. */
export function footerStatus(s: ConnectionSnapshot, t: Translate = english, lang: Lang = 'en'): FooterState | null {
  if (s.brokerUnreachable && s.lastRefresh) {
    return { text: t('status.lastUpdated', { time: formatTime(s.lastRefresh, lang) }), isError: false };
  }
  // Before the first successful census this is part of first-run setup;
  // the setup panel already explains what to do.
  if (s.brokerUnreachable && !s.lastRefresh) return null;
  // A missing credential is the setup panel's job, not an error. Approval
  // instructions and bridge failures (no setup panel then) still show.
  const setupsJob = s.unpaired && s.bridgeConnected && s.lastError !== statusErrors.notApproved;
  if (s.lastError !== null && !setupsJob) return { text: errorText(s.lastError, t), isError: true };
  if (s.lastRefresh) return { text: t('status.updated', { time: formatTime(s.lastRefresh, lang) }), isError: false };
  return null;
}
