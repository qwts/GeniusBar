import { describe, expect, it } from 'vitest';
import { applyProgress, idleSetup, needsSetup } from './setup';
import { disconnected } from './status';

describe('needsSetup', () => {
  it('is offered when unpaired or no broker has ever answered', () => {
    expect(needsSetup({ ...disconnected, bridgeConnected: true, unpaired: true })).toBe(true);
    expect(needsSetup({ ...disconnected, bridgeConnected: true, brokerUnreachable: true })).toBe(true);
  });

  it('is not offered before the bridge connects or during a later outage', () => {
    expect(needsSetup({ ...disconnected, unpaired: true })).toBe(false);
    expect(needsSetup({ ...disconnected, bridgeConnected: true, brokerUnreachable: true, lastRefresh: new Date() })).toBe(false);
  });
});

describe('applyProgress', () => {
  it('marks known steps and ignores anything else', () => {
    const s = applyProgress(applyProgress(idleSetup, { step: 'broker', state: 'done' }), { step: 'account', state: 'running' });
    expect(s.steps).toEqual({ broker: 'done', account: 'running', principal: 'pending' });
    expect(applyProgress(s, { step: 'other', state: 'done' })).toBe(s);
    expect(applyProgress(s, { step: 'broker', state: 'exploded' })).toBe(s);
  });
});
