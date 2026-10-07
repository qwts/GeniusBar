import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { RemoveServices } from './RemoveServices';

afterEach(cleanup);

describe('RemoveServices look (P16)', () => {
  it('asks in a destructive card with shadcn buttons, and says why it failed', async () => {
    const onRemove = vi.fn(async () => { throw new Error('launchctl refused'); });
    render(<RemoveServices onRemove={onRemove} />);
    const link = screen.getByRole('button', { name: 'Remove services…' });
    expect(link.className.split(' ')).not.toContain('link');
    fireEvent.click(link);
    const group = screen.getByRole('group', { name: 'Remove services' });
    expect(group.className.split(' ')).not.toContain('confirm');
    expect(group.querySelector('.small, .error, .detail-actions')).toBeNull();
    expect(screen.getByRole('button', { name: 'Cancel' }).className).toContain('bg-secondary');
    const go = screen.getByRole('button', { name: /^Remove/ });
    expect(go.className).toContain('bg-destructive');
    fireEvent.click(go);
    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toBe('launchctl refused');
    expect(alert.className).toContain('text-destructive');
  });

  it('says it is done when there is no menu to close', async () => {
    render(<RemoveServices onRemove={vi.fn(async () => {})} startConfirming />);
    fireEvent.click(screen.getByRole('button', { name: /^Remove/ }));
    await waitFor(() => expect(screen.getByRole('status').className).toContain('text-muted-foreground'));
  });
});
