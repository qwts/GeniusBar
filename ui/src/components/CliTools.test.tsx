import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { CliTools, type ToolsStatus } from './CliTools';

afterEach(cleanup);

const dir = '/Users/me/.local/bin';
const status = (bot: ToolsStatus['tools'][number], comms: ToolsStatus['tools'][number]): ToolsStatus => ({ dir, tools: [bot, comms] });
const installed = status({ name: 'agent-bot', state: 'installed' }, { name: 'agent-comms', state: 'installed' });

describe('CliTools', () => {
  it('shows another copy and replaces it only from the explicit button', async () => {
    const brew = '/opt/homebrew/opt/agent-bot/bin/agent-bot';
    const api = {
      status: vi.fn(async () => status({ name: 'agent-bot', state: 'other', target: brew }, { name: 'agent-comms', state: 'absent' })),
      install: vi.fn(async () => installed),
      uninstall: vi.fn(async () => installed),
    };
    render(<CliTools api={api} />);
    fireEvent.click(screen.getByRole('button', { name: 'Command-line tools…' }));
    await screen.findByText(brew);
    expect(screen.getByText(/Installing replaces agent-bot/)).toBeTruthy();
    expect(api.install).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Replace and install' }));
    await waitFor(() => expect(api.install).toHaveBeenCalledWith(['agent-bot']));
    await screen.findByRole('button', { name: 'Uninstall' });
    expect(screen.queryByRole('button', { name: /^(Install|Replace and install)$/ })).toBeNull();
  });

  it('reports a failure', async () => {
    const api = {
      status: vi.fn(async () => { throw { code: 'tools-unavailable', message: 'no node' }; }),
      install: vi.fn(),
      uninstall: vi.fn(),
    };
    render(<CliTools api={api} />);
    fireEvent.click(screen.getByRole('button', { name: 'Command-line tools…' }));
    expect((await screen.findByRole('alert')).textContent).toBe('no node');
  });
});
