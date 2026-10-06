import { describe, expect, it } from 'vitest';
import { applyCensus, commsAmong, commsOf, computerUseOf, sameSet } from './refresh';
import { disconnected, STARTING_WINDOW_MS, unpairedMessage } from './status';
import { needsSetup } from './setup';

const now = new Date('2026-10-02T01:00:00Z');
const later = new Date('2026-10-02T01:00:05Z');

describe('applyCensus', () => {
  it('a census connects and clears errors', () => {
    const s = applyCensus({ ...disconnected, lastError: 'x', brokerUnreachable: true }, { ok: true, souls: [] }, now);
    expect(s).toMatchObject({ bridgeConnected: true, brokerUnreachable: false, unpaired: false, lastError: null, lastRefresh: now });
  });

  it('an unreachable broker keeps the last refresh time', () => {
    const ok = applyCensus(disconnected, { ok: true, souls: [] }, now);
    const s = applyCensus(ok, { ok: false, code: 'broker-unreachable', message: 'no broker socket' }, later);
    expect(s).toMatchObject({ brokerUnreachable: true, lastRefresh: now, lastError: 'GeniusBar can’t reach its background service yet.' });
  });

  it('credential errors mean unpaired, with the pairing hint', () => {
    const s = applyCensus(disconnected, { ok: false, code: 'unauthenticated', message: 'who?' }, now);
    expect(s).toMatchObject({ bridgeConnected: true, unpaired: true, lastError: unpairedMessage });
  });

  it('bridge errors mean not connected yet', () => {
    const s = applyCensus(disconnected, { ok: false, code: 'bridge-unavailable', message: 'starting' }, now);
    expect(s.bridgeConnected).toBe(false);
    expect(s.lastError).toBe('GeniusBar had trouble starting its background service. Try reopening GeniusBar.');
  });

  it('other errors are reported without claiming an outage', () => {
    const s = applyCensus(disconnected, { ok: false, code: 'rate-limited', message: 'slow down' }, now);
    expect(s).toMatchObject({ bridgeConnected: true, brokerUnreachable: false, lastError: 'slow down' });
  });
});

describe('services starting after login (#118)', () => {
  const at = (ms: number) => new Date(now.getTime() + ms);
  const timeout = { ok: false as const, code: 'broker-timeout', message: 'broker request timed out after 5000ms' };
  const refused = { ok: false as const, code: 'broker-unreachable', message: 'cannot reach the broker: ECONNREFUSED' };
  const bridged = applyCensus(disconnected, { ok: false, code: 'bridge-unavailable', message: 'starting' }, now);

  it('a timeout with the services installed is starting, not setup', () => {
    const s = applyCensus(bridged, timeout, now, true);
    expect(s).toMatchObject({ bridgeConnected: true, brokerUnreachable: true, starting: true, failingSince: now, lastRefresh: null });
    expect(needsSetup(s)).toBe(false);
    // Still starting a little later; the first failure is kept.
    const again = applyCensus(s, refused, at(60_000), true);
    expect(again).toMatchObject({ starting: true, failingSince: now });
    expect(needsSetup(again)).toBe(false);
  });

  it('refused with nothing installed offers setup as before', () => {
    const s = applyCensus(bridged, refused, now, false);
    expect(s).toMatchObject({ brokerUnreachable: true, starting: false });
    expect(needsSetup(s)).toBe(true);
    // The default (installation unknown) behaves the same.
    expect(needsSetup(applyCensus(bridged, refused, now))).toBe(true);
  });

  it('starting that recovers is connected', () => {
    const starting = applyCensus(applyCensus(bridged, timeout, now, true), timeout, at(90_000), true);
    const s = applyCensus(starting, { ok: true, souls: [] }, at(120_000));
    expect(s).toMatchObject({ bridgeConnected: true, brokerUnreachable: false, starting: false, failingSince: null, lastRefresh: at(120_000) });
    expect(needsSetup(s)).toBe(false);
  });

  it('starting past the window falls back to setup', () => {
    const starting = applyCensus(bridged, timeout, now, true);
    const near = applyCensus(starting, timeout, at(STARTING_WINDOW_MS - 1), true);
    expect(near.starting).toBe(true);
    const over = applyCensus(near, timeout, at(STARTING_WINDOW_MS), true);
    expect(over).toMatchObject({ brokerUnreachable: true, starting: false, failingSince: now });
    expect(needsSetup(over)).toBe(true);
  });

  it('is never starting once a census answered in this run, or when unpaired', () => {
    const ok = applyCensus(disconnected, { ok: true, souls: [] }, now);
    expect(applyCensus(ok, timeout, later, true).starting).toBe(false);
    const unpaired = applyCensus(applyCensus(bridged, timeout, now, true), { ok: false, code: 'unauthenticated', message: 'who?' }, later, true);
    expect(unpaired).toMatchObject({ unpaired: true, starting: false, failingSince: null });
    expect(needsSetup(unpaired)).toBe(true);
  });
});

describe('desktop badges (#122)', () => {
  it('lists computer-use souls only while the daemon runs', () => {
    const using = { running: true, computerUse: [{ agentId: 'agent_1', since: null }] };
    expect([...computerUseOf(using)]).toEqual(['agent_1']);
    expect(computerUseOf({ ...using, running: false }).size).toBe(0);
    expect(computerUseOf(null).size).toBe(0);
  });

  it('lists souls with comms on, skipping ones agent-bot could not answer for', () => {
    const state = (agentId: string, comms: boolean) => ({ agentId, comms, managed: true, running: false });
    expect([...commsOf([state('a', true), null, state('b', false)])]).toEqual(['a']);
    expect(sameSet(new Set(['a', 'b']), new Set(['b', 'a']))).toBe(true);
    expect(sameSet(new Set(['a']), new Set(['b']))).toBe(false);
  });

  it('narrows the one-call population list to the visible souls (#137)', () => {
    const list = [{ agentId: 'a', comms: true }, { agentId: 'b', comms: false }, { agentId: 'hidden', comms: true }];
    expect([...commsAmong(list, ['a', 'b', 'missing'])]).toEqual(['a']);
    expect(commsAmong(list, []).size).toBe(0);
  });
});
