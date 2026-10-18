import React, { useState } from 'react';

import { fireEvent, render, screen } from '@testing-library/react';

import { CodeInput } from './CodeInput';

const Harness = ({
  initial = '',
  length,
  format
}: {
  initial?: string;
  length?: number;
  format?: 'numeric' | 'alphanumeric';
}) => {
  const [value, setValue] = useState(initial);
  return (
    <CodeInput
      value={value}
      onChange={setValue}
      label="Access code"
      length={length}
      format={format}
      data-testid="code"
    />
  );
};

const cells = (container: HTMLElement) => Array.from(container.querySelectorAll('[data-slot="code-cell"]'));
const type = (value: string) => fireEvent.change(screen.getByTestId('code'), { target: { value } });
// A browser cuts pasted text at the field's maxlength before onChange sees it; jsdom's change event does not.
const paste = (text: string) => {
  const input = screen.getByTestId<HTMLInputElement>('code');
  fireEvent.change(input, { target: { value: input.maxLength >= 0 ? text.slice(0, input.maxLength) : text } });
};

describe('CodeInput', () => {
  it('draws eight cells in two groups of four, with one native numeric field over them', () => {
    const { container } = render(<Harness />);

    expect(cells(container)).toHaveLength(8);
    const groups = Array.from(container.querySelectorAll('[aria-hidden="true"].flex'));
    expect(groups.map(group => group.querySelectorAll('[data-slot="code-cell"]').length)).toEqual([4, 4]);

    const input = screen.getByRole('textbox', { name: 'Access code' });
    expect(input).toHaveAttribute('inputmode', 'numeric');
    expect(input).toHaveAttribute('autocomplete', 'one-time-code');
  });

  it('stacks six-character groups with one input for the complete code', () => {
    const { container } = render(
      <CodeInput
        value="8gKIgL0O6HcU"
        onChange={jest.fn()}
        label="Access code"
        length={12}
        groupSize={6}
        layout="vertical"
      />
    );
    const input = screen.getByRole('textbox');
    expect(input.parentElement).toHaveClass('flex-col');
    const groups = Array.from(container.querySelectorAll('[aria-hidden="true"].flex'));
    expect(groups.map(group => group.textContent)).toEqual(['8gKIgL', '0O6HcU']);
    expect(input.parentElement?.querySelectorAll(':scope > span')).toHaveLength(0);
  });

  it('follows the length it is given', () => {
    const { container } = render(<Harness length={6} />);

    expect(cells(container)).toHaveLength(6);
    type('1234567');
    expect(screen.getByTestId('code')).toHaveValue('123456');
  });

  it('shows one digit for each cell', () => {
    const { container } = render(<Harness />);

    type('47291');

    expect(cells(container).map(cell => cell.textContent)).toEqual(['4', '7', '2', '9', '1', '', '', '']);
  });

  it('keeps digits only and never more than the length, so a pasted code with a dash fits', () => {
    render(<Harness />);

    type('4729-1835 99');

    expect(screen.getByTestId('code')).toHaveValue('47291835');
  });

  it.each([
    ['an access code', '8gKI-gL0O-6HcU', '8gKIgL0O6HcU', { length: 12, format: 'alphanumeric' as const }],
    ['a numeric code', '4729-1835', '47291835', {}]
  ])('keeps every character of %s pasted with separators', (_name, pasted, code, props) => {
    render(<Harness {...props} />);

    paste(pasted);

    expect(screen.getByTestId('code')).toHaveValue(code);
  });

  it('keeps mixed-case letters and digits when an alphanumeric code is pasted', () => {
    const onChange = jest.fn();
    const { container } = render(
      <CodeInput value="" onChange={onChange} label="Access code" length={12} format="alphanumeric" />
    );
    const input = screen.getByRole('textbox', { name: 'Access code' });
    expect(cells(container)).toHaveLength(12);
    expect(input).toHaveAttribute('inputmode', 'text');
    expect(input).toHaveAttribute('autocapitalize', 'none');
    fireEvent.change(input, { target: { value: '8gKI-gL0O 6HcUextra' } });
    expect(onChange).toHaveBeenCalledWith('8gKIgL0O6HcU');
  });

  it('marks the cell that takes the subsequent digit only while the field has focus', () => {
    const { container } = render(<Harness initial="47291" />);
    const active = () => cells(container).map(cell => cell.hasAttribute('data-active'));
    expect(active()).not.toContain(true);

    fireEvent.focus(screen.getByTestId('code'));

    expect(active().indexOf(true)).toBe(5);
    expect(cells(container)[5]).toHaveClass('bg-page', 'ring-accent-primary');

    fireEvent.blur(screen.getByTestId('code'));

    expect(active()).not.toContain(true);
  });

  it('marks no cell when the code is full', () => {
    const { container } = render(<Harness initial="47291835" />);

    fireEvent.focus(screen.getByTestId('code'));

    expect(container.querySelector('[data-active]')).toBeNull();
  });

  it('reports an invalid code and a disabled field on the native input', () => {
    render(<CodeInput value="" onChange={jest.fn()} label="Access code" invalid disabled />);

    const input = screen.getByRole('textbox', { name: 'Access code' });
    expect(input).toHaveAttribute('aria-invalid', 'true');
    expect(input).toBeDisabled();
  });
});
