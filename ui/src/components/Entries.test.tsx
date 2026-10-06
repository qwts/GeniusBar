import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { AgentAside, MessageBody, ToolApprovalCard, ToolCard } from './Entries';

afterEach(cleanup);

describe('ToolCard', () => {
  it('opens its output and diff from the keyboard-operable header', () => {
    render(<ToolCard e={{ id: 't', kind: 'tool_call', tool: 'edit_file', args: 'src/a.ts', status: 'success', output: 'Edited 2 lines',
      diff: '-old\n+new', at: 1, seq: null }} />);
    const header = screen.getByRole('button', { name: 'Tool call: edit_file — Done' });
    expect(header.getAttribute('aria-expanded')).toBe('false');
    expect(screen.queryByText('Edited 2 lines')).toBeNull();
    fireEvent.click(header);
    expect(header.getAttribute('aria-expanded')).toBe('true');
    expect(document.getElementById(header.getAttribute('aria-controls')!)?.textContent).toContain('Edited 2 lines');
    expect(screen.getByText('+new').className).toContain('text-success');
    expect(screen.getByText('-old').className).toContain('text-destructive');
  });

  it('is not a button when there is nothing to open', () => {
    render(<ToolCard e={{ id: 't', kind: 'tool_call', tool: 'terminal', args: 'ls', status: 'failed', at: 1, seq: null }} />);
    expect(screen.queryByRole('button')).toBeNull();
    expect(screen.getByRole('group', { name: 'Tool call: terminal — Failed' }).textContent).toContain('Failed');
  });
});

describe('ToolApprovalCard', () => {
  it('is an alert only while pending, then shows the decision', () => {
    const e = { id: 'a', kind: 'approval_request', tool: 'browser', args: 'open x', risk: 'external', status: 'pending', at: 1, seq: null } as const;
    const { rerender } = render(<ToolApprovalCard e={e} name="luna" onResolve={() => {}} />);
    expect(screen.getByRole('alert').textContent).toContain('Reaches outside your computer');
    rerender(<ToolApprovalCard e={{ ...e, status: 'denied' }} name="luna" />);
    expect(screen.queryByRole('alert')).toBeNull();
    expect(screen.getByText('Denied')).toBeTruthy();
    expect(screen.queryByRole('button')).toBeNull();
  });
});

describe('AgentAside', () => {
  it('starts open with the reply under the note, and collapses', () => {
    render(<AgentAside e={{ id: 's', kind: 'aside', from: 'luna', to: 'scout', body: 'flaky?', reply: 'Fixed.', team: 'luna', at: 1, seq: null }} />);
    const toggle = screen.getByRole('button', { name: /luna → scout/ });
    expect(toggle.textContent).toContain('Team luna');
    expect(screen.getByText('Fixed.', { exact: false })).toBeTruthy();
    fireEvent.click(toggle);
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
    expect(screen.queryByText('Fixed.', { exact: false })).toBeNull();
  });
});

describe('MessageBody', () => {
  it('renders lists and code as elements, and raw HTML as text', () => {
    const { container } = render(<MessageBody body={'1. **Starter**\n2. <img src=x onerror=alert(1)>\n\n```\ncode\n```'} />);
    expect(container.querySelectorAll('ol > li')).toHaveLength(2);
    expect(container.querySelector('strong')?.textContent).toBe('Starter');
    expect(container.querySelector('img')).toBeNull();
    expect(container.textContent).toContain('<img src=x onerror=alert(1)>');
    expect(container.querySelector('pre')?.textContent).toBe('code');
  });
});
