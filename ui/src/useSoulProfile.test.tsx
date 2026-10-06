import { renderHook, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { BridgeError, type SoulProfile } from './bridge';
import { sampleProfile } from './model/fixtures';
import { ProfileSourceContext, useSoulProfile, type ProfileSource } from './useSoulProfile';

const wrap = (source: ProfileSource | null) => ({ children }: { children: ReactNode }) => (
  <ProfileSourceContext.Provider value={source}>{children}</ProfileSourceContext.Provider>
);
const source = (profile: ProfileSource['profile']): ProfileSource => ({ profile, file: vi.fn() });

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
