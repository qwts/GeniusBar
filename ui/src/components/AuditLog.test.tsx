import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { exportAudit, listAudit, runtimeMetrics, soulComms } from '../bridge';
import { buildSoulForest } from '../model/census';
import { emptyComposer } from '../model/chat';
import { sampleAudit, sampleCensus } from '../model/fixtures';
import { AUDIT_REFRESH_MS, AuditLog, AuditSourceContext, type AuditSource } from './AuditLog';
import { CompanionSession } from './CompanionSession';

vi.mock('../bridge', () => ({ exportAudit: vi.fn(), listAudit: vi.fn(), runtimeMetrics: vi.fn(), soulComms: vi.fn(), setSoulComms: vi.fn() }));
beforeEach(() => {
  vi.mocked(listAudit).mockReset().mockResolvedValue(null);
  vi.mocked(exportAudit).mockReset().mockResolvedValue({ path: '/Users/me/Downloads/geniusbar-audit-x.json' });
  vi.mocked(runtimeMetrics).mockReset().mockResolvedValue({ unavailable: true });
  vi.mocked(soulComms).mockReset().mockResolvedValue(null);
});
afterEach(() => { cleanup(); vi.useRealTimers(); });

const withSource = (source: AuditSource, agentId: string | null = 'agent_p') => render(
  <AuditSourceContext.Provider value={source}><AuditLog agentId={agentId} roster={sampleCensus} /></AuditSourceContext.Provider>);

describe('AuditLog', () => {
  it('shows the records newest first in a table, names from the roster', async () => {
    const source = vi.fn<AuditSource>().mockResolvedValue([...sampleAudit]);
    withSource(source, null);
    expect(screen.getByRole('status').textContent).toBe('Reading the audit log…');
    const table = await screen.findByRole('table', { name: 'Audit log' });
    expect(source).toHaveBeenCalledWith(null);
    expect(within(table).getAllByRole('columnheader').map((h) => h.textContent)).toEqual(['Time', 'Companion', 'Event', 'Detail']);
    const rows = within(table).getAllByRole('row').slice(1);
    expect(rows).toHaveLength(6);
    expect(within(rows[0]).getAllByRole('cell').slice(1).map((c) => c.textContent))
      .toEqual(['luna', 'permission · allow', 'Bash: npm test']);
    expect(within(rows[5]).getAllByRole('cell')[1].textContent).toBe('agent_c');
    expect(screen.getByRole('button', { name: 'Export JSON' }).hasAttribute('disabled')).toBe(false);
  });

  it('says when nothing is recorded, with Export disabled', async () => {
    withSource(async () => []);
    expect(await screen.findByText('Nothing recorded yet.')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Export JSON' }).hasAttribute('disabled')).toBe(true);
    expect(screen.getByRole('button', { name: 'Copy JSON' }).hasAttribute('disabled')).toBe(true);
  });

  it('waits calmly for an agent-bot that cannot list the log yet', async () => {
    withSource(async () => null);
    expect(await screen.findByText('The audit log arrives with the next agent-bot update.')).toBeTruthy();
    expect(screen.queryByRole('table')).toBeNull();
    expect(screen.getByRole('button', { name: 'Export JSON' }).hasAttribute('disabled')).toBe(true);
  });

  it('saves the shown records as a JSON file through the bridge, as the design, and says so', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
    withSource(async () => sampleAudit.slice(0, 2));
    fireEvent.click(await screen.findByRole('button', { name: 'Export JSON' }));
    expect((await screen.findByRole('status')).textContent).toBe('Saved to Downloads');
    expect(exportAudit).toHaveBeenCalledTimes(1);
    expect(JSON.parse(vi.mocked(exportAudit).mock.calls[0][0])).toEqual([sampleAudit[1], sampleAudit[0]]);
    expect(writeText).not.toHaveBeenCalled();
  });

  it('says when the file could not be saved', async () => {
    vi.mocked(exportAudit).mockRejectedValueOnce(new Error('disk full'));
    withSource(async () => sampleAudit.slice(0, 2));
    fireEvent.click(await screen.findByRole('button', { name: 'Export JSON' }));
    const status = await screen.findByText('Couldn’t save the audit log.');
    expect(status.getAttribute('role')).toBe('status');
    expect(status.className).toContain('text-destructive');
  });

  it('still copies the shown records as JSON with Copy JSON, and says so', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
    withSource(async () => sampleAudit.slice(0, 2));
    fireEvent.click(await screen.findByRole('button', { name: 'Copy JSON' }));
    expect(await screen.findByText('Copied')).toBeTruthy();
    expect(JSON.parse(writeText.mock.calls[0][0])).toEqual([sampleAudit[1], sampleAudit[0]]);
    expect(exportAudit).not.toHaveBeenCalled();
    writeText.mockRejectedValueOnce(new Error('denied'));
    fireEvent.click(screen.getByRole('button', { name: 'Copy JSON' }));
    expect(await screen.findByText('Couldn’t copy the audit log.')).toBeTruthy();
  });

  it('refreshes every 10 s while shown, keeps the last list on a failed read, and stops once unmounted', async () => {
    vi.useFakeTimers();
    const source = vi.fn<AuditSource>().mockResolvedValueOnce(sampleAudit.slice(0, 1)).mockResolvedValueOnce(null)
      .mockResolvedValue(sampleAudit.slice(0, 2));
    const view = withSource(source);
    await act(async () => {});
    expect(screen.getAllByRole('row')).toHaveLength(2);
    await act(async () => { await vi.advanceTimersByTimeAsync(AUDIT_REFRESH_MS); });
    expect(source).toHaveBeenCalledTimes(2);
    expect(screen.getAllByRole('row')).toHaveLength(2);
    await act(async () => { await vi.advanceTimersByTimeAsync(AUDIT_REFRESH_MS); });
    expect(screen.getAllByRole('row')).toHaveLength(3);
    view.unmount();
    await act(async () => { await vi.advanceTimersByTimeAsync(AUDIT_REFRESH_MS * 3); });
    expect(source).toHaveBeenCalledTimes(3);
  });
});

describe('the Audit log tab', () => {
  const [luna, child] = sampleCensus;
  const forest = buildSoulForest(sampleCensus);
  const chat = { entries: [], composer: emptyComposer, onDraft: () => {}, onSend: () => {} };

  it('sits before Details, as the design orders the tabs, and reads only that companion’s records once opened', async () => {
    vi.mocked(listAudit).mockResolvedValue(sampleAudit.filter((r) => r.agentId === child.agentId));
    render(<CompanionSession soul={child} forest={forest} roster={sampleCensus} paused chat={chat} onOpen={() => {}} onClose={() => {}} />);
    expect(screen.getAllByRole('tab').map((tab) => tab.textContent)).toEqual(['Chat', 'Delegation', 'Memory', 'Audit log', 'Details']);
    expect(listAudit).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('tab', { name: 'Audit log' }));
    await waitFor(() => expect(screen.getAllByRole('row')).toHaveLength(3));
    expect(listAudit).toHaveBeenCalledWith(child.agentId);
  });

  it('keeps the design order without chat', () => {
    render(<CompanionSession soul={luna} forest={forest} roster={sampleCensus} paused onOpen={() => {}} onClose={() => {}} />);
    expect(screen.getAllByRole('tab').map((tab) => tab.textContent)).toEqual(['Delegation', 'Memory', 'Audit log', 'Details']);
  });
});
