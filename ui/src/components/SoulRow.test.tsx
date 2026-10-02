import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { buildSoulForest } from '../model/census';
import { sampleCensus } from '../model/fixtures';
import { SoulRow, soulRowLabel } from './SoulRow';

afterEach(cleanup);

describe('SoulRow', () => {
  const [luna, child, left] = sampleCensus;

  it('uses friendly state text and avoids technical counters', () => {
    expect(soulRowLabel(luna)).toBe('luna, codex, Ready');
    expect(soulRowLabel(child)).toBe('agent_c, unknown harness, Starting');
    expect(soulRowLabel(child, 2)).toBe('agent_c, unknown harness, Starting, 2 unread messages');
    expect(soulRowLabel(left)).toMatch(/Unavailable.*Left — no longer available/);
  });

  it('renders subagents indented beneath their parent and selects any row', () => {
    const onSelect = vi.fn();
    const [root] = buildSoulForest(sampleCensus);
    render(<SoulRow node={root} depth={0} paused onSelect={onSelect} />);
    const rows = screen.getAllByRole('button');
    expect(rows).toHaveLength(2);
    expect(rows[0].style.paddingLeft).toBe('14px');
    expect(rows[1].style.paddingLeft).toBe('30px');
    fireEvent.click(rows[1]);
    expect(onSelect).toHaveBeenCalledWith(child);
  });

  it('keeps left souls selectable with their explanation', () => {
    const onSelect = vi.fn();
    render(<SoulRow node={{ soul: left, children: [] }} depth={0} paused onSelect={onSelect} />);
    expect(screen.getByText(/no longer available/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button'));
    expect(onSelect).toHaveBeenCalledWith(left);
  });
});
