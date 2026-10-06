// Health header and status text, ported from R1's ContentView/AppState.
// The view state is a plain snapshot so the bridge (#7) can fill it and
// tests can drive every branch without a broker.
import { translate, type Translate } from '../lib/i18n';

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

// The setup panel shows whenever the app is unpaired, so this points there
// rather than at a terminal (R4: a friend has none).
export const unpairedMessage = 'GeniusBar needs setup on this Mac. Choose Set up below.';
export const pendingApprovalMessage =
  'GeniusBar needs approval to connect. Ask your account owner to approve it.';

/**
 * User-facing text for a broker error. Pairing errors point at the fix;
 * the broker's own message is prose, so it is never echoed as a code.
 */
export function brokerErrorMessage(code: string, message: string): string {
  if (code === 'unauthenticated') return unpairedMessage;
  if (code === 'not-approved') return pendingApprovalMessage;
  if (code === 'broker-unreachable' || code === 'broker-timeout' || code === 'broker-untrusted') {
    return 'GeniusBar can’t reach its background service yet.';
  }
  return message === '' ? 'GeniusBar couldn’t check your account. Try again in a moment.' : message;
}

export function formatUptime(ms: number): string {
  const s = Math.trunc(ms / 1000);
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.trunc(s / 60)}m`;
  return `${Math.trunc(s / 3600)}h ${Math.trunc((s % 3600) / 60)}m`;
}

export function formatTime(date: Date): string {
  return date.toLocaleTimeString();
}

export type Tone = 'ok' | 'bad' | 'unknown';

export interface HeaderState {
  tone: Tone;
  title: string;
  detail: string | null;
  /** Combined spoken label; the dot colour is never the only signal. */
  label: string;
}

export function healthHeader(s: ConnectionSnapshot, t: Translate = (key, vars) => translate('en', key, vars)): HeaderState {
  if (!s.bridgeConnected) {
    const title = 'Connecting to GeniusBar’s background service…';
    return { tone: 'unknown', title, detail: null, label: title };
  }
  // Installed services still starting after login (#118): not an outage yet.
  if (s.starting && s.brokerUnreachable) {
    const title = t('status.starting');
    const detail = t('status.startingDetail');
    return { tone: 'unknown', title, detail, label: `${title} ${detail}` };
  }
  if (s.brokerUnreachable) {
    const title = 'Can’t reach the background service';
    if (s.lastRefresh) {
      const time = formatTime(s.lastRefresh);
      return {
        tone: 'bad',
        title,
        detail: `Last updated · ${time}`,
        label: `Can’t reach the background service. Last updated ${time}.`,
      };
    }
    return {
      tone: 'bad',
      title,
      detail: 'Your companions will appear here once GeniusBar connects.',
      label: 'Can’t reach the background service. Your companions will appear here once GeniusBar connects.',
    };
  }
  if (s.health) {
    return { tone: 'ok', title: 'Connected', detail: null, label: 'Connected' };
  }
  // The principal client has no health op; a census proves the broker is up.
  if (s.lastRefresh) {
    const title = 'Connected';
    return { tone: 'ok', title, detail: null, label: title };
  }
  const title = 'Checking connection…';
  return { tone: 'unknown', title, detail: null, label: title };
}

/** Credential line under the header, or null when there is nothing to say. */
export function credentialNote(s: ConnectionSnapshot): string | null {
  if (!s.bridgeConnected) return null;
  if (s.loadingCredential) return 'Loading credential…';
  if (s.unpaired) return unpairedMessage;
  return null;
}

/**
 * Text for an empty roster. Null before the bridge connects, when nothing
 * is known about the machine yet.
 */
export function emptyRosterText(s: ConnectionSnapshot): string | null {
  if (!s.bridgeConnected) return null;
  return s.brokerUnreachable ? 'Your companions will appear here once GeniusBar connects.' : 'No companions yet. Your first companion will appear here.';
}

export interface FooterState {
  text: string;
  isError: boolean;
}

/** Footer status: outage age first, then the last error, then freshness. */
export function footerStatus(s: ConnectionSnapshot): FooterState | null {
  if (s.brokerUnreachable && s.lastRefresh) {
    return { text: `Last updated · ${formatTime(s.lastRefresh)}`, isError: false };
  }
  // Before the first successful census this is part of first-run setup;
  // the setup panel already explains what to do.
  if (s.brokerUnreachable && !s.lastRefresh) return null;
  // A missing credential is the setup panel's job, not an error. Approval
  // instructions and bridge failures (no setup panel then) still show.
  const setupsJob = s.unpaired && s.bridgeConnected && s.lastError !== pendingApprovalMessage;
  if (s.lastError !== null && !setupsJob) return { text: s.lastError, isError: true };
  if (s.lastRefresh) return { text: `Updated ${formatTime(s.lastRefresh)}`, isError: false };
  return null;
}
