import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { buildSoulForest } from '../model/census';
import { sampleCensus } from '../model/fixtures';
import { SoulRow, soulRowLabel } from './SoulRow';

afterEach(cleanup);

describe('SoulRow', () => {
  const [luna, child, left] = sampleCensus;

  it('labels a row in text: name, harness, presence, unacked, last wake', () => {
    expect(soulRowLabel(luna)).toBe('luna, codex, presence joined, unacked 0, last wake 2026-01-01T00:00:01Z');
    expect(soulRowLabel(child)).toBe('agent_c, unknown harness, presence watching, unacked 3, last wake none');
    expect(soulRowLabel(left)).toMatch(/presence left.*Left — no longer available/);
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
