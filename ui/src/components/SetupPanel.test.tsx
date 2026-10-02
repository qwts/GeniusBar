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
