import React from 'react';

import { render, screen, fireEvent } from '@testing-library/react';

import { AmountInput, normalizeDecimalInput } from './AmountInput';

// Mock the Icon component / IconName enum used by the error row. Keeps the DOM
// tiny and lets us assert which icon variant was requested.
jest.mock('app/icons/v2', () => ({
  Icon: ({ name, size, className }: any) => (
    <span data-testid="icon" data-name={name} data-size={size} className={className} />
  ),
  IconName: {
    InformationFill: 'InformationFill'
  }
}));

// Convenience: the underlying react-currency-input-field renders a plain
// <input>; we tag it with data-testid so every test can grab it directly.
const TESTID = 'amount';
const getInput = () => screen.getByTestId(TESTID) as HTMLInputElement;

describe('AmountInput', () => {
  describe('amountTextSize scaling (via input className)', () => {
    it('uses text-[4rem] for a short value (< 7 chars)', () => {
      render(<AmountInput value="123" data-testid={TESTID} />);
      expect(getInput()).toHaveClass('text-[4rem]');
    });

    it('uses text-5xl for a value of 7-9 chars', () => {
      render(<AmountInput value="1234567" data-testid={TESTID} />);
      expect(getInput()).toHaveClass('text-5xl');
    });

    it('uses text-4xl for a value of 10-12 chars', () => {
      render(<AmountInput value="1234567890" data-testid={TESTID} />);
      expect(getInput()).toHaveClass('text-4xl');
    });

    it('uses text-3xl for a value of 13+ chars', () => {
      render(<AmountInput value="1234567890123" data-testid={TESTID} />);
      expect(getInput()).toHaveClass('text-3xl');
      // No fixed 4rem beside the step: Tailwind emits the arbitrary size after text-3xl, so it would win.
      expect(getInput()).not.toHaveClass('text-[4rem]');
    });

    it('falls back to length 4 (text-[4rem]) when value is undefined', () => {
      render(<AmountInput data-testid={TESTID} />);
      expect(getInput()).toHaveClass('text-[4rem]');
    });

    it('falls back to length 4 (text-[4rem]) when value is an empty string', () => {
      // Empty string has length 0, so the `|| 4` fallback branch is exercised.
      render(<AmountInput value="" data-testid={TESTID} />);
      expect(getInput()).toHaveClass('text-[4rem]');
    });
  });

  describe('input color state', () => {
    it('keeps a cleared invalid input red and accessible without an error row', () => {
      render(<AmountInput value="" invalid helper="Available 200 USDC" data-testid={TESTID} />);

      expect(getInput()).toHaveClass('text-red-500', 'placeholder-red-500');
      expect(getInput()).toHaveAttribute('aria-invalid', 'true');
      expect(screen.queryByTestId('icon')).not.toBeInTheDocument();
      expect(screen.getByText('Available 200 USDC')).toBeInTheDocument();
    });

    it('renders red text/placeholder classes when there is an error', () => {
      render(<AmountInput value="10" error="Too much" data-testid={TESTID} />);
      const input = getInput();
      expect(input).toHaveClass('text-red-500', 'placeholder-red-500');
      expect(input).not.toHaveClass('text-ink');
    });

    it('renders black text when a value is present and there is no error', () => {
      render(<AmountInput value="10" data-testid={TESTID} />);
      const input = getInput();
      expect(input).toHaveClass('text-ink');
      expect(input).not.toHaveClass('text-red-500');
    });

    it('renders grey text/placeholder when there is neither value nor error', () => {
      render(<AmountInput data-testid={TESTID} />);
      const input = getInput();
      expect(input).toHaveClass('text-grey-300', 'placeholder-grey-300');
    });
  });

  describe('label', () => {
    it('does not render a label element when label is omitted', () => {
      const { container } = render(<AmountInput data-testid={TESTID} />);
      // The first child of the root is the amount row (not a heading span).
      expect(container.querySelector('span.font-heading')).toBeNull();
    });

    it('renders a string label inside a heading span', () => {
      render(<AmountInput label="Select Amount" data-testid={TESTID} />);
      const label = screen.getByText('Select Amount');
      expect(label.tagName).toBe('SPAN');
      expect(label).toHaveClass('font-heading', 'text-2xl', 'font-bold', 'text-gray');
    });

    it('renders a ReactNode label as-is (not wrapped in a heading span)', () => {
      render(<AmountInput label={<div data-testid="custom-label">Custom</div>} data-testid={TESTID} />);
      const custom = screen.getByTestId('custom-label');
      expect(custom).toBeInTheDocument();
      expect(custom.tagName).toBe('DIV');
      // The node-label branch must NOT wrap it in the heading span.
      expect(screen.queryByText('Custom')).not.toHaveClass('font-heading');
    });
  });

  describe('error / helper rows', () => {
    it('renders the error row with an info icon and the error text', () => {
      render(<AmountInput error="Insufficient balance" data-testid={TESTID} />);

      const icon = screen.getByTestId('icon');
      expect(icon).toHaveAttribute('data-name', 'InformationFill');
      expect(icon).toHaveAttribute('data-size', 'xs');
      expect(icon).toHaveClass('text-red-500');

      const message = screen.getByText('Insufficient balance');
      expect(message).toHaveClass('text-red-500', 'text-sm');
    });

    it('renders the helper row when a helper is provided and there is no error', () => {
      render(<AmountInput helper={<span data-testid="helper">Available 200 USDC</span>} data-testid={TESTID} />);

      expect(screen.getByTestId('helper')).toBeInTheDocument();
      // No error icon should be present in the helper branch.
      expect(screen.queryByTestId('icon')).not.toBeInTheDocument();
    });

    it('prefers the error row over the helper when both are provided', () => {
      render(
        <AmountInput error="Bad" helper={<span data-testid="helper">Should not show</span>} data-testid={TESTID} />
      );

      expect(screen.getByText('Bad')).toBeInTheDocument();
      expect(screen.getByTestId('icon')).toBeInTheDocument();
      // The helper branch is skipped entirely when there's an error.
      expect(screen.queryByTestId('helper')).not.toBeInTheDocument();
    });

    it('renders neither row when there is no error and no helper', () => {
      render(<AmountInput data-testid={TESTID} />);

      expect(screen.queryByTestId('icon')).not.toBeInTheDocument();
      // The input still renders; only the error/helper rows are absent.
      expect(getInput()).toBeInTheDocument();
    });
  });

  describe('token selector', () => {
    it('renders the token selector when provided', () => {
      render(<AmountInput tokenSelector={<button data-testid="token">USDC</button>} data-testid={TESTID} />);
      expect(screen.getByTestId('token')).toBeInTheDocument();
    });

    it('sits 8px under the helper line with no divider, and 16px under the divider', () => {
      const token = <button data-testid="token">USDC</button>;
      const { rerender } = render(
        <AmountInput showDivider={false} helper="Available 0" tokenSelector={token} data-testid={TESTID} />
      );
      expect(screen.getByTestId('token').parentElement).toHaveClass('mt-2');

      rerender(<AmountInput showDivider helper="Available 0" tokenSelector={token} data-testid={TESTID} />);
      expect(screen.getByTestId('token').parentElement).toHaveClass('mt-4');
    });

    it('does not render a token selector chip when omitted', () => {
      render(<AmountInput data-testid={TESTID} />);
      expect(screen.queryByTestId('token')).not.toBeInTheDocument();
    });
  });

  describe('divider', () => {
    it('renders by default', () => {
      render(<AmountInput data-testid={TESTID} />);
      expect(screen.getByTestId('amount-token-divider')).toBeInTheDocument();
    });

    it('can be hidden by the caller', () => {
      render(<AmountInput showDivider={false} data-testid={TESTID} />);
      expect(screen.queryByTestId('amount-token-divider')).not.toBeInTheDocument();
    });

    it('takes the flow it is told it belongs to, and the brand orange otherwise', () => {
      const { rerender } = render(<AmountInput data-testid={TESTID} />);
      expect(screen.getByTestId('amount-token-divider')).toHaveClass('bg-primary-500');

      rerender(<AmountInput accent="swap" data-testid={TESTID} />);
      expect(screen.getByTestId('amount-token-divider')).toHaveClass('bg-accent-swap');
    });
  });

  describe('prefix and alignment', () => {
    it('draws a prefix outside the input, so the value stays bare digits and screen readers skip it', () => {
      render(<AmountInput prefix="$" value="25" aria-label="Limit" data-testid={TESTID} />);

      const input = screen.getByTestId(TESTID);
      expect(input).toHaveValue('25');
      expect(input).toHaveAccessibleName('Limit');
      const prefix = screen.getByText('$');
      expect(prefix).toHaveAttribute('aria-hidden', 'true');
      expect(prefix).not.toContainElement(input);
    });

    it('left-aligns by default: one baseline row, the input spanning it', () => {
      render(<AmountInput prefix="$" value="25" data-testid={TESTID} />);

      const input = screen.getByTestId(TESTID);
      expect(input).toHaveClass('text-left', 'w-full');
      expect(screen.getByText('$').parentElement).toHaveClass('items-baseline');
    });

    it('centres the prefix and a value-sized input as one, the prefix smaller and raised', () => {
      render(<AmountInput align="center" prefix="$" value="25" data-testid={TESTID} />);

      const input = screen.getByTestId(TESTID);
      expect(input).toHaveClass('text-center', 'min-w-full');
      expect(input).not.toHaveClass('w-full');
      const prefix = screen.getByText('$');
      expect(prefix).toHaveClass('text-[0.6em]', 'text-muted');
      expect(prefix.parentElement).toHaveClass('justify-center');
      // The invisible sizing copy holds the value, so the input is exactly as wide as it.
      expect(input.parentElement?.querySelector('[aria-hidden="true"].invisible')).toHaveTextContent('25');
    });

    it('steps a centred row and a left prefix down with a long value, with no fixed 4rem', () => {
      const { unmount } = render(<AmountInput align="center" prefix="$" value="1234567890123" data-testid={TESTID} />);
      const row = screen.getByText('$').parentElement!;
      expect(row).toHaveClass('text-3xl');
      expect(row).not.toHaveClass('text-[4rem]');
      unmount();

      render(<AmountInput prefix="$" value="1234567890123" data-testid={TESTID} />);
      expect(screen.getByText('$')).toHaveClass('text-3xl');
    });

    it('keeps a short centred row at 4rem, set once', () => {
      render(<AmountInput align="center" prefix="$" value="25" data-testid={TESTID} />);
      const row = screen.getByText('$').parentElement!;
      expect(row.className.split(/\s+/).filter(name => name === 'text-[4rem]')).toHaveLength(1);
    });

    it('sizes a centred empty field to its placeholder', () => {
      render(<AmountInput align="center" placeholder="0" value="" data-testid={TESTID} />);

      expect(screen.getByTestId(TESTID).parentElement?.querySelector('.invisible')).toHaveTextContent('0');
    });
  });

  describe('input props passthrough', () => {
    it('uses the default placeholder of 0.00', () => {
      render(<AmountInput data-testid={TESTID} />);
      expect(getInput()).toHaveAttribute('placeholder', '0.00');
    });

    it('honours a custom placeholder', () => {
      render(<AmountInput placeholder="enter amount" data-testid={TESTID} />);
      expect(getInput()).toHaveAttribute('placeholder', 'enter amount');
    });

    it('applies the caller-supplied className to the root element', () => {
      const { container } = render(<AmountInput className="my-root" data-testid={TESTID} />);
      expect(container.firstChild).toHaveClass('flex', 'flex-col', 'my-root');
    });

    it('disables the input when disabled is true', () => {
      render(<AmountInput disabled data-testid={TESTID} />);
      expect(getInput()).toBeDisabled();
    });

    it('reflects the controlled value in the input', () => {
      render(<AmountInput value="42" data-testid={TESTID} />);
      expect(getInput()).toHaveValue('42');
    });

    it('forwards autoFocus to the input (input receives focus on mount)', () => {
      render(<AmountInput autoFocus data-testid={TESTID} />);
      expect(getInput()).toHaveFocus();
    });
  });

  describe('interaction', () => {
    it('fires onValueChange when the user changes the input', () => {
      const onValueChange = jest.fn();
      render(<AmountInput onValueChange={onValueChange} data-testid={TESTID} />);

      fireEvent.change(getInput(), { target: { value: '5' } });

      expect(onValueChange).toHaveBeenCalled();
    });

    // #433 — on a comma-decimal keyboard/locale (es, de, fr, …) the user types a
    // comma for the decimal point. Group separators are disabled, so a comma can
    // only mean "decimal": normalize it to a dot before parsing so the emitted
    // value stays "."-normalized for the transaction pipeline.
    it('normalizes a typed comma decimal separator to a dot', () => {
      const onValueChange = jest.fn();
      render(<AmountInput onValueChange={onValueChange} data-testid={TESTID} />);

      fireEvent.change(getInput(), { target: { value: '1,5' } });

      expect(onValueChange).toHaveBeenCalledWith('1.5', undefined, expect.objectContaining({ value: '1.5' }));
    });

    it('normalizes a comma in a sub-one value (0,001 → 0.001)', () => {
      const onValueChange = jest.fn();
      render(<AmountInput onValueChange={onValueChange} data-testid={TESTID} />);

      fireEvent.change(getInput(), { target: { value: '0,001' } });

      expect(onValueChange).toHaveBeenCalledWith('0.001', undefined, expect.objectContaining({ value: '0.001' }));
    });

    it('leaves a dot decimal separator unchanged', () => {
      const onValueChange = jest.fn();
      render(<AmountInput onValueChange={onValueChange} data-testid={TESTID} />);

      fireEvent.change(getInput(), { target: { value: '2.75' } });

      expect(onValueChange).toHaveBeenCalledWith('2.75', undefined, expect.objectContaining({ value: '2.75' }));
    });

    it('treats commas as thousands groupings when a dot is present (pasted 1,000.50)', () => {
      // A dot is already the decimal point, so the commas are groupings — drop
      // them rather than collapse into a broken multi-dot value.
      const onValueChange = jest.fn();
      render(<AmountInput onValueChange={onValueChange} data-testid={TESTID} />);

      fireEvent.change(getInput(), { target: { value: '1,000.50' } });

      expect(onValueChange).toHaveBeenCalledWith('1000.50', undefined, expect.objectContaining({ value: '1000.50' }));
    });

    it('accepts a comma decimal on a dot-group locale (de-DE) — guards groupSeparator=""', () => {
      // react-currency-input-field derives its group separator from the ambient
      // locale (via Intl.NumberFormat) even with grouping disabled. On a de-DE
      // device the group separator is ".", which would strip our normalized dot
      // and re-break the fix — unless the field pins groupSeparator="". Force the
      // ambient locale to de-DE so this test fails if that prop is ever removed.
      const RealNumberFormat = Intl.NumberFormat;
      const spy = jest
        .spyOn(Intl, 'NumberFormat')
        .mockImplementation(
          ((_locale?: unknown, options?: Intl.NumberFormatOptions) =>
            new RealNumberFormat('de-DE', options)) as unknown as typeof Intl.NumberFormat
        );

      try {
        const onValueChange = jest.fn();
        render(<AmountInput onValueChange={onValueChange} data-testid={TESTID} />);

        fireEvent.change(getInput(), { target: { value: '1,5' } });

        expect(onValueChange).toHaveBeenCalledWith('1.5', undefined, expect.objectContaining({ value: '1.5' }));
      } finally {
        spy.mockRestore();
      }
    });

    it('focuses the input when the amount row is clicked', () => {
      const { container } = render(<AmountInput data-testid={TESTID} />);
      const row = container.querySelector('.cursor-text') as HTMLElement;
      expect(row).not.toBeNull();

      expect(getInput()).not.toHaveFocus();
      fireEvent.click(row);
      expect(getInput()).toHaveFocus();
    });
  });

  describe('normalizeDecimalInput', () => {
    it('turns a comma decimal into a dot', () => {
      expect(normalizeDecimalInput('1,5')).toBe('1.5');
      expect(normalizeDecimalInput('0,001')).toBe('0.001');
    });

    it('leaves a dot decimal untouched', () => {
      expect(normalizeDecimalInput('2.75')).toBe('2.75');
      expect(normalizeDecimalInput('42')).toBe('42');
    });

    it('drops commas as groupings when a dot is already present', () => {
      expect(normalizeDecimalInput('1,000.50')).toBe('1000.50');
    });
  });
});
