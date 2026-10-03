import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { idleSetup } from '../model/setup';
import { SetupPanel } from './SetupPanel';

afterEach(cleanup);

describe('SetupPanel', () => {
  it('lists the steps and starts setup on click', () => {
    const onSetup = vi.fn();
    render(<SetupPanel setup={idleSetup} onSetup={onSetup} />);
    expect(screen.getAllByRole('listitem')).toHaveLength(4);
    expect(screen.getByText('Let’s connect GeniusBar to your account.')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Set up' }));
    expect(onSetup).toHaveBeenCalledOnce();
  });

  it('disables the button while running and offers a retry after an error', () => {
    const { rerender } = render(<SetupPanel setup={{ ...idleSetup, running: true }} onSetup={() => {}} />);
    expect((screen.getByRole('button') as HTMLButtonElement).disabled).toBe(true);
    rerender(<SetupPanel setup={{ ...idleSetup, error: 'broker did not start' }} onSetup={() => {}} />);
    expect(screen.getByRole('alert').textContent).toBe('broker did not start');
    expect(screen.getByRole('button', { name: 'Try again' })).toBeTruthy();
  });
});

describe('SetupPanel with another install running', () => {
  const existing = {
    broker: { label: 'dev.qwts.agent-comms.broker', program: [], version: '0.3.1', homebrew: true },
    daemon: { label: 'dev.qwts.agent-bot.daemon', program: [], version: null, homebrew: true },
  };

  it('names what runs and lets the owner move it over or keep it', () => {
    const onSetup = vi.fn();
    render(<SetupPanel setup={idleSetup} onSetup={onSetup} existing={existing} />);
    expect(screen.getByRole('note').textContent).toMatch(/^agent-comms 0\.3\.1 and agent-bot from Homebrew is already running/);
    fireEvent.click(screen.getByRole('button', { name: 'Move to GeniusBar' }));
    expect(onSetup).toHaveBeenLastCalledWith(true);
    fireEvent.click(screen.getByRole('button', { name: 'Keep them' }));
    expect(onSetup).toHaveBeenLastCalledWith(false);
  });

  it('shows the plain setup when nothing else runs', () => {
    render(<SetupPanel setup={idleSetup} onSetup={() => {}} existing={{ broker: null, daemon: null }} />);
    expect(screen.queryByRole('note')).toBeNull();
    expect(screen.getByRole('button', { name: 'Set up' })).toBeTruthy();
  });
});
