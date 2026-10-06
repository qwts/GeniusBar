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
    await waitFor(() => expect(options()).toEqual(['Harness default', 'GPT-5', 'Other…']));
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
