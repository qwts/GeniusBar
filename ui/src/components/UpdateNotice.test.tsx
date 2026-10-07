import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { I18nProvider } from '../lib/i18n';
import { UpdateNotice } from './UpdateNotice';
import type { UpdateState } from '../model/updates';

afterEach(() => { cleanup(); localStorage.clear(); });

describe('UpdateNotice', () => {
  it('stays hidden for quiet states', () => {
    for (const state of ['disabled', 'idle', 'checking', 'up-to-date'] as UpdateState[]) {
      const { container } = render(<UpdateNotice status={{ state, version: null }} onAction={() => {}} />);
      expect(container.firstChild).toBeNull();
      cleanup();
    }
  });

  it('offers install and restart to finish, each with the version', () => {
    const act = vi.fn();
    render(<UpdateNotice status={{ state: 'available', version: '0.1.1' }} onAction={act} />);
    expect(screen.getByRole('status').textContent).toContain('GeniusBar 0.1.1 is available.');
    fireEvent.click(screen.getByRole('button', { name: 'Install and restart' }));
    expect(act).toHaveBeenCalledOnce();
    cleanup();
    render(<UpdateNotice status={{ state: 'ready-to-restart', version: '0.1.1' }} onAction={act} />);
    expect(screen.getByRole('status').textContent).toContain('GeniusBar 0.1.1 is installed.');
    fireEvent.click(screen.getByRole('button', { name: 'Restart to finish' }));
    expect(act).toHaveBeenCalledTimes(2);
  });

  it('shows installing without an action and failure as an alert', () => {
    render(<UpdateNotice status={{ state: 'installing', version: '0.1.1' }} onAction={() => {}} />);
    expect(screen.getByRole('status').textContent).toMatch(/Installing GeniusBar 0\.1\.1…/);
    expect(screen.queryByRole('button')).toBeNull();
    cleanup();
    render(<UpdateNotice status={{ state: 'failed', version: null }} onAction={() => {}} />);
    expect(screen.getByRole('alert').textContent).toMatch(/Update failed/);
    expect(screen.getByRole('button', { name: 'Try again' })).toBeTruthy();
  });

  it('says up to date only after the owner checked (T18), and names the line in the language shown (P15)', () => {
    render(<UpdateNotice status={{ state: 'up-to-date', version: null }} onAction={() => {}} checked />);
    const line = screen.getByRole('status', { name: 'Update' });
    expect(line.textContent).toBe('GeniusBar is up to date.');
    cleanup();
    localStorage.setItem('gb.lang', 'es');
    render(<I18nProvider><UpdateNotice status={{ state: 'available', version: '0.2.0' }} onAction={() => {}} /></I18nProvider>);
    expect(screen.getByRole('status', { name: 'Actualización' })).toBeTruthy();
  });

  it('uses the token classes, not the old update / link / small ones', () => {
    render(<UpdateNotice status={{ state: 'failed', version: null }} onAction={() => {}} />);
    const line = screen.getByRole('alert');
    expect(line.className.split(' ')).not.toContain('update');
    expect(line.querySelector('.small, .link, .error')).toBeNull();
    expect(screen.getByRole('button', { name: 'Try again' }).className).toContain('text-info');
  });
});
