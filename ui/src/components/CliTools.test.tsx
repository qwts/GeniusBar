import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { I18nProvider } from '../lib/i18n';
import { CliTools, type ToolsStatus } from './CliTools';

afterEach(() => { cleanup(); localStorage.clear(); });

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


describe('CliTools in Spanish', () => {
  it('translates replacement, tool states and PATH copy and restores the other copy on uninstall', async () => {
    localStorage.setItem('gb.lang', 'es');
    const other = { name: 'agent-bot', state: 'other' as const, target: '/opt/homebrew/bin/agent-bot' };
    const before = { ...status(other, { name: 'agent-comms', state: 'stale' }), path: { onPath: false, profile: null } };
    const after = { ...installed, path: { onPath: false, profile: '/Users/me/.zprofile' } };
    const api = { status: vi.fn(async () => before), install: vi.fn(async () => after), uninstall: vi.fn(async () => before) };
    render(<I18nProvider><CliTools api={api} /></I18nProvider>);
    fireEvent.click(screen.getByRole('button', { name: 'Herramientas de línea de comandos…' }));
    await screen.findByText(/La instalación reemplaza agent-bot/);
    expect(screen.getByText(/instalado desde una copia anterior/)).toBeTruthy();
    expect(screen.getByRole('group', { name: 'Herramientas de línea de comandos' }).textContent).toContain(`Se instalan en ${dir}.`);
    expect(api.install).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Reemplazar e instalar' }));
    await screen.findByText(/Abre una nueva terminal/);
    expect(api.install).toHaveBeenCalledWith(['agent-bot']);
    expect(screen.getByText(`Añade ${dir} a tu PATH para que la terminal las encuentre.`)).toBeTruthy();
    expect(screen.getAllByText(/instalado desde GeniusBar/)).toHaveLength(2);
    fireEvent.click(screen.getByRole('button', { name: 'Desinstalar' }));
    await screen.findByText(other.target);
    expect(api.uninstall).toHaveBeenCalledOnce();
    fireEvent.click(screen.getByRole('button', { name: 'Cerrar' }));
    expect(screen.queryByRole('group')).toBeNull();
  });

  it('translates missing tools and fallback errors for each action', async () => {
    localStorage.setItem('gb.lang', 'es');
    const api = {
      status: vi.fn(async () => status({ name: 'agent-bot', state: 'installed' }, { name: 'agent-comms', state: 'absent' })),
      install: vi.fn(async () => { throw {}; }),
      uninstall: vi.fn(async () => { throw {}; }),
    };
    render(<I18nProvider><CliTools api={api} /></I18nProvider>);
    fireEvent.click(screen.getByRole('button', { name: 'Herramientas de línea de comandos…' }));
    await screen.findByText(/sin instalar/);
    fireEvent.click(screen.getByRole('button', { name: 'Instalar' }));
    expect((await screen.findByRole('alert')).textContent).toBe('No se pudieron instalar las herramientas de línea de comandos.');
    expect(api.install).toHaveBeenCalledWith([]);
    fireEvent.click(screen.getByRole('button', { name: 'Desinstalar' }));
    await waitFor(() => expect(screen.getByRole('alert').textContent).toBe('No se pudieron desinstalar las herramientas de línea de comandos.'));
    fireEvent.click(screen.getByRole('button', { name: 'Cerrar' }));
    api.status.mockRejectedValueOnce({});
    fireEvent.click(screen.getByRole('button', { name: 'Herramientas de línea de comandos…' }));
    await waitFor(() => expect(screen.getByRole('alert').textContent).toBe('No se pudieron comprobar las herramientas de línea de comandos.'));
  });
});
