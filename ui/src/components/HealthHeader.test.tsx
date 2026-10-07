import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { disconnected } from '../model/status';
import { SetupHeader } from './HealthHeader';

afterEach(cleanup);

const NEEDS = 'GeniusBar needs setup on this device. Choose Set up below.';

describe('SetupHeader phases (P2)', () => {
  it('says what GeniusBar needs only in the needs phase', () => {
    render(<SetupHeader connection={{ ...disconnected, bridgeConnected: true, unpaired: true }} running={false} />);
    expect(screen.getByText(NEEDS)).toBeTruthy();
  });

  it('says it is checking, without the needs line, before anything is known', () => {
    render(<SetupHeader connection={{ ...disconnected, bridgeConnected: true }} running={false} />);
    expect(screen.getByRole('status').textContent).toBe('Checking connection…');
    expect(screen.queryByText(NEEDS)).toBeNull();
  });

  it('says setting up while it runs, without the needs line, and keeps a failure', () => {
    render(<SetupHeader connection={{ ...disconnected, bridgeConnected: true, unpaired: true }} running error="broker did not start" />);
    expect(screen.getByRole('status', { name: 'Setting up…' })).toBeTruthy();
    expect(screen.queryByText(NEEDS)).toBeNull();
    expect(screen.getByRole('alert').textContent).toBe('broker did not start');
  });
});
