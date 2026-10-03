import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { runtimeMetrics, type RuntimeMetrics } from '../bridge';
import { buildSoulForest } from '../model/census';
import { emptyComposer } from '../model/chat';
import { sampleCensus } from '../model/fixtures';
import { CompanionDetails, CompanionSession } from './CompanionSession';

afterEach(cleanup);
vi.mock('../bridge', () => ({ runtimeMetrics: vi.fn() }));
beforeEach(() => {
  vi.mocked(runtimeMetrics).mockReset().mockResolvedValue({ unavailable: true });
});

const [luna, child] = sampleCensus;
const forest = buildSoulForest(sampleCensus);
const observedAt = new Date(Date.now() - 120_000).toISOString();
const metrics: RuntimeMetrics = {
  collectedAt: observedAt,
  souls: {
    [child.agentId]: {
      lastCallAt: observedAt,
      observations: [
        { metric: 'model_reported', value: 'claude-sonnet-4-6', unit: 'model', scope: 'main', source: 'claude', kind: 'reported', observedAt },
        { metric: 'context_used_tokens', value: 12345, unit: 'tokens', scope: 'main', source: 'claude', kind: 'reported', method: 'last-call-usage', observedAt },
      ],
    },
  },
  errors: [],
  missing: [],
};

function field(term: string): string | null {
  const dt = screen.getByText(term, { selector: 'dt' });
  return dt.nextElementSibling?.textContent ?? null;
}

describe('CompanionDetails', () => {
  it('shows model and context with their observation ages, without changing presence', async () => {
    vi.mocked(runtimeMetrics).mockResolvedValue(metrics);
    render(<CompanionDetails soul={child} />);
    await screen.findByText('claude-sonnet-4-6');
    expect(field('Model')).toBe('claude-sonnet-4-6from claude, 2 minutes ago');
    expect(field('Context')).toBe('12,345 tokensfrom claude, 2 minutes ago');
    expect(field('Presence')).toBe('watching');
    expect(runtimeMetrics).toHaveBeenCalledOnce();
  });

  it.each<RuntimeMetrics>([{ unavailable: true }, { collectedAt: observedAt, souls: {}, errors: [], missing: [{ agentId: child.agentId, source: 'claude' }] }])(
    'omits metrics when unavailable or the soul has no entry (%j)', async (result) => {
      vi.mocked(runtimeMetrics).mockResolvedValue(result);
      render(<CompanionDetails soul={child} />);
      await waitFor(() => expect(runtimeMetrics).toHaveBeenCalledOnce());
      expect(screen.queryByText('Model')).toBeNull();
      expect(screen.queryByText('Context')).toBeNull();
      expect(screen.queryByText(/from claude/)).toBeNull();
      expect(screen.queryByText(/Metrics collector/)).toBeNull();
    },
  );

  it('shows a muted collector error only for this soul, even without observations', async () => {
    vi.mocked(runtimeMetrics).mockResolvedValue({
      collectedAt: observedAt, souls: {}, missing: [],
      errors: [
        { agentId: child.agentId, source: 'claude', code: 'read-failed', message: 'Could not read session' },
        { agentId: luna.agentId, source: 'claude', code: 'read-failed', message: 'Another soul error' },
      ],
    });
    render(<CompanionDetails soul={child} />);
    const error = await screen.findByText('Metrics collector (claude): Could not read session');
    expect(error.className).toContain('text-muted-foreground');
    expect(screen.queryByText(/Another soul error/)).toBeNull();
    expect(field('Presence')).toBe('watching');
  });

  it('refreshes on request and soul changes, ignoring a late reply for the previous soul', async () => {
    let resolve!: (value: RuntimeMetrics) => void;
    vi.mocked(runtimeMetrics).mockImplementationOnce(() => new Promise((done) => { resolve = done; }));
    const { rerender } = render(<CompanionDetails soul={child} />);
    rerender(<CompanionDetails soul={luna} />);
    resolve(metrics);
    await waitFor(() => expect(runtimeMetrics).toHaveBeenCalledTimes(2));
    expect(screen.queryByText('Model')).toBeNull();
    rerender(<CompanionDetails soul={luna} metricsRefresh={1} />);
    await waitFor(() => expect(runtimeMetrics).toHaveBeenCalledTimes(3));
    rerender(<CompanionDetails soul={{ ...luna }} metricsRefresh={1} />);
    expect(runtimeMetrics).toHaveBeenCalledTimes(3);
  });

  it('lists the read-only fields with roster fallbacks', () => {
    render(<CompanionDetails soul={child} roster={sampleCensus} />);
    expect(field('Account')).toBe('user');
    expect(field('Harness')).toBe('unknown harness');
    expect(field('Presence')).toBe('watching');
    expect(field('Parent')).toBe('lunaagent_p');
    expect(field('Unacked')).toBe('3');
    expect(field('Last wake')).toBe('none');
    // Principal-client fields appear only when the row carries them.
    expect(screen.queryByText('Hardened')).toBeNull();
  });

  it('falls back to the raw parent ID without a roster, and none for roots', () => {
    render(<CompanionDetails soul={child} />);
    expect(field('Parent')).toBe('agent_p');
    cleanup();
    render(<CompanionDetails soul={luna} />);
    expect(field('Parent')).toBe('none');
    expect(field('Verification')).toBe('verified');
    expect(field('Hardened')).toBe('yes');
    expect(field('Daemon watching')).toBe('yes');
  });
});

