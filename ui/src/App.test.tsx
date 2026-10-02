import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { App } from './App';
import { sampleCensus, sampleConnection } from './model/fixtures';

afterEach(cleanup);

describe('App', () => {
  it('shows the header and an empty roster before the bridge connects', () => {
    render(<App />);
    expect(screen.getByRole('heading', { name: 'GeniusBar' })).toBeTruthy();
    expect(screen.getByRole('status').textContent).toMatch(/not connected/i);
    expect(screen.getByRole('region', { name: 'Souls' }).childElementCount).toBe(0);
  });

  it('renders the fixed fake census and health, nested, with every soul', () => {
    // SnapshotTests.rendersPNG: the populated roster must actually draw
    // rows that the same header with an empty roster does not.
    render(<App census={sampleCensus} connection={sampleConnection} isStatic />);
    expect(screen.getByRole('status', { name: /Broker healthy/ }).textContent).toContain(
      'uptime 12s · log 512 B · accounts 1 · principals 2 · watches 3',
    );
    const roster = screen.getByRole('region', { name: 'Souls' });
    expect(roster.querySelectorAll('button.soul-row')).toHaveLength(3);
    cleanup();
    render(<App connection={sampleConnection} isStatic />);
    expect(screen.getByRole('region', { name: 'Souls' }).textContent).toBe('No souls on this machine.');
  });

  it('opens the detail for a selected row and closes it with Done', () => {
    render(<App census={sampleCensus} connection={sampleConnection} isStatic />);
    fireEvent.click(screen.getByRole('button', { name: /^agent_c,/ }));
    expect(screen.getByRole('dialog', { name: 'agent_c, agent_c' })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Done' }));
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('keeps the last census on screen while the broker is unreachable', () => {
    const lastRefresh = new Date(2026, 0, 1, 12, 0, 1);
    const onRefresh = vi.fn();
    render(
      <App
        census={sampleCensus}
        connection={{ ...sampleConnection, brokerUnreachable: true, lastRefresh, lastError: 'cannot reach the broker' }}
        onRefresh={onRefresh}
        isStatic
      />,
    );
    expect(screen.getByRole('status').textContent).toContain('Broker unreachable');
    expect(screen.getAllByText(`Last known · ${lastRefresh.toLocaleTimeString()}`)).toHaveLength(2);
    expect(screen.getAllByRole('button', { name: /presence/ })).toHaveLength(3);
    fireEvent.click(screen.getByRole('button', { name: 'Refresh' }));
    expect(onRefresh).toHaveBeenCalledOnce();
  });
});
