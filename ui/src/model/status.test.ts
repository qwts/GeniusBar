import { describe, expect, it } from 'vitest';
import {
  brokerErrorMessage,
  credentialNote,
  disconnected,
  emptyRosterText,
  footerStatus,
  formatTime,
  formatUptime,
  healthHeader,
  pendingApprovalMessage,
  unpairedMessage,
  type BrokerHealth,
  type ConnectionSnapshot,
} from './status';

const health: BrokerHealth = {
  ok: true,
  uptimeMs: 12_000,
  eventLogBytes: 512,
  pairings: { accounts: 1, principals: 2 },
  watches: 3,
};
const connected: ConnectionSnapshot = { ...disconnected, bridgeConnected: true };
const refreshed = new Date(2026, 0, 1, 12, 0, 1);

describe('Broker error messages', () => {
  // The userMessage halves of BrokerClientTests; the transport halves
  // belong to agent-comms now.
  it('points unauthenticated at principal pairing', () => {
    expect(brokerErrorMessage('unauthenticated', 'unknown principal')).toBe(
      'Not set up yet. Use Set up below.',
    );
  });

  it('waits for owner approval on not-approved, never echoing the prose', () => {
    expect(brokerErrorMessage('not-approved', 'the owner has not approved this principal yet')).toBe(
      pendingApprovalMessage,
    );
    expect(brokerErrorMessage('not-approved', '')).toBe(pendingApprovalMessage);
  });

  it('shows other errors as message and code', () => {
    expect(brokerErrorMessage('no-such-soul', 'gone')).toBe('gone (no-such-soul)');
    expect(brokerErrorMessage('no-such-soul', '')).toBe('no-such-soul');
  });
});

describe('Health header', () => {
  it('reports the missing bridge before anything else', () => {
    const header = healthHeader(disconnected);
    expect(header.tone).toBe('unknown');
    expect(header.title).toMatch(/not connected/i);
    expect(credentialNote(disconnected)).toBeNull();
    expect(emptyRosterText(disconnected)).toBeNull();
  });

  it('shows the credential loading and unpaired states', () => {
    expect(credentialNote({ ...connected, loadingCredential: true })).toBe('Loading credential…');
    expect(credentialNote({ ...connected, unpaired: true })).toBe(unpairedMessage);
    expect(credentialNote(connected)).toBeNull();
  });

  it('flags an unreachable broker, with or without a last census', () => {
    const never = healthHeader({ ...connected, brokerUnreachable: true, health });
    expect(never.tone).toBe('bad');
    expect(never.title).toBe('Broker unreachable');
    expect(never.detail).toBe('No successful census yet.');
    expect(never.label).toBe('Broker unreachable. No successful census yet.');
    const known = healthHeader({ ...connected, brokerUnreachable: true, lastRefresh: refreshed });
    expect(known.detail).toBe(`Last known · ${formatTime(refreshed)}`);
    expect(known.label).toBe(`Broker unreachable. Last known census ${formatTime(refreshed)}.`);
    expect(emptyRosterText({ ...connected, brokerUnreachable: true })).toBe('No successful census yet.');
  });

  it('summarises a healthy broker', () => {
    const header = healthHeader({ ...connected, health });
    expect(header.tone).toBe('ok');
    expect(header.title).toBe('Broker healthy');
    expect(header.detail).toBe('uptime 12s · log 512 B · accounts 1 · principals 2 · watches 3');
    expect(emptyRosterText({ ...connected, health })).toBe('No souls on this machine.');
  });

  it('says unknown when connected with no health yet', () => {
    expect(healthHeader(connected).title).toBe('Broker status unknown');
  });

  it('formats uptime in seconds, minutes, then hours and minutes', () => {
    expect(formatUptime(59_999)).toBe('59s');
    expect(formatUptime(60_000)).toBe('1m');
    expect(formatUptime(3_599_000)).toBe('59m');
    expect(formatUptime(3_600_000 + 5 * 60_000)).toBe('1h 5m');
  });
});

describe('Footer status', () => {
  it('prefers outage age, then the last error, then freshness', () => {
    expect(footerStatus(connected)).toBeNull();
    expect(footerStatus({ ...connected, lastRefresh: refreshed })).toEqual({
      text: `Updated ${formatTime(refreshed)}`,
      isError: false,
    });
    expect(footerStatus({ ...connected, lastRefresh: refreshed, lastError: 'boom' })).toEqual({
      text: 'boom',
      isError: true,
    });
    expect(
      footerStatus({ ...connected, lastRefresh: refreshed, lastError: 'boom', brokerUnreachable: true }),
    ).toEqual({ text: `Last known · ${formatTime(refreshed)}`, isError: false });
    // Before setup the keychain has no principal: the header says so, not the footer.
    expect(footerStatus({ ...connected, unpaired: true, lastError: 'cannot read the principal' })).toBeNull();
    // Waiting for approval and a dropped bridge are still the footer's to say.
    expect(footerStatus({ ...connected, unpaired: true, lastError: pendingApprovalMessage }))
      .toEqual({ text: pendingApprovalMessage, isError: true });
    expect(footerStatus({ ...connected, unpaired: true, bridgeConnected: false, lastError: 'node exited (bridge-exited)' }))
      .toEqual({ text: 'node exited (bridge-exited)', isError: true });
  });
});

describe('healthHeader without a health op', () => {
  it('reports connected once a census has succeeded', () => {
    const s = { ...disconnected, bridgeConnected: true, lastRefresh: new Date('2026-10-02T01:00:00Z') };
    expect(healthHeader(s)).toMatchObject({ tone: 'ok', title: 'Connected to agent-comms' });
  });
});
