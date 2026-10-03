import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { buildSoulForest } from '../model/census';
import { emptyComposer } from '../model/chat';
import { sampleCensus } from '../model/fixtures';
import { CompanionDetails, CompanionSession } from './CompanionSession';

afterEach(cleanup);

const [luna, child] = sampleCensus;
const forest = buildSoulForest(sampleCensus);

function field(term: string): string | null {
  const dt = screen.getByText(term, { selector: 'dt' });
  return dt.nextElementSibling?.textContent ?? null;
}

describe('CompanionDetails', () => {
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
    fireEvent.keyDown(screen.getByRole('tab', { name: 'Chat' }), { key: 'ArrowRight' });
    expect(document.activeElement).toBe(screen.getByRole('tab', { name: 'Delegation' }));
    expect(screen.getByRole('tabpanel').textContent).toContain('luna');
    fireEvent.keyDown(screen.getByRole('tab', { name: 'Delegation' }), { key: 'ArrowRight' });
    expect(field('Account')).toBe('user');
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