describe('CompanionSession', () => {
  const chat = { entries: [], composer: emptyComposer, onDraft: () => {}, onSend: () => {} };

  it('opens on the chat, and moves between tabs with the arrow keys', () => {
    render(<CompanionSession soul={child} forest={forest} roster={sampleCensus} paused chat={chat} onOpen={() => {}} onClose={() => {}} />);
    const session = screen.getByRole('region', { name: 'agent_c, agent_c' });
    expect(within(session).getByRole('img', { name: 'Avatar for agent_c' })).toBeTruthy();
    expect(screen.getByRole('tab', { name: 'Chat' }).getAttribute('aria-selected')).toBe('true');
    expect(screen.getByRole('textbox', { name: 'Message to agent_c' })).toBeTruthy();
    expect(runtimeMetrics).not.toHaveBeenCalled();
    fireEvent.keyDown(screen.getByRole('tab', { name: 'Chat' }), { key: 'ArrowRight' });
    expect(document.activeElement).toBe(screen.getByRole('tab', { name: 'Delegation' }));
    expect(screen.getByRole('tabpanel').textContent).toContain('luna');
    fireEvent.keyDown(screen.getByRole('tab', { name: 'Delegation' }), { key: 'ArrowRight' });
    expect(field('Account')).toBe('user');
    expect(runtimeMetrics).toHaveBeenCalledOnce();
  });

  it('opens on the details without chat', () => {
    render(<CompanionSession soul={luna} forest={forest} roster={sampleCensus} paused onOpen={() => {}} onClose={() => {}} />);
    expect(screen.queryByRole('tab', { name: 'Chat' })).toBeNull();
    expect(field('Harness')).toBe('codex');
  });

  it('opens another companion from the delegation tree, the current one marked', () => {
    const onOpen = vi.fn();
    render(<CompanionSession soul={child} forest={forest} roster={sampleCensus} paused onOpen={onOpen} onClose={() => {}} />);
    fireEvent.click(screen.getByRole('tab', { name: 'Delegation' }));
    const tree = screen.getByRole('list', { name: 'Delegation' });
    expect(within(tree).getByRole('button', { current: true }).textContent).toContain('agent_c');
    fireEvent.click(within(tree).getByRole('button', { name: /luna/ }));
    expect(onOpen).toHaveBeenCalledWith(luna);
  });

  it('focuses Back in the popup, which closes it, as does Escape', () => {
    const onClose = vi.fn();
    render(<CompanionSession soul={luna} forest={forest} roster={sampleCensus} paused onOpen={() => {}} onClose={onClose} showBack />);
    const back = screen.getByRole('button', { name: 'Back to fleet' });
    expect(document.activeElement).toBe(back);
    fireEvent.click(back);
    fireEvent.keyDown(back, { key: 'Escape' });
    expect(onClose).toHaveBeenCalledTimes(2);
  });
});
