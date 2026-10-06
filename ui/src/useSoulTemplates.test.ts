import { renderHook, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { BridgeError, type SoulTemplateList } from './bridge';
import { useSoulTemplates } from './useSoulTemplates';

const listing: SoulTemplateList = {
  templates: [{ name: 'Coder', description: 'Writes code.', preferredHarnesses: ['claude'], defaultHarness: 'claude',
    package: '/souls/Coder.soul', revision: null, source: 'souls-root' }],
  soulsRoot: '/souls',
  errors: [],
};

describe('useSoulTemplates (#65)', () => {
  it('lists the templates once', async () => {
    const lister = vi.fn(async () => listing);
    const { result, rerender } = renderHook(() => useSoulTemplates(lister));
    expect(result.current).toEqual({ templates: [], supported: false, error: null });
    await waitFor(() => expect(result.current.supported).toBe(true));
    expect(result.current.templates.map((t) => t.name)).toEqual(['Coder']);
    expect(result.current.error).toBeNull();
    rerender();
    expect(lister).toHaveBeenCalledOnce();
  });

  it('reports packages agent-bot could not read beside the listing', async () => {
    const lister = async () => ({ ...listing, errors: [{ package: '/souls/Bad.soul', message: 'soul.json is missing' }] });
    const { result } = renderHook(() => useSoulTemplates(lister));
    await waitFor(() => expect(result.current.supported).toBe(true));
    expect(result.current.error).toBe('/souls/Bad.soul: soul.json is missing');
  });

  it('is unsupported, without an error, on an older agent-bot', async () => {
    const lister = vi.fn(async (): Promise<SoulTemplateList> => { throw new BridgeError('soul-templates-unsupported', 'no soul templates'); });
    const { result } = renderHook(() => useSoulTemplates(lister));
    await waitFor(() => expect(lister).toHaveBeenCalled());
    await Promise.resolve();
    expect(result.current).toEqual({ templates: [], supported: false, error: null });
  });

  it('keeps the failure of a listing that broke', async () => {
    const lister = async (): Promise<SoulTemplateList> => { throw new BridgeError('soul-templates-failed', 'EACCES'); };
    const { result } = renderHook(() => useSoulTemplates(lister));
    await waitFor(() => expect(result.current.error).toBe('EACCES'));
    expect(result.current.supported).toBe(false);
  });

  it('asks nothing without a lister', () => {
    const { result } = renderHook(() => useSoulTemplates(undefined));
    expect(result.current).toEqual({ templates: [], supported: false, error: null });
  });
});
