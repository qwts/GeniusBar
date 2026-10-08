import { act, renderHook, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { BridgeError, type PreparedRevision, type SoulProfile } from './bridge';
import { samplePreparedRevision, sampleProfile } from './model/fixtures';
import { ProfileSourceContext, useRevisionStaging, useSoulProfile, type ProfileSource } from './useSoulProfile';

const wrap = (source: ProfileSource | null) => ({ children }: { children: ReactNode }) => (
  <ProfileSourceContext.Provider value={source}>{children}</ProfileSourceContext.Provider>
);
const source = (profile: ProfileSource['profile'], rest: Partial<ProfileSource> = {}): ProfileSource => ({ profile, file: vi.fn(), prepare: vi.fn(async () => samplePreparedRevision), discard: vi.fn(async () => {}), ...rest });

describe('useSoulProfile (#64)', () => {
  it('reads the profile when opened, and again on each opening', async () => {
    const profile = vi.fn(async () => sampleProfile);
    const { result, rerender } = renderHook(({ open }) => useSoulProfile('agent_p', open),
      { initialProps: { open: false }, wrapper: wrap(source(profile)) });
    expect(profile).not.toHaveBeenCalled();
    expect(result.current).toEqual({ profile: null, supported: false, loading: false, error: null });
    rerender({ open: true });
    expect(result.current.loading).toBe(true);
    await waitFor(() => expect(result.current.supported).toBe(true));
    expect(result.current.profile?.profile.displayName).toBe('Luna');
    expect(result.current.loading).toBe(false);
    rerender({ open: false });
    rerender({ open: true });
    await waitFor(() => expect(profile).toHaveBeenCalledTimes(2));
    expect(profile).toHaveBeenCalledWith('agent_p');
  });

  it('is unsupported, without an error, on an older agent-bot', async () => {
    const profile = vi.fn(async (): Promise<SoulProfile> => { throw new BridgeError('soul-profile-unsupported', 'no soul profile'); });
    const { result } = renderHook(() => useSoulProfile('agent_p', true), { wrapper: wrap(source(profile)) });
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current).toEqual({ profile: null, supported: false, loading: false, error: null });
  });

  it('keeps the failure of a read that broke, as supported', async () => {
    const profile = async (): Promise<SoulProfile> => { throw new BridgeError('soul-not-found', 'No soul named luna.'); };
    const { result } = renderHook(() => useSoulProfile('agent_p', true), { wrapper: wrap(source(profile)) });
    await waitFor(() => expect(result.current.error).toBe('No soul named luna.'));
    expect(result.current.supported).toBe(true);
    expect(result.current.profile).toBeNull();
  });

  it('asks nothing without a source', () => {
    const { result } = renderHook(() => useSoulProfile('agent_p', true), { wrapper: wrap(null) });
    expect(result.current).toEqual({ profile: null, supported: false, loading: false, error: null });
  });
});

describe('useRevisionStaging (#268)', () => {
  const STAGING = samplePreparedRevision.staging as string;

  it('stages when opened, and discards the staging when closed without a save', async () => {
    const s = source(async () => sampleProfile);
    const { result, rerender } = renderHook(({ open }) => useRevisionStaging('agent_p', open),
      { initialProps: { open: false }, wrapper: wrap(s) });
    expect(s.prepare).not.toHaveBeenCalled();
    expect(result.current.prepared).toBeNull();
    rerender({ open: true });
    await waitFor(() => expect(result.current.prepared?.staging).toBe(STAGING));
    expect(s.prepare).toHaveBeenCalledWith('agent_p');
    expect(result.current.error).toBeNull();
    rerender({ open: false });
    expect(s.discard).toHaveBeenCalledExactlyOnceWith(STAGING);
    expect(result.current.prepared).toBeNull();
  });

  it('renews after a Save without discarding what the bridge consumed', async () => {
    const s = source(async () => sampleProfile);
    const { result } = renderHook(() => useRevisionStaging('agent_p', true), { wrapper: wrap(s) });
    await waitFor(() => expect(result.current.prepared).not.toBeNull());
    act(() => result.current.renew());
    await waitFor(() => expect(s.prepare).toHaveBeenCalledTimes(2));
    expect(s.discard).not.toHaveBeenCalled();
    await waitFor(() => expect(result.current.prepared).not.toBeNull());
  });

  it('discards a staging that arrives after the dialog closed', async () => {
    let settle: (value: PreparedRevision) => void = () => {};
    const prepare = vi.fn(() => new Promise<PreparedRevision>((resolve) => { settle = resolve; }));
    const s = source(async () => sampleProfile, { prepare });
    const { unmount } = renderHook(() => useRevisionStaging('agent_p', true), { wrapper: wrap(s) });
    unmount();
    expect(s.discard).not.toHaveBeenCalled();
    settle(samplePreparedRevision);
    await waitFor(() => expect(s.discard).toHaveBeenCalledExactlyOnceWith(STAGING));
  });

  it('keeps the engine\'s refusal, and has nothing to discard for it', async () => {
    const s = source(async () => sampleProfile, { prepare: vi.fn(async () => { throw new BridgeError('soul-state-missing', 'launch it once'); }) });
    const { result, unmount } = renderHook(() => useRevisionStaging('agent_p', true), { wrapper: wrap(s) });
    await waitFor(() => expect(result.current.error).toBe('launch it once'));
    expect(result.current.prepared).toBeNull();
    unmount();
    expect(s.discard).not.toHaveBeenCalled();
  });

  it('asks nothing without a source', () => {
    const { result } = renderHook(() => useRevisionStaging('agent_p', true), { wrapper: wrap(null) });
    expect(result.current.prepared).toBeNull();
    expect(result.current.error).toBeNull();
  });
});
