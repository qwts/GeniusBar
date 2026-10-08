import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { PREFERENCES_KEY, preferenceActions } from '../state/preferences';
import { DefaultHarness } from './DefaultHarness';

afterEach(() => { cleanup(); localStorage.clear(); preferenceActions.forget(); });

describe('DefaultHarness', () => {
  it('takes any harness command from Other…, then lists it', () => {
    render(<DefaultHarness harnesses={[]} />);
    const select = screen.getByRole('combobox', { name: 'Default harness' });
    fireEvent.change(select, { target: { value: '__other' } });
    const input = screen.getByRole('textbox', { name: 'Harness command' });
    fireEvent.change(input, { target: { value: ' my-harness --flag ' } });
    expect(localStorage.getItem(PREFERENCES_KEY)).toBeNull();
    fireEvent.blur(input);
    expect(JSON.parse(localStorage.getItem(PREFERENCES_KEY)!).defaultHarness).toBe('my-harness --flag');
    fireEvent.change(select, { target: { value: 'my-harness --flag' } });
    expect(screen.queryByRole('textbox', { name: 'Harness command' })).toBeNull();
    expect((select as HTMLSelectElement).value).toBe('my-harness --flag');
  });

  it('leaves the default alone when Other… is left empty', () => {
    preferenceActions.setDefaultHarness('claude');
    render(<DefaultHarness harnesses={['claude']} />);
    const select = screen.getByRole('combobox', { name: 'Default harness' });
    fireEvent.change(select, { target: { value: '__other' } });
    const input = screen.getByRole('textbox', { name: 'Harness command' });
    fireEvent.blur(input);
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(JSON.parse(localStorage.getItem(PREFERENCES_KEY)!).defaultHarness).toBe('claude');
    fireEvent.change(select, { target: { value: '' } });
    expect(JSON.parse(localStorage.getItem(PREFERENCES_KEY)!).defaultHarness).toBe(null);
  });

  it('commits Other… on Enter, and keeps the default when emptied', () => {
    render(<DefaultHarness harnesses={[]} />);
    fireEvent.change(screen.getByRole('combobox', { name: 'Default harness' }), { target: { value: '__other' } });
    const input = screen.getByRole('textbox', { name: 'Harness command' });
    fireEvent.change(input, { target: { value: 'my-h' } });
    expect(localStorage.getItem(PREFERENCES_KEY)).toBeNull();
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(JSON.parse(localStorage.getItem(PREFERENCES_KEY)!).defaultHarness).toBe('my-h');
    fireEvent.change(input, { target: { value: '  ' } });
    fireEvent.blur(input);
    expect(JSON.parse(localStorage.getItem(PREFERENCES_KEY)!).defaultHarness).toBe('my-h');
  });
});
