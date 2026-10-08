import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { sampleCensus } from '../model/fixtures';
import { ModelField } from './ModelField';
import { SoulSourceContext, type SoulSource } from './SoulNotices';

afterEach(cleanup);

const [luna] = sampleCensus;
const roster = [luna, { ...luna, agentId: 'agent_x' }, { ...luna, agentId: 'agent_y', harness: 'claude' }];

function source(model: SoulSource['model']): SoulSource {
  return {
    population: vi.fn(), coldWake: vi.fn(), setColdWake: vi.fn(), signedIn: vi.fn(), signIn: vi.fn(),
    mode: vi.fn(), setMode: vi.fn(), model, setModel: vi.fn(),
  };
}
const options = () => [...screen.getByRole('combobox', { name: 'Model' }).querySelectorAll('option')].map((o) => o.textContent);

describe('ModelField (#128)', () => {
  it('reads each soul on the harness once and survives a soul agent-bot cannot read', async () => {
    const model = vi.fn(async (agentId: string) => {
      if (agentId === 'agent_x') throw new Error('older agent-bot');
      return { model: null, listedAt: null, available: [{ modelId: 'gpt-5', name: 'GPT-5', description: null }] };
    });
    const s = source(model);
    const { rerender } = render(<SoulSourceContext.Provider value={s}>
      <ModelField roster={roster} harness="codex" value={null} onChange={() => {}} /></SoulSourceContext.Provider>);
    await waitFor(() => expect(options()).toEqual(['Harness default (inherit — nothing stored)', 'GPT-5', 'Other…']));
    expect(model.mock.calls.map(([id]) => id).sort()).toEqual(['agent_p', 'agent_x']);
    // A census refresh with the same souls reads nothing again.
    rerender(<SoulSourceContext.Provider value={s}>
      <ModelField roster={[...roster]} harness="codex" value={null} onChange={() => {}} /></SoulSourceContext.Provider>);
    expect(model).toHaveBeenCalledTimes(2);
  });

  it('reports Other… text as it is typed, blank as the default', () => {
    const onChange = vi.fn();
    render(<SoulSourceContext.Provider value={source(vi.fn(async () => null))}>
      <ModelField roster={[]} harness="codex" value={null} onChange={onChange} /></SoulSourceContext.Provider>);
    fireEvent.change(screen.getByRole('combobox', { name: 'Model' }), { target: { value: '__other' } });
    expect(onChange).toHaveBeenLastCalledWith(null);
    fireEvent.change(screen.getByRole('textbox', { name: 'Model ID' }), { target: { value: ' m1 ' } });
    expect(onChange).toHaveBeenLastCalledWith('m1');
    fireEvent.change(screen.getByRole('textbox', { name: 'Model ID' }), { target: { value: ' ' } });
    expect(onChange).toHaveBeenLastCalledWith(null);
    expect(screen.queryByRole('button', { name: 'Use' })).toBeNull();
  });
});

describe('ModelField inherited versus explicit (#284)', () => {
  const both = {
    model: null, listedAt: '2026-10-05T00:00:00.000Z',
    available: [
      { modelId: 'default', name: 'Default (recommended)', description: null, recommended: true },
      { modelId: 'opus', name: 'Opus', description: 'Opus for complex tasks' },
    ],
  };
  const stored = () => screen.getByTestId('model-stored').textContent;
  const effective = () => screen.getByTestId('model-effective').textContent;
  const field = (s: SoulSource, value: string | null, onChange: (m: string | null) => void = () => {}) => (
    <SoulSourceContext.Provider value={s}><ModelField roster={roster} harness="codex" value={value} onChange={onChange} /></SoulSourceContext.Provider>
  );

  it("tells the inherited null and the harness's recommended id apart, and sends each as itself", async () => {
    const onChange = vi.fn();
    const s = source(vi.fn(async () => both));
    const { rerender } = render(field(s, null, onChange));
    await waitFor(() => expect(options()).toEqual([
      'Harness default (inherit — nothing stored)', "Default (harness's recommended) · default", 'Opus', 'Other…']));
    const select = screen.getByRole('combobox', { name: 'Model' }) as HTMLSelectElement;
    expect(select.value).toBe('__default');
    expect(stored()).toBe('Stored model: none — inherits the harness default');
    expect(effective()).toBe('Effective model: Unknown until the harness reports it');
    expect((select.querySelector('option[value="default"]') as HTMLOptionElement).title).toBe("Default (harness's recommended) · default");
    fireEvent.change(select, { target: { value: 'default' } });
    expect(onChange).toHaveBeenLastCalledWith('default');
    rerender(field(s, 'default', onChange));
    expect(stored()).toBe('Stored model: default');
    expect(effective()).toBe('Effective model: Unknown until the harness reports it');
    fireEvent.change(select, { target: { value: '__default' } });
    expect(onChange).toHaveBeenLastCalledWith(null);
  });

  it('keeps a custom id as typed, visible and unchanged, and never invents an effective model for it', async () => {
    const onChange = vi.fn();
    const s = source(vi.fn(async () => both));
    const { rerender } = render(field(s, null, onChange));
    await waitFor(() => expect(options()).toHaveLength(4));
    fireEvent.change(screen.getByRole('combobox', { name: 'Model' }), { target: { value: '__other' } });
    fireEvent.change(screen.getByRole('textbox', { name: 'Model ID' }), { target: { value: 'my-org/custom-model-2' } });
    expect(onChange).toHaveBeenLastCalledWith('my-org/custom-model-2');
    rerender(field(s, 'my-org/custom-model-2', onChange));
    expect(stored()).toBe('Stored model: my-org/custom-model-2');
    expect(effective()).toBe('Effective model: Unknown until the harness reports it');
    // Reopened with the custom id stored: it is an option of its own, still exact.
    cleanup();
    render(field(s, 'my-org/custom-model-2', onChange));
    const select = screen.getByRole('combobox', { name: 'Model' }) as HTMLSelectElement;
    expect(select.value).toBe('my-org/custom-model-2');
    expect(stored()).toBe('Stored model: my-org/custom-model-2');
  });

  it('shows the stored value and Unknown while the harness cannot be read', async () => {
    const s = source(vi.fn(async () => { throw new Error('offline'); }));
    render(field(s, 'claude-opus-4-1'));
    await waitFor(() => expect(s.model).toHaveBeenCalled());
    expect(options()).toEqual(['Harness default (inherit — nothing stored)', 'claude-opus-4-1', 'Other…']);
    expect(stored()).toBe('Stored model: claude-opus-4-1');
    expect(effective()).toBe('Effective model: Unknown until the harness reports it');
  });

  it('truncates a long label and keeps the whole id in its title', async () => {
    const long = 'x'.repeat(80);
    const s = source(vi.fn(async () => ({ model: null, listedAt: null, available: [{ modelId: long, name: long, description: null }] })));
    render(field(s, null));
    await waitFor(() => expect(options()).toHaveLength(3));
    const option = screen.getByRole('combobox', { name: 'Model' }).querySelectorAll('option')[1];
    expect(option.textContent).toBe(`${'x'.repeat(55)}…`);
    expect(option.title).toBe(long);
    expect(option.value).toBe(long);
  });
});
