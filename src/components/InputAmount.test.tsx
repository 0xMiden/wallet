import React from 'react';

import { render, screen, fireEvent } from '@testing-library/react';

import { InputAmount } from './InputAmount';

// Mock the Icon barrel used for the toggle-currency arrow, mirroring how
// sibling component tests (e.g. CardItem.test.tsx) stub it so we don't pull in
// the SVG re-export barrel.
jest.mock('app/icons/v2', () => ({
  Icon: ({ name, fill, size, className }: any) => (
    <span data-testid="toggle-icon" data-name={name} data-fill={fill} data-size={size} className={className} />
  ),
  IconName: {
    ArrowUpDown: 'arrow-up-down'
  }
}));

// Grab the input rendered by react-currency-input-field (the only <input> in
// the tree).
const getInput = (container: HTMLElement) => container.querySelector('input') as HTMLInputElement;

describe('InputAmount', () => {
  describe('textSize scaling (useMemo)', () => {
    it('uses text-5xl for short content (default: no value, no label -> len 6)', () => {
      const { container } = render(<InputAmount />);
      expect(getInput(container)).toHaveClass('text-5xl');
    });

    it('uses text-4xl when total length crosses 12 (value 7 chars, no label -> 12)', () => {
      const { container } = render(<InputAmount value="1234567" />);
      expect(getInput(container)).toHaveClass('text-4xl');
    });

    it('uses text-2xl when total length crosses 16 (value 11 chars, no label -> 16)', () => {
      const { container } = render(<InputAmount value="12345678901" />);
      expect(getInput(container)).toHaveClass('text-2xl');
    });

    it('uses text-lg when total length crosses 20 (value 15 chars, no label -> 20)', () => {
      const { container } = render(<InputAmount value="123456789012345" />);
      expect(getInput(container)).toHaveClass('text-lg');
    });

    it('factors the label length into the sizing (label drives the 16 threshold)', () => {
      // value undefined -> valueLen falls back to 1; label 14 chars -> 1 + 14 + 1 = 16
      const { container } = render(<InputAmount label="ABCDEFGHIJKLMN" />);
      expect(getInput(container)).toHaveClass('text-2xl');
    });

    it('falls back to length 1 for an empty-string value and length 4 for an empty-string label', () => {
      // valueLen = '' || 1 -> 1 ; labelLen = '' || 4 -> 4 ; total = 1 + 4 + 1 = 6 -> text-5xl
      const { container } = render(<InputAmount value="" label="" />);
      expect(getInput(container)).toHaveClass('text-5xl');
    });
  });

  describe('textColor (useMemo)', () => {
    it('is text-black when there is no error', () => {
      const { container } = render(<InputAmount />);
      expect(getInput(container)).toHaveClass('text-black');
    });

    it('is text-red-500 when error is true', () => {
      const { container } = render(<InputAmount error />);
      const input = getInput(container);
      expect(input).toHaveClass('text-red-500');
      expect(input).not.toHaveClass('text-black');
    });
  });

  describe('root element / props spreading', () => {
    it('applies base layout classes plus the caller className', () => {
      const { container } = render(<InputAmount className="custom-class" />);
      const root = container.firstChild as HTMLElement;
      expect(root).toHaveClass('flex', 'flex-col', 'items-center', 'gap-y-1', 'custom-class');
    });

    it('spreads arbitrary DOM props onto the root element', () => {
      render(<InputAmount id="amount-root" data-testid="amount-root" />);
      const root = screen.getByTestId('amount-root');
      expect(root).toHaveAttribute('id', 'amount-root');
    });
  });

  describe('displayFiat = false (default)', () => {
    it('does not render the "$" prefix label', () => {
      render(<InputAmount />);
      expect(screen.queryByText('$')).not.toBeInTheDocument();
    });

    it('renders the currency label using the provided label', () => {
      render(<InputAmount label="USDC" />);
      expect(screen.getByText('USDC')).toBeInTheDocument();
    });

    it('defaults the currency label to MIDEN when no label is provided', () => {
      render(<InputAmount />);
      expect(screen.getByText('MIDEN')).toBeInTheDocument();
    });

    it('feeds the raw value into the input (fiatValue is ignored)', () => {
      const { container } = render(<InputAmount value="42" fiatValue="99" />);
      expect(getInput(container)).toHaveValue('42');
    });
  });

  describe('displayFiat = true', () => {
    it('renders the "$" prefix label and hides the currency label', () => {
      render(<InputAmount displayFiat value="10" label="MIDEN" />);
      expect(screen.getByText('$')).toBeInTheDocument();
      expect(screen.queryByText('MIDEN')).not.toBeInTheDocument();
    });

    it('shows the fiatValue in the input when provided', () => {
      const { container } = render(<InputAmount displayFiat value="10" fiatValue="7.5" />);
      expect(getInput(container)).toHaveValue('7.5');
    });

    it('falls back to value in the input when fiatValue is absent', () => {
      const { container } = render(<InputAmount displayFiat value="10" />);
      expect(getInput(container)).toHaveValue('10');
    });
  });

  describe('displayToggleCurrency', () => {
    it('renders no toggle button when the flag is off', () => {
      render(<InputAmount />);
      expect(screen.queryByRole('button')).not.toBeInTheDocument();
    });

    it('renders the arrow icon inside the toggle button when on', () => {
      render(<InputAmount displayToggleCurrency />);
      const icon = screen.getByTestId('toggle-icon');
      expect(icon).toBeInTheDocument();
      expect(icon).toHaveAttribute('data-name', 'arrow-up-down');
      expect(icon).toHaveAttribute('data-size', 'xs');
      expect(icon).toHaveAttribute('data-fill', 'currentColor');
    });

    describe('token mode (displayFiat = false): shows the $ fiat conversion', () => {
      it('formats fiatValue with two decimals', () => {
        render(<InputAmount displayToggleCurrency fiatValue="2.5" />);
        expect(screen.getByRole('button')).toHaveTextContent('$2.50');
      });

      it('falls back to value when fiatValue is missing', () => {
        render(<InputAmount displayToggleCurrency value="10" />);
        expect(screen.getByRole('button')).toHaveTextContent('$10.00');
      });

      it('falls back to 0 when neither fiatValue nor value is set', () => {
        render(<InputAmount displayToggleCurrency />);
        expect(screen.getByRole('button')).toHaveTextContent('$0.00');
      });
    });

    describe('fiat mode (displayFiat = true): shows the token amount + label', () => {
      it('renders fiatValue with the currency label', () => {
        render(<InputAmount displayToggleCurrency displayFiat fiatValue="5" label="USDC" />);
        expect(screen.getByRole('button').textContent).toBe('5 USDC');
      });

      it('falls back to value then the default MIDEN label', () => {
        render(<InputAmount displayToggleCurrency displayFiat value="8" />);
        expect(screen.getByRole('button').textContent).toBe('8 MIDEN');
      });

      it('falls back to 0 when neither fiatValue nor value is set', () => {
        render(<InputAmount displayToggleCurrency displayFiat />);
        expect(screen.getByRole('button').textContent).toBe('0 MIDEN');
      });
    });

    it('invokes onToggleCurrency when the button is clicked', () => {
      const onToggleCurrency = jest.fn();
      render(<InputAmount displayToggleCurrency onToggleCurrency={onToggleCurrency} />);
      fireEvent.click(screen.getByRole('button'));
      expect(onToggleCurrency).toHaveBeenCalledTimes(1);
    });
  });

  describe('interaction', () => {
    it('runs the container click handler without throwing (the ref is never wired, so focus is a no-op)', () => {
      const { container } = render(<InputAmount />);
      const input = getInput(container);
      // The clickable wrapper is the div holding the CurrencyInput and owning
      // the onClick={() => inputRef.current?.focus()} handler.
      const wrapper = input.parentElement as HTMLElement;
      expect(document.activeElement).not.toBe(input);
      // The source never passes ref={inputRef} to CurrencyInput, so
      // inputRef.current stays null and the optional-chained focus() no-ops.
      expect(() => fireEvent.click(wrapper)).not.toThrow();
      expect(document.activeElement).not.toBe(input);
    });

    it('calls onValueChange when the input value changes', () => {
      const onValueChange = jest.fn();
      const { container } = render(<InputAmount onValueChange={onValueChange} />);
      fireEvent.change(getInput(container), { target: { value: '123' } });
      expect(onValueChange).toHaveBeenCalled();
      // First positional arg is the parsed string value.
      expect(onValueChange.mock.calls[0][0]).toBe('123');
    });

    it('does not throw when clicked without an onValueChange handler', () => {
      const { container } = render(<InputAmount />);
      expect(() => fireEvent.change(getInput(container), { target: { value: '9' } })).not.toThrow();
    });

    it('respects the autoFocus prop', () => {
      const { container } = render(<InputAmount autoFocus />);
      expect(document.activeElement).toBe(getInput(container));
    });
  });
});
