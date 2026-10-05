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
    fireEvent.change(screen.getByRole('textbox', { name: 'Harness command' }), { target: { value: ' my-harness --flag ' } });
    expect(JSON.parse(localStorage.getItem(PREFERENCES_KEY)!)).toEqual({ defaultHarness: 'my-harness --flag' });
    fireEvent.change(select, { target: { value: 'my-harness --flag' } });
    expect(screen.queryByRole('textbox', { name: 'Harness command' })).toBeNull();
    expect((select as HTMLSelectElement).value).toBe('my-harness --flag');
  });
});
