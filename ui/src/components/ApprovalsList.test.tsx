import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { menuApprovals } from '../model/approvals';
import { sampleApprovals, sampleCensus } from '../model/fixtures';
import { ApprovalCounts, ApprovalsList } from './ApprovalsList';

afterEach(cleanup);

const items = menuApprovals(sampleApprovals, new Map(), sampleCensus);

describe('ApprovalsList', () => {
  it('renders nothing while nothing waits', () => {
    const { container } = render(<ApprovalsList items={[]} paused onOpen={vi.fn()} onDecide={vi.fn()} />);
    expect(container.firstChild).toBeNull();
  });

  it('shows one card per proposal, oldest first, as an alert', () => {
    render(<ApprovalsList items={items} paused onOpen={vi.fn()} onDecide={vi.fn()} />);
    const section = screen.getByRole('alert', { name: 'Waiting for your approval' });
    const cards = within(section).getAllByRole('listitem');
    expect(cards).toHaveLength(2);
    expect(cards[0].textContent).toContain('luna· Bash');
    expect(cards[0].textContent).toContain('git push origin main');
    expect(cards[1].textContent).toContain('agent_c· terminal');
    expect(cards[1].querySelector('code')?.textContent).toBe("psql -c 'VACUUM FULL ledger'");
  });

  it('approves, denies and opens the companion with keyboard-reachable buttons', () => {
    const onDecide = vi.fn();
    const onOpen = vi.fn();
    render(<ApprovalsList items={items} paused onOpen={onOpen} onDecide={onDecide} />);
    const approve = screen.getByRole('button', { name: 'Approve Bash for luna' });
    approve.focus();
    expect(document.activeElement).toBe(approve);
    fireEvent.click(approve);
    fireEvent.click(screen.getByRole('button', { name: 'Deny terminal for agent_c' }));
    expect(onDecide.mock.calls).toEqual([['prop_1', 'approve'], ['prop_2', 'deny']]);
    fireEvent.click(screen.getByRole('button', { name: 'Open chat with luna' }));
    expect(onOpen).toHaveBeenCalledWith(sampleCensus[0]);
  });

  it('shows a decision in flight and a failed one', () => {
    render(<ApprovalsList items={[{ ...items[0], deciding: true }, { ...items[1], error: 'the owner did not confirm' }]}
      paused onOpen={vi.fn()} onDecide={vi.fn()} />);
    expect(screen.getByRole('button', { name: 'Approve Bash for luna' })).toHaveProperty('disabled', true);
    expect(screen.getByRole('status').textContent).toBe('Confirm on this Mac to finish…');
    expect(screen.getByText('Not decided: the owner did not confirm')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Approve terminal for agent_c' })).toHaveProperty('disabled', false);
  });

  it('cannot act without agent-bot, and a companion missing from the census is not a link', () => {
    render(<ApprovalsList items={[{ ...items[0], soul: null }]} paused onOpen={vi.fn()} />);
    expect(screen.getByRole('button', { name: 'Approve Bash for luna' })).toHaveProperty('disabled', true);
    expect(screen.queryByRole('button', { name: 'Open chat with luna' })).toBeNull();
  });
});

describe('ApprovalCounts', () => {
  it('shows the counts, and nothing when both are zero', () => {
    const { container, rerender } = render(<ApprovalCounts waiting={0} working={0} />);
    expect(container.firstChild).toBeNull();
    rerender(<ApprovalCounts waiting={2} working={0} />);
    expect(container.textContent).toBe('2 waiting on you· 0 working');
  });
});
