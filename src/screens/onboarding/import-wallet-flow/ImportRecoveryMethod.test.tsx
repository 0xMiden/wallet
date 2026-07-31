import React from 'react';

import { render, screen, fireEvent } from '@testing-library/react';

import { DEFAULT_NETWORK, GUARDIAN_OPTIONS } from 'lib/miden-chain/constants';

import { ImportRecoveryMethodScreen } from './ImportRecoveryMethod';
import { WalletType } from '../types';

// `react-i18next` drags in the full i18n runtime; stub `useTranslation` so
// `t(key)` echoes the key and we can assert against raw i18n keys.
jest.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key })
}));

// This suite exercises selection between multiple presets, so pin the
// component to testnet regardless of the MIDEN_NETWORK used to invoke Jest.
jest.mock('lib/miden-chain/constants', () => {
  const actual = jest.requireActual<typeof import('lib/miden-chain/constants')>('lib/miden-chain/constants');
  return {
    ...actual,
    DEFAULT_NETWORK: actual.MIDEN_NETWORK_NAME.TESTNET,
    getGuardianOptionsForNetwork: (network = actual.MIDEN_NETWORK_NAME.TESTNET) =>
      actual.getGuardianOptionsForNetwork(network)
  };
});

// Leaf UI components pull in framer-motion / Capacitor haptics /
// react-currency-input-field / radix-slot which are irrelevant to this
// screen's logic. Stub them to the smallest DOM that preserves the props the
// screen actually drives.
jest.mock('components/Button', () => ({
  Button: ({ title, onClick, disabled, className }: any) => (
    <button data-testid="continue-button" onClick={onClick} disabled={disabled} className={className}>
      {title}
    </button>
  )
}));

jest.mock('components/Input', () => ({
  // Forward rest props so the keyboard attributes (inputmode, autocapitalize,
  // autocorrect, spellcheck) and the Enter-to-blur handler reach the DOM and
  // are assertable.
  Input: ({ id, value, placeholder, onChange, ...rest }: any) => (
    <input data-testid="guardian-input" id={id} value={value} placeholder={placeholder} onChange={onChange} {...rest} />
  )
}));

jest.mock('app/icons/v2', () => ({
  IconName: { ChevronUp: 'ChevronUp', ChevronDown: 'ChevronDown' },
  Icon: ({ name, size }: any) => <span data-testid="chevron-icon" data-name={name} data-size={size} />
}));

jest.mock('lib/ui/badge', () => ({
  Badge: ({ variant, className, children }: any) => (
    <span data-testid="default-badge" data-variant={variant} className={className}>
      {children}
    </span>
  )
}));

// Endpoint the component seeds `endpointInput` with (OpenZeppelin on the
// test network pinned above.
const DEFAULT_ENDPOINT = GUARDIAN_OPTIONS[0]!.endpoint.get(DEFAULT_NETWORK)!;

const renderScreen = (overrides: Partial<React.ComponentProps<typeof ImportRecoveryMethodScreen>> = {}) => {
  const onSubmit = jest.fn();
  const utils = render(<ImportRecoveryMethodScreen onSubmit={onSubmit} {...overrides} />);
  return { onSubmit, ...utils };
};

const continueButton = () => screen.getByTestId('continue-button') as HTMLButtonElement;
const guardianInput = () => screen.getByTestId('guardian-input') as HTMLInputElement;
const ozPreset = () => screen.getByRole('button', { name: /Open-Zeppelin/ });
const gatewayPreset = () => screen.getByRole('button', { name: /Gateway Operator/ });
const customToggle = () => screen.getByRole('button', { name: /useDifferentGuardian/ });
const selectGuardian = () => fireEvent.click(screen.getByText('importViaGuardian'));
const selectOnChain = () => fireEvent.click(screen.getByText('importPublicAccount'));

beforeEach(() => {
  jest.clearAllMocks();
});

