import React from 'react';

import { render, screen, fireEvent } from '@testing-library/react';

import { AmountInput } from './AmountInput';

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
    it('uses text-6xl for a short value (< 7 chars)', () => {
      render(<AmountInput value="123" data-testid={TESTID} />);
      expect(getInput()).toHaveClass('text-6xl');
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
    });

    it('falls back to length 4 (text-6xl) when value is undefined', () => {
      render(<AmountInput data-testid={TESTID} />);
      expect(getInput()).toHaveClass('text-6xl');
    });

    it('falls back to length 4 (text-6xl) when value is an empty string', () => {
      // Empty string has length 0, so the `|| 4` fallback branch is exercised.
      render(<AmountInput value="" data-testid={TESTID} />);
      expect(getInput()).toHaveClass('text-6xl');
    });
  });

  describe('input color state', () => {
    it('renders red text/placeholder classes when there is an error', () => {
      render(<AmountInput value="10" error="Too much" data-testid={TESTID} />);
      const input = getInput();
      expect(input).toHaveClass('text-red-500', 'placeholder-red-500');
      expect(input).not.toHaveClass('text-black');
    });

    it('renders black text when a value is present and there is no error', () => {
      render(<AmountInput value="10" data-testid={TESTID} />);
      const input = getInput();
      expect(input).toHaveClass('text-black');
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

    it('focuses the input when the amount row is clicked', () => {
      const { container } = render(<AmountInput data-testid={TESTID} />);
      const row = container.querySelector('.cursor-text') as HTMLElement;
      expect(row).not.toBeNull();

      expect(getInput()).not.toHaveFocus();
      fireEvent.click(row);
      expect(getInput()).toHaveFocus();
    });
  });
});
