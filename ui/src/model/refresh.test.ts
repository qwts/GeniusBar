import { describe, expect, it } from 'vitest';
import { applyCensus, commsOf, computerUseOf, sameSet } from './refresh';
import { disconnected, unpairedMessage } from './status';

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
});
