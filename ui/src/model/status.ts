// Health header and status text, ported from R1's ContentView/AppState.
// The view state is a plain snapshot so the bridge (#7) can fill it and
// tests can drive every branch without a broker.

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
}

export const disconnected: ConnectionSnapshot = {
  bridgeConnected: false,
  loadingCredential: false,
  unpaired: false,
  brokerUnreachable: false,
  health: null,
  lastError: null,
  lastRefresh: null,
};

// The setup panel shows whenever the app is unpaired, so this points there
// rather than at a terminal (R4: a friend has none).
export const unpairedMessage = 'Not set up yet. Use Set up below.';
export const pendingApprovalMessage =
  'Waiting for owner approval. The owner runs: agent-comms admin principals, then agent-comms admin principal-approve CODE';

/**
 * User-facing text for a broker error. Pairing errors point at the fix;
 * the broker's own message is prose, so it is never echoed as a code.
 */
export function brokerErrorMessage(code: string, message: string): string {
  if (code === 'unauthenticated') return unpairedMessage;
  if (code === 'not-approved') return pendingApprovalMessage;
  return message === '' ? code : `${message} (${code})`;
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

export function healthHeader(s: ConnectionSnapshot): HeaderState {
  if (!s.bridgeConnected) {
    const title = 'Not connected to agent-comms yet.';
    return { tone: 'unknown', title, detail: null, label: title };
  }
  if (s.brokerUnreachable) {
    const title = 'Broker unreachable';
    if (s.lastRefresh) {
      const time = formatTime(s.lastRefresh);
      return {
        tone: 'bad',
        title,
        detail: `Last known · ${time}`,
        label: `Broker unreachable. Last known census ${time}.`,
      };
    }
    return {
      tone: 'bad',
      title,
      detail: 'No successful census yet.',
      label: 'Broker unreachable. No successful census yet.',
    };
  }
  if (s.health) {
    const h = s.health;
    const detail =
      `uptime ${formatUptime(h.uptimeMs)} · log ${h.eventLogBytes} B · ` +
      `accounts ${h.pairings.accounts} · principals ${h.pairings.principals} · ` +
      `watches ${h.watches}`;
    return { tone: 'ok', title: 'Broker healthy', detail, label: `Broker healthy. ${detail}` };
  }
  // The principal client has no health op; a census proves the broker is up.
  if (s.lastRefresh) {
    const title = 'Connected to agent-comms';
    return { tone: 'ok', title, detail: null, label: title };
  }
  const title = 'Broker status unknown';
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
  return s.brokerUnreachable ? 'No successful census yet.' : 'No souls on this machine.';
}

export interface FooterState {
  text: string;
  isError: boolean;
}

/** Footer status: outage age first, then the last error, then freshness. */
export function footerStatus(s: ConnectionSnapshot): FooterState | null {
  if (s.brokerUnreachable && s.lastRefresh) {
    return { text: `Last known · ${formatTime(s.lastRefresh)}`, isError: false };
  }
  // A missing credential is the setup panel's job, not an error. Approval
  // instructions and bridge failures (no setup panel then) still show.
  const setupsJob = s.unpaired && s.bridgeConnected && s.lastError !== pendingApprovalMessage;
  if (s.lastError !== null && !setupsJob) return { text: s.lastError, isError: true };
  if (s.lastRefresh) return { text: `Updated ${formatTime(s.lastRefresh)}`, isError: false };
  return null;
}
