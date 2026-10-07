import React, { useState } from 'react';

import { act, render, screen } from '@testing-library/react';

import { clearFieldValue } from './clear-field';

function ControlledInput({ onValue }: { onValue: (value: string) => void }) {
  const [value, setValue] = useState('abc');
  return (
    <input
      aria-label="field"
      value={value}
      onChange={event => {
        onValue(event.target.value);
        setValue(event.target.value);
      }}
    />
  );
}

describe('clearFieldValue', () => {
  it("empties a controlled input through React's own onChange", () => {
    const onValue = jest.fn();
    render(<ControlledInput onValue={onValue} />);
    const field = screen.getByLabelText<HTMLInputElement>('field');

    act(() => clearFieldValue(field));

    expect(onValue).toHaveBeenCalledTimes(1);
    expect(onValue).toHaveBeenCalledWith('');
    expect(field.value).toBe('');
  });

  it('empties a textarea through the textarea value setter', () => {
    const seen: string[] = [];
    render(
      <textarea
        aria-label="field"
        defaultValue="mtst1abc"
        onChange={event => {
          seen.push(event.target.value);
        }}
      />
    );
    const field = screen.getByLabelText<HTMLTextAreaElement>('field');

    act(() => clearFieldValue(field));

    expect(seen).toEqual(['']);
    expect(field.value).toBe('');
  });

  it('empties an uncontrolled input whose owner reads the DOM', () => {
    const onChange = jest.fn();
    render(<input aria-label="field" defaultValue="0xfaucet" onChange={() => onChange()} />);
    const field = screen.getByLabelText<HTMLInputElement>('field');

    act(() => clearFieldValue(field));

    expect(onChange).toHaveBeenCalledTimes(1);
    expect(field.value).toBe('');
  });

  it('leaves focus in the field', () => {
    render(<ControlledInput onValue={jest.fn()} />);
    const field = screen.getByLabelText<HTMLInputElement>('field');

    act(() => clearFieldValue(field));

    expect(field).toHaveFocus();
  });

  it('does nothing without a field', () => {
    expect(() => clearFieldValue(null)).not.toThrow();
  });
});
