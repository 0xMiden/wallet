import React from 'react';

import { render, screen, fireEvent } from '@testing-library/react';

import { hapticLight } from 'lib/mobile/haptics';

import Numpad, { Numpad as NamedNumpad } from './Numpad';

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

// `app/icons/v2` pulls in SVG assets; stub `Icon` with a marker span and expose the two members
// the component references.
jest.mock('app/icons/v2', () => ({
  Icon: ({ name, size, className }: { name: string; size?: string; className?: string }) => (
    <span data-testid="icon" data-name={name} data-size={size} className={className} />
  ),
  IconName: {
    Backspace: 'backspace',
    FaceId: 'face-id',
    Fingerprint: 'fingerprint'
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

  it('lays out twelve slots with test ids in keypad order: 1-9, spacer, 0, delete', () => {
    renderNumpad();

    const slots = Array.from(screen.getByTestId('numpad').children).map(el => el.getAttribute('data-testid'));
    expect(slots).toEqual([
      'numpad-1',
      'numpad-2',
      'numpad-3',
      'numpad-4',
      'numpad-5',
      'numpad-6',
      'numpad-7',
      'numpad-8',
      'numpad-9',
      'numpad-spacer',
      'numpad-0',
      'numpad-delete'
    ]);
  });

  it('draws round keys of at least 64px with fill and fill-pressed, digits in the display type', () => {
    renderNumpad();

    const digit = screen.getByTestId('numpad-5');
    expect(digit).toHaveClass('rounded-full', 'size-19', '[@media(max-height:720px)]:size-16');
    expect(digit).toHaveClass('bg-fill', 'active:bg-fill-pressed', 'text-ink', 'font-heading', 'font-extrabold');
    expect(digit).toHaveClass('text-[32px]');
  });

  it('gives the bare backspace key the same hit area as a digit', () => {
    renderNumpad();

    const del = screen.getByTestId('numpad-delete');
    expect(del).toHaveClass('size-19', '[@media(max-height:720px)]:size-16', 'rounded-full');
    expect(del).not.toHaveClass('bg-fill');
  });

  it('keeps the bottom-left slot empty without a biometric handler', () => {
    renderNumpad();

    expect(screen.queryByTestId('numpad-biometric')).not.toBeInTheDocument();
    expect(screen.getByTestId('numpad-spacer')).toHaveClass('size-19');
  });

  it('draws a Face ID key in the bottom-left slot when the sensor is a face', () => {
    const onBiometric = jest.fn();
    renderNumpad({ onBiometric, biometryType: 'face' });

    expect(screen.queryByTestId('numpad-spacer')).not.toBeInTheDocument();
    const key = screen.getByRole('button', { name: 'useFaceIdOrBiometric' });
    expect(key).toBe(screen.getByTestId('numpad-biometric'));
    expect(key.querySelector('[data-name="face-id"]')).toBeInTheDocument();
    // Still twelve slots, the biometric key in the tenth.
    expect(screen.getByTestId('numpad').children[9]).toBe(key);

    fireEvent.click(key);
    expect(onBiometric).toHaveBeenCalledTimes(1);
    expect(hapticLight).toHaveBeenCalledTimes(1);
  });

  // Keyed off the sensor, not the OS: a Touch ID iPhone and a fingerprint Android phone both get a
  // fingerprint, and drawing Face ID on them asks for a gesture the device does not have.
  it.each(['fingerprint', 'iris', 'multiple'] as const)(
    'draws a fingerprint key when the sensor is %s',
    biometryType => {
      renderNumpad({ onBiometric: jest.fn(), biometryType });

      const key = screen.getByTestId('numpad-biometric');
      expect(key.querySelector('[data-name="fingerprint"]')).toBeInTheDocument();
      expect(key.querySelector('[data-name="face-id"]')).not.toBeInTheDocument();
    }
  );

  it('names the biometric key with its localized label', () => {
    renderNumpad({ onBiometric: jest.fn() });

    expect(screen.getByRole('button', { name: 'useFaceIdOrBiometric' })).toBeInTheDocument();
  });

  it('applies the base grid classes and merges a custom className onto the container', () => {
    const { container } = renderNumpad({ className: 'custom-class' });

    const grid = container.firstElementChild as HTMLElement;
    expect(grid).toHaveClass('grid', 'grid-cols-3', 'gap-x-7', 'gap-y-4', 'w-fit', 'mx-auto', 'custom-class');
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

// A press that will be refused must not look accepted: the key carries the native attribute, so it
// neither animates nor fires the tap haptic. Entry and the biometric key have separate guards,
// because a passcode lockout refuses digits while the biometric key stays usable through it.
describe('refused keys', () => {
  it('disables the entry keys without touching the biometric key', () => {
    const onDigit = jest.fn();
    const onDelete = jest.fn();
    const onBiometric = jest.fn();
    render(<Numpad onDigit={onDigit} onDelete={onDelete} onBiometric={onBiometric} disabled />);

    for (const digit of DIGITS) {
      expect(screen.getByTestId(`numpad-${digit}`)).toBeDisabled();
    }
    expect(screen.getByTestId('numpad-delete')).toBeDisabled();
    expect(screen.getByTestId('numpad-biometric')).not.toBeDisabled();

    fireEvent.click(screen.getByTestId('numpad-5'));
    fireEvent.click(screen.getByTestId('numpad-delete'));
    expect(onDigit).not.toHaveBeenCalled();
    expect(onDelete).not.toHaveBeenCalled();
    expect(hapticLight).not.toHaveBeenCalled();
  });

  it('disables the biometric key alone', () => {
    const onBiometric = jest.fn();
    render(<Numpad onDigit={jest.fn()} onDelete={jest.fn()} onBiometric={onBiometric} biometricDisabled />);

    expect(screen.getByTestId('numpad-biometric')).toBeDisabled();
    expect(screen.getByTestId('numpad-1')).not.toBeDisabled();

    fireEvent.click(screen.getByTestId('numpad-biometric'));
    expect(onBiometric).not.toHaveBeenCalled();
    expect(hapticLight).not.toHaveBeenCalled();
  });

  it('carries the design system disabled treatment', () => {
    render(<Numpad onDigit={jest.fn()} onDelete={jest.fn()} onBiometric={jest.fn()} disabled />);

    expect(screen.getByTestId('numpad-1')).toHaveClass('disabled:cursor-default', 'disabled:opacity-50');
  });
});
