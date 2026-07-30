import React from 'react';

import { render, screen, fireEvent } from '@testing-library/react';

import { hapticLight } from 'lib/mobile/haptics';

import Numpad, { Numpad as NamedNumpad } from './Numpad';

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

// `app/icons/v2` pulls in SVG assets; stub `Icon` with a marker span and expose
// `IconName.Backspace` (the only member the component references).
jest.mock('app/icons/v2', () => ({
  Icon: ({ name, size, className }: any) => (
    <span data-testid="icon" data-name={name} data-size={size} className={className} />
  ),
  IconName: {
    Backspace: 'backspace'
  }
}));

// Native haptics — replace with a spy so we can assert it fires on every press.
jest.mock('lib/mobile/haptics', () => ({
  hapticLight: jest.fn()
}));

// i18n — echo the key back so we can assert on translation keys.
jest.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key })
}));

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const DIGITS = ['1', '2', '3', '4', '5', '6', '7', '8', '9', '0'];

const renderNumpad = (props: Partial<React.ComponentProps<typeof NamedNumpad>> = {}) => {
  const onDigit = props.onDigit ?? jest.fn();
  const onDelete = props.onDelete ?? jest.fn();
  const utils = render(<NamedNumpad onDigit={onDigit} onDelete={onDelete} {...props} />);
  return { ...utils, onDigit, onDelete };
};

beforeEach(() => {
  jest.clearAllMocks();
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('Numpad', () => {
  it('renders a button for every digit 1-9 and 0 plus a delete button', () => {
    renderNumpad();

    for (const digit of DIGITS) {
      const btn = screen.getByTestId(`numpad-${digit}`);
      expect(btn).toBeInTheDocument();
      expect(btn).toHaveTextContent(digit);
      expect(btn).toHaveAttribute('type', 'button');
    }

    expect(screen.getByTestId('numpad-delete')).toBeInTheDocument();
    // 10 digits + 1 delete = 11 buttons.
    expect(screen.getAllByRole('button')).toHaveLength(11);
  });

  it('calls onDigit with the correct value and fires haptics for each digit', () => {
    const { onDigit } = renderNumpad();

    DIGITS.forEach((digit, index) => {
      fireEvent.click(screen.getByTestId(`numpad-${digit}`));
      expect(onDigit).toHaveBeenNthCalledWith(index + 1, digit);
    });

    expect(onDigit).toHaveBeenCalledTimes(DIGITS.length);
    // One haptic per digit press.
    expect(hapticLight).toHaveBeenCalledTimes(DIGITS.length);
  });

  it('does not call onDelete when a digit is pressed', () => {
    const { onDelete } = renderNumpad();

    fireEvent.click(screen.getByTestId('numpad-5'));

    expect(onDelete).not.toHaveBeenCalled();
  });

  it('calls onDelete and fires haptics when the delete button is pressed', () => {
    const { onDelete, onDigit } = renderNumpad();

    fireEvent.click(screen.getByTestId('numpad-delete'));

    expect(onDelete).toHaveBeenCalledTimes(1);
    expect(hapticLight).toHaveBeenCalledTimes(1);
    expect(onDigit).not.toHaveBeenCalled();
  });

  it('renders the backspace icon inside the delete button at size lg', () => {
    renderNumpad();

    const icon = screen.getByTestId('icon');
    expect(icon).toHaveAttribute('data-name', 'backspace');
    expect(icon).toHaveAttribute('data-size', 'lg');
    expect(screen.getByTestId('numpad-delete')).toContainElement(icon);
  });

  it('gives the delete button an accessible label', () => {
    renderNumpad();

    expect(screen.getByRole('button', { name: 'delete' })).toBe(screen.getByTestId('numpad-delete'));
  });

  it('renders an aria-hidden spacer to keep the 0 key centered', () => {
    const { container } = renderNumpad();

    const spacer = container.querySelector('[aria-hidden="true"]');
    expect(spacer).toBeInTheDocument();
    // The spacer is an empty div, not a button.
    expect(spacer?.tagName).toBe('DIV');
    expect(spacer).toBeEmptyDOMElement();
  });

  it('applies the base grid classes and merges a custom className onto the container', () => {
    const { container } = renderNumpad({ className: 'custom-class' });

    const grid = container.firstElementChild as HTMLElement;
    expect(grid).toHaveClass('grid', 'grid-cols-3', 'gap-4', 'w-fit', 'mx-auto', 'custom-class');
  });

  it('renders without a className without throwing', () => {
    const { container } = renderNumpad();

    const grid = container.firstElementChild as HTMLElement;
    expect(grid).toHaveClass('grid');
    // No stray "undefined" class token leaks in when className is omitted.
    expect(grid.className).not.toMatch(/undefined/);
  });

  it('exposes the same component as the default and named export', () => {
    expect(Numpad).toBe(NamedNumpad);
  });
});
