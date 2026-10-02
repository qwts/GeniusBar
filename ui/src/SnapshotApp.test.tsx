import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { sampleCensus } from './model/fixtures';
import { SnapshotApp } from './SnapshotApp';

afterEach(cleanup);

describe('SnapshotApp', () => {
  it('renders one census with the requested detail open, then delivers once', async () => {
    const deliver = vi.fn();
    render(<SnapshotApp options={{ detail: 'agent_c' }} fetchOnce={async () => ({ ok: true, souls: sampleCensus })} deliver={deliver} />);
    expect(await screen.findByRole('dialog', { name: 'agent_c, agent_c' })).toBeTruthy();
    await waitFor(() => expect(deliver).toHaveBeenCalledWith(3, null));
    expect(deliver).toHaveBeenCalledOnce();
  });

  it('still renders what the popup would show when the broker fails', async () => {
    const deliver = vi.fn();
    render(<SnapshotApp options={{ detail: null }} deliver={deliver}
      fetchOnce={async () => ({ ok: false, code: 'unauthenticated', message: 'not paired' })} />);
    await waitFor(() => expect(deliver).toHaveBeenCalledWith(0, 'unauthenticated: not paired'));
    expect(screen.getByRole('heading', { name: 'GeniusBar' })).toBeTruthy();
  });
});
