import React from 'react';

import { fireEvent, render, screen } from '@testing-library/react';

import { useAccount } from 'lib/miden/front';

import AdvancedSettings from './AdvancedSettings';

// `t` is never `init()`-ed in the unit env; echo the key back so rendered copy
// (the Button title) is assertable by key.
jest.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key })
}));

// `lib/miden/front` is a barrel over the SDK; mock only `useAccount`, the sole
// member AdvancedSettings imports, so we can steer the `account.publicKey`
// branch of `addressShortened`.
jest.mock('lib/miden/front', () => ({
  useAccount: jest.fn()
}));

// `ToggleSwitch` reaches into analytics / haptics / brand-colors. Render a plain
// controlled checkbox exposing `checked` and `name` so the `item.value !==
// undefined` branch is assertable without the native plumbing.
jest.mock('app/atoms/ToggleSwitch', () => ({
  __esModule: true,
  default: ({ checked, name }: { checked?: boolean; name?: string }) => (
    <input type="checkbox" data-testid="toggle-switch" name={name} checked={checked} readOnly />
  )
}));

// `components/Button` pulls in framer-motion / icons / haptics. Render a plain
// button that surfaces `title` and wires `onClick`/`disabled` so the resync
// action and its disabled state are assertable.
jest.mock('components/Button', () => ({
  Button: ({ onClick, title, disabled }: { onClick?: () => void; title?: string; disabled?: boolean }) => (
    <button data-testid="resync-button" onClick={onClick} disabled={disabled}>
      {title}
    </button>
  ),
  ButtonVariant: { Primary: 'primary', Secondary: 'secondary', Ghost: 'ghost' }
}));

const mockUseAccount = useAccount as jest.Mock;

beforeEach(() => {
  jest.clearAllMocks();
  mockUseAccount.mockReturnValue({ publicKey: '0x1234567890abcdef' });
});

describe('AdvancedSettings', () => {
  it('renders both list items with their titles and subtitles', () => {
    render(<AdvancedSettings />);

    // First item: static title + subtitle.
    expect(screen.getByText('Auto Close Generating Transaction Page')).toBeInTheDocument();
    expect(
      screen.getByText('Configure auto close of the generating transaction page after the transaction is generated')
    ).toBeInTheDocument();

    // Second item: subtitle is static; its title carries the shortened address.
    expect(
      screen.getByText('Reset all of your history for this account and resync with the network.')
    ).toBeInTheDocument();
  });

  it('shortens a present publicKey into the resync list-item title', () => {
    render(<AdvancedSettings />);

    // `${slice(0,7)}...${slice(-3)} ` => '0x12345...def ' with a trailing space.
    expect(screen.getByText('Resync 0x12345...def')).toBeInTheDocument();
  });

  it('renders an empty shortened address when publicKey is falsy', () => {
    mockUseAccount.mockReturnValue({ publicKey: '' });

    render(<AdvancedSettings />);

    // Falsy branch of `addressShortened` => title collapses to bare 'Resync'.
    expect(screen.getByText('Resync')).toBeInTheDocument();
    // No shortened form should appear.
    expect(screen.queryByText(/\.\.\./)).not.toBeInTheDocument();
  });

  it('renders a single ToggleSwitch only for the item that defines a value', () => {
    render(<AdvancedSettings />);

    // Only the first item has `value` defined => exactly one toggle, checked,
    // named 'popupEnabled'. The second item (value === undefined) has none.
    const toggles = screen.getAllByTestId('toggle-switch');
    expect(toggles).toHaveLength(1);
    expect(toggles[0]).toBeChecked();
    expect(toggles[0]).toHaveAttribute('name', 'popupEnabled');
  });

  it('renders an enabled resync button showing the resync label', () => {
    render(<AdvancedSettings />);

    const button = screen.getByTestId('resync-button');
    expect(button).toBeInTheDocument();
    // `isSubmitting` is always false => the 'resync' label branch is used and
    // the button is enabled.
    expect(button).toHaveTextContent('resync');
    expect(button).not.toBeDisabled();
  });

  it('invokes the (no-op) resync handler on click without error', () => {
    render(<AdvancedSettings />);

    // Exercises the `resync` function/onClick wiring; it is a no-op so this
    // only asserts the click is handled without throwing.
    expect(() => fireEvent.click(screen.getByTestId('resync-button'))).not.toThrow();
  });
});
