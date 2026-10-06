import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { useState } from 'react';
import { afterEach, describe, expect, it } from 'vitest';
import { radioGroupKeys } from './radioGroup';

afterEach(cleanup);

function Group({ options, disabled = [] }: { options: string[]; disabled?: string[] }) {
  const [value, setValue] = useState(options[0]);
  return (
    <div role="radiogroup" aria-label="Pick" onKeyDown={radioGroupKeys}>
      {options.map((o) => (
        <button key={o} type="button" role="radio" aria-checked={value === o} tabIndex={value === o ? 0 : -1}
          disabled={disabled.includes(o)} onClick={() => setValue(o)}>{o}</button>
      ))}
    </div>
  );
}

const radio = (name: string) => screen.getByRole('radio', { name });

describe('radioGroupKeys', () => {
  it('moves focus and selection with the arrow keys, wrapping at either end', () => {
    render(<Group options={['a', 'b', 'c']} />);
    const group = screen.getByRole('radiogroup');
    radio('a').focus();
    fireEvent.keyDown(group, { key: 'ArrowRight' });
    expect(document.activeElement).toBe(radio('b'));
    expect(radio('b').getAttribute('aria-checked')).toBe('true');
    expect(radio('b').getAttribute('tabindex')).toBe('0');
    expect(radio('a').getAttribute('tabindex')).toBe('-1');
    fireEvent.keyDown(group, { key: 'ArrowDown' });
    fireEvent.keyDown(group, { key: 'ArrowDown' });
    expect(radio('a').getAttribute('aria-checked')).toBe('true');
    fireEvent.keyDown(group, { key: 'ArrowLeft' });
    expect(document.activeElement).toBe(radio('c'));
    fireEvent.keyDown(group, { key: 'ArrowUp' });
    expect(radio('b').getAttribute('aria-checked')).toBe('true');
  });

  it('jumps to the first and last radio with Home and End', () => {
    render(<Group options={['a', 'b', 'c']} />);
    const group = screen.getByRole('radiogroup');
    radio('a').focus();
    fireEvent.keyDown(group, { key: 'End' });
    expect(radio('c').getAttribute('aria-checked')).toBe('true');
    fireEvent.keyDown(group, { key: 'Home' });
    expect(document.activeElement).toBe(radio('a'));
    expect(radio('a').getAttribute('aria-checked')).toBe('true');
  });

  it('skips disabled radios and ignores other keys', () => {
    render(<Group options={['a', 'b', 'c']} disabled={['b']} />);
    const group = screen.getByRole('radiogroup');
    radio('a').focus();
    fireEvent.keyDown(group, { key: 'ArrowRight' });
    expect(radio('c').getAttribute('aria-checked')).toBe('true');
    fireEvent.keyDown(group, { key: 'Enter' });
    fireEvent.keyDown(group, { key: 'a' });
    expect(document.activeElement).toBe(radio('c'));
    expect(radio('c').getAttribute('aria-checked')).toBe('true');
  });
});
