import React from 'react';

import { render, screen, fireEvent } from '@testing-library/react';

import { isIOS } from 'lib/platform';

import ChooseProtectionScreen, { ChooseProtectionScreen as NamedChooseProtectionScreen } from './ChooseProtection';

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

// `react-i18next` pulls in the full i18n runtime; stub `useTranslation` so
// `t(key)` echoes the key back and every rendered label is the raw key.
jest.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key })
}));

jest.mock('lib/platform', () => ({
  isIOS: jest.fn()
}));

// `Button` — render the title and forward the click so each `onSelect*`
// wiring and the chosen variant can be verified. Expose `Secondary` since the
// passcode button uses `ButtonVariant.Secondary`.
jest.mock('components/Button', () => ({
  Button: ({ title, onClick, variant }: { title: string; onClick?: () => void; variant?: string }) => (
    <button data-testid={`btn-${title}`} data-variant={variant ?? 'default'} onClick={onClick}>
      {title}
    </button>
  ),
  ButtonVariant: { Primary: 'primary', Secondary: 'secondary', Ghost: 'ghost' }
}));

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const renderComponent = (props: Partial<React.ComponentProps<typeof ChooseProtectionScreen>> = {}) =>
  render(<ChooseProtectionScreen {...props} />);

const mockIsIOS = isIOS as jest.Mock;

describe('ChooseProtectionScreen', () => {
  beforeEach(() => {
    mockIsIOS.mockReturnValue(false);
  });

  it('renders the onboarding container with its test id', () => {
    renderComponent();
    expect(screen.getByTestId('onboarding-choose-protection')).toBeInTheDocument();
  });

  it('renders the illustration in the body and both choices pinned in the step footer', () => {
    const { container } = renderComponent();
    const svg = container.querySelector('svg');
    expect(svg).toHaveClass('max-w-[278px]');
    expect(svg).toHaveAttribute('aria-hidden', 'true');
    expect(screen.getByRole('heading', { level: 1 })).toHaveClass('text-title-tab');
    const buttons = screen.getAllByRole('button');
    buttons.forEach(b => expect(b.closest('[data-slot="footer"]')).not.toBeNull());
  });

  it('renders the translated heading copy', () => {
    renderComponent();
    expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent('chooseHowToProtect');
  });

  it('renders the Android biometric label as the default (primary) variant', () => {
    renderComponent();
    const button = screen.getByTestId('btn-biometricSetUp');
    expect(button).toHaveTextContent('biometricSetUp');
    expect(button).toHaveAttribute('data-variant', 'default');
  });

  it('renders the iOS Face ID label', () => {
    mockIsIOS.mockReturnValue(true);
    renderComponent();

    expect(screen.getByTestId('btn-faceIdSetUp')).toHaveTextContent('faceIdSetUp');
  });

  it('renders the passcode button with the secondary variant', () => {
    renderComponent();
    const button = screen.getByTestId('btn-setUpYourPasscode');
    expect(button).toHaveTextContent('setUpYourPasscode');
    expect(button).toHaveAttribute('data-variant', 'secondary');
  });

  it('invokes onSelectBiometric when the biometric button is clicked', () => {
    const onSelectBiometric = jest.fn();
    renderComponent({ onSelectBiometric });

    fireEvent.click(screen.getByTestId('btn-biometricSetUp'));
    expect(onSelectBiometric).toHaveBeenCalledTimes(1);
  });

  it('invokes onSelectPasscode when the passcode button is clicked', () => {
    const onSelectPasscode = jest.fn();
    renderComponent({ onSelectPasscode });

    fireEvent.click(screen.getByTestId('btn-setUpYourPasscode'));
    expect(onSelectPasscode).toHaveBeenCalledTimes(1);
  });

  it('does not fire either callback before any interaction', () => {
    const onSelectBiometric = jest.fn();
    const onSelectPasscode = jest.fn();
    renderComponent({ onSelectBiometric, onSelectPasscode });

    expect(onSelectBiometric).not.toHaveBeenCalled();
    expect(onSelectPasscode).not.toHaveBeenCalled();
  });

  it('does not throw when clicked without any handlers (undefined onClick)', () => {
    renderComponent();

    expect(() => {
      fireEvent.click(screen.getByTestId('btn-biometricSetUp'));
      fireEvent.click(screen.getByTestId('btn-setUpYourPasscode'));
    }).not.toThrow();
  });

  it('exposes the same component as its default and named export', () => {
    expect(NamedChooseProtectionScreen).toBe(ChooseProtectionScreen);
  });
});