describe('ImportRecoveryMethodScreen', () => {
  it('renders the title, both options, and the default Guardian badge', () => {
    renderScreen();

    expect(screen.getByTestId('import-recovery-method')).toBeInTheDocument();
    expect(screen.getByText('importRecoveryMethodTitle')).toBeInTheDocument();
    expect(screen.getByText('chooseRecoveryMethodDescription')).toBeInTheDocument();

    // Both option cards render, each with title + description.
    expect(screen.getByText('importViaGuardian')).toBeInTheDocument();
    expect(screen.getByText('importViaGuardianDescription')).toBeInTheDocument();
    expect(screen.getByText('importPublicAccount')).toBeInTheDocument();
    expect(screen.getByText('importPublicAccountDescription')).toBeInTheDocument();

    // Only the Guardian option is flagged as default.
    const badge = screen.getByTestId('default-badge');
    expect(badge).toHaveTextContent('default');
    expect(badge).toHaveAttribute('data-variant', 'default');
  });

  it('defaults to Guardian: shows presets, the endpoint readout, a down chevron, and no custom input', () => {
    renderScreen();

    // All testnet Guardian providers are offered as presets.
    expect(ozPreset()).toBeInTheDocument();
    expect(gatewayPreset()).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Lambda Class/ })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Koda/ })).toBeInTheDocument();

    // The seeded OpenZeppelin preset is active; the others are not.
    expect(ozPreset()).toHaveClass('border-primary-500');
    expect(gatewayPreset()).toHaveClass('border-grey-200');

    // Not customizing: the endpoint readout is shown, the input is not.
    expect(screen.getByText('guardianEndpoint')).toBeInTheDocument();
    expect(screen.getByText(DEFAULT_ENDPOINT)).toBeInTheDocument();
    expect(screen.queryByTestId('guardian-input')).not.toBeInTheDocument();

    // Chevron points down while collapsed.
    expect(screen.getByTestId('chevron-icon')).toHaveAttribute('data-name', 'ChevronDown');

    // The default endpoint is a valid https URL, so Continue is enabled.
    expect(continueButton()).toBeEnabled();
  });

  it('submits the Guardian wallet type with the sanitized default endpoint', () => {
    const { onSubmit } = renderScreen();

    fireEvent.click(continueButton());

    expect(onSubmit).toHaveBeenCalledWith({
      walletType: WalletType.Guardian,
      guardianEndpoint: DEFAULT_ENDPOINT
    });
  });

  it('shows the not-found error only when isError is set, not dirty, and Guardian is selected', () => {
    renderScreen({ isError: true });

    expect(screen.getByText('guardianAccountNotFound')).toBeInTheDocument();
  });

  it('does not show the error when isError is unset', () => {
    renderScreen({ isError: false });

    expect(screen.queryByText('guardianAccountNotFound')).not.toBeInTheDocument();
  });

  it('clears the error once the user interacts (dirty), e.g. picking a preset', () => {
    renderScreen({ isError: true });
    expect(screen.getByText('guardianAccountNotFound')).toBeInTheDocument();

    // Selecting a preset updates the endpoint, activates that preset, and marks
    // the form dirty so the stale error is suppressed.
    fireEvent.click(gatewayPreset());

    const gatewayEndpoint = GUARDIAN_OPTIONS.find(o => o.id === 'gateway')!.endpoint.get(DEFAULT_NETWORK)!;
    expect(screen.getByText(gatewayEndpoint)).toBeInTheDocument();
    expect(gatewayPreset()).toHaveClass('border-primary-500');
    expect(ozPreset()).toHaveClass('border-grey-200');
    expect(screen.queryByText('guardianAccountNotFound')).not.toBeInTheDocument();
  });

  it('toggles the custom endpoint editor open and closed', () => {
    renderScreen();

    // Open: input appears, readout hides, chevron flips up, presets go inactive
    // (isActive is gated on !isCustomizing).
    fireEvent.click(customToggle());
    expect(guardianInput()).toBeInTheDocument();
    expect(guardianInput()).toHaveValue(DEFAULT_ENDPOINT);
    expect(guardianInput()).toHaveAttribute('placeholder', DEFAULT_ENDPOINT);
    expect(screen.queryByText('guardianEndpoint')).not.toBeInTheDocument();
    expect(screen.getByTestId('chevron-icon')).toHaveAttribute('data-name', 'ChevronUp');
    expect(ozPreset()).toHaveClass('border-grey-200');

    // Close again: input hides, readout returns, chevron flips down.
    fireEvent.click(customToggle());
    expect(screen.queryByTestId('guardian-input')).not.toBeInTheDocument();
    expect(screen.getByText('guardianEndpoint')).toBeInTheDocument();
    expect(screen.getByTestId('chevron-icon')).toHaveAttribute('data-name', 'ChevronDown');
  });

  it('gives the custom endpoint field a url keyboard, autocorrect off, and Enter-to-blur', () => {
    renderScreen();
    fireEvent.click(customToggle());

    const input = guardianInput();
    expect(input.getAttribute('inputmode')).toBe('url');
    expect(input.getAttribute('autocapitalize')).toBe('none');
    expect(input.getAttribute('autocorrect')).toBe('off');
    expect(input.getAttribute('spellcheck')).toBe('false');

    // Enter blurs the field so the mobile keyboard's 'Done' key dismisses it.
    input.focus();
    expect(document.activeElement).toBe(input);
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(document.activeElement).not.toBe(input);
  });

  it('submits a custom endpoint with trailing slashes stripped', () => {
    const { onSubmit } = renderScreen();

    fireEvent.click(customToggle());
    fireEvent.change(guardianInput(), { target: { value: 'https://custom.example.com/' } });
    expect(guardianInput()).toHaveValue('https://custom.example.com/');

    expect(continueButton()).toBeEnabled();
    fireEvent.click(continueButton());

    expect(onSubmit).toHaveBeenCalledWith({
      walletType: WalletType.Guardian,
      guardianEndpoint: 'https://custom.example.com'
    });
  });

  it('disables Continue when the custom Guardian endpoint is invalid', () => {
    renderScreen();

    fireEvent.click(customToggle());
    // Plain http on a non-localhost host is rejected by isValidGuardianUrl.
    fireEvent.change(guardianInput(), { target: { value: 'http://example.com' } });

    expect(continueButton()).toBeDisabled();
  });

  it('switches to the on-chain option: hides the Guardian block and submits on-chain', () => {
    const { onSubmit } = renderScreen();

    selectOnChain();

    // Guardian-only UI is gone.
    expect(screen.queryByText('guardianEndpoint')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Open-Zeppelin/ })).not.toBeInTheDocument();

    // On-chain never needs an endpoint, so Continue is enabled.
    expect(continueButton()).toBeEnabled();
    fireEvent.click(continueButton());

    expect(onSubmit).toHaveBeenCalledWith({ walletType: WalletType.OnChain });
    expect(onSubmit).toHaveBeenCalledTimes(1);
    expect(onSubmit.mock.calls[0]![0]).not.toHaveProperty('guardianEndpoint');
  });

  it('collapses the custom editor when switching to on-chain, and restores Guardian on re-select', () => {
    renderScreen();

    // Open the custom editor first so we can prove on-chain collapses it.
    fireEvent.click(customToggle());
    expect(guardianInput()).toBeInTheDocument();

    selectOnChain();
    expect(screen.queryByTestId('guardian-input')).not.toBeInTheDocument();
    expect(screen.queryByText('guardianEndpoint')).not.toBeInTheDocument();

    // Re-selecting Guardian brings the Guardian block back, collapsed.
    selectGuardian();
    expect(screen.getByText('guardianEndpoint')).toBeInTheDocument();
    expect(screen.getByTestId('chevron-icon')).toHaveAttribute('data-name', 'ChevronDown');
    expect(ozPreset()).toBeInTheDocument();
  });
});
