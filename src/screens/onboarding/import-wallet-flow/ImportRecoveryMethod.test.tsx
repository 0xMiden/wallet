import React from 'react';

import { act, render, screen, fireEvent } from '@testing-library/react';

import type { GuardianDiscoveryResult, GuardianProbeMatch } from 'lib/miden/guardian/discover';
import { DEFAULT_NETWORK, GUARDIAN_OPTIONS, getGuardianOptionsForNetwork } from 'lib/miden-chain/constants';

import { ImportRecoveryMethodScreen } from './ImportRecoveryMethod';
import { GuardianProbeState } from '../types';

// `react-i18next` drags in the full i18n runtime; stub `useTranslation` so
// `t(key)` echoes the key and we can assert against raw i18n keys.
jest.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key })
}));

// Pin the network to testnet: jest loads dotenv (`setupFiles`), so a developer
// `.env` with MIDEN_NETWORK=devnet would otherwise shrink the preset grid to
// the single devnet operator and break the multi-preset assertions below.
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
// screen actually drives. The screen renders TWO Buttons (Continue + skip), so
// the stub must forward the real data-testid instead of inventing one.
jest.mock('components/Button', () => ({
  ButtonVariant: { Primary: 'primary', Secondary: 'secondary', Ghost: 'ghost' },
  Button: ({ title, onClick, disabled, className, variant, 'data-testid': testId }: any) => (
    <button data-testid={testId} data-variant={variant} onClick={onClick} disabled={disabled} className={className}>
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

// Endpoint the component seeds `endpointInput` with (OpenZeppelin on the
// test network pinned above.
const DEFAULT_ENDPOINT = GUARDIAN_OPTIONS[0]!.endpoint.get(DEFAULT_NETWORK)!;

const renderScreen = (overrides: Partial<React.ComponentProps<typeof ImportRecoveryMethodScreen>> = {}) => {
  const onSubmit = jest.fn();
  const utils = render(<ImportRecoveryMethodScreen onSubmit={onSubmit} {...overrides} />);
  return { onSubmit, ...utils };
};

const continueButton = () => screen.getByTestId('recovery-method-continue') as HTMLButtonElement;
const skipButton = () => screen.getByTestId('recovery-method-skip-guardian') as HTMLButtonElement;
const guardianInput = () => screen.getByTestId('guardian-input') as HTMLInputElement;
const ozPreset = () => screen.getByRole('button', { name: /OpenZeppelin/ });
const gatewayPreset = () => screen.getByRole('button', { name: /Gateway Operator/ });
const customToggle = () => screen.getByRole('button', { name: /useDifferentGuardian/ });

beforeEach(() => {
  jest.clearAllMocks();
});

describe('ImportRecoveryMethodScreen (guardian-endpoint step)', () => {
  it('renders the title, description, and both actions', () => {
    renderScreen();

    expect(screen.getByTestId('import-recovery-method')).toBeInTheDocument();
    expect(screen.getByText('guardianEndpointStepTitle')).toBeInTheDocument();
    expect(screen.getByText('guardianEndpointStepDescription')).toBeInTheDocument();

    expect(continueButton()).toBeInTheDocument();
    expect(skipButton()).toBeInTheDocument();
    expect(skipButton()).toHaveTextContent('noGuardianSkip');
    expect(skipButton()).toHaveAttribute('data-variant', 'secondary');
  });

  it('shows presets, the endpoint readout, a down chevron, and no custom input by default', () => {
    renderScreen();

    // All testnet Guardian providers are offered as presets.
    expect(ozPreset()).toBeInTheDocument();
    expect(gatewayPreset()).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /LambdaClass/ })).toBeInTheDocument();
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

  it('submits the sanitized default endpoint on Continue (no wallet-type choice anymore)', () => {
    const { onSubmit } = renderScreen();

    fireEvent.click(continueButton());

    expect(onSubmit).toHaveBeenCalledWith({ guardianEndpoint: DEFAULT_ENDPOINT });
    expect(onSubmit.mock.calls[0]![0]).not.toHaveProperty('walletType');
  });

  it('submits an empty payload on skip — the user has no guardian', () => {
    const { onSubmit } = renderScreen();

    fireEvent.click(skipButton());

    expect(onSubmit).toHaveBeenCalledWith({});
  });

  it('shows the no-accounts-found error only when isError is set and the form is not dirty', () => {
    renderScreen({ isError: true });

    expect(screen.getByText('noAccountsFoundForSeed')).toBeInTheDocument();
  });

  it('does not show the error when isError is unset', () => {
    renderScreen({ isError: false });

    expect(screen.queryByText('noAccountsFoundForSeed')).not.toBeInTheDocument();
  });

  it('clears the error once the user interacts (dirty), e.g. picking a preset', () => {
    renderScreen({ isError: true });
    expect(screen.getByText('noAccountsFoundForSeed')).toBeInTheDocument();

    // Selecting a preset updates the endpoint, activates that preset, and marks
    // the form dirty so the stale error is suppressed.
    fireEvent.click(gatewayPreset());

    const gatewayEndpoint = GUARDIAN_OPTIONS.find(o => o.id === 'gateway')!.endpoint.get(DEFAULT_NETWORK)!;
    expect(screen.getByText(gatewayEndpoint)).toBeInTheDocument();
    expect(gatewayPreset()).toHaveClass('border-primary-500');
    expect(ozPreset()).toHaveClass('border-grey-200');
    expect(screen.queryByText('noAccountsFoundForSeed')).not.toBeInTheDocument();
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

    expect(onSubmit).toHaveBeenCalledWith({ guardianEndpoint: 'https://custom.example.com' });
  });

  it('disables Continue when the custom Guardian endpoint is invalid, but skip still works', () => {
    const { onSubmit } = renderScreen();

    fireEvent.click(customToggle());
    // Plain http on a non-localhost host is rejected by isValidGuardianUrl.
    fireEvent.change(guardianInput(), { target: { value: 'http://example.com' } });

    expect(continueButton()).toBeDisabled();
    expect(skipButton()).toBeEnabled();
    fireEvent.click(skipButton());
    expect(onSubmit).toHaveBeenCalledWith({});
  });
});

/**
 * Guardian auto-detection (issue #418). The screen is a pure function of the
 * `probe` prop: absent => the classic manual picker exercised above; probing =>
 * spinner with Continue held back; done-with-a-winner => the detected card;
 * anything else => the manual picker plus a retry affordance.
 */
describe('ImportRecoveryMethodScreen — guardian auto-detection', () => {
  const OZ_ENDPOINT = DEFAULT_ENDPOINT;
  const GATEWAY_OPTION = getGuardianOptionsForNetwork(DEFAULT_NETWORK).find(option => option.id === 'gateway');
  const OZ_OPTION = getGuardianOptionsForNetwork(DEFAULT_NETWORK).find(option => option.id === 'open-zeppelin')!;

  const match = (over: Partial<GuardianProbeMatch> = {}): GuardianProbeMatch => ({
    endpoint: OZ_ENDPOINT,
    option: OZ_OPTION,
    accountIds: ['acct-1'],
    hdIndices: [0],
    nonce: 7n,
    ...over
  });

  const done = (over: Partial<GuardianDiscoveryResult> = {}): GuardianProbeState => ({
    status: 'done',
    result: { matches: [], probedEndpoints: [OZ_ENDPOINT], failures: [], ...over }
  });

  const detected = (best: GuardianProbeMatch = match(), extras: GuardianProbeMatch[] = []): GuardianProbeState =>
    done({ best, matches: [best, ...extras] });

  const customToggleAfterDetection = () => screen.getByRole('button', { name: /useCustomGuardianInstead/ });

  it('shows a spinner and holds Continue back while probing', () => {
    renderScreen({ probe: { status: 'probing' } });

    expect(screen.getByTestId('guardian-probe-spinner')).toBeInTheDocument();
    expect(screen.getByText('detectingGuardian')).toBeInTheDocument();
    expect(continueButton()).toBeDisabled();

    // No picker while we're still deciding what to preselect.
    expect(screen.queryByRole('button', { name: /OpenZeppelin/ })).not.toBeInTheDocument();
    expect(screen.queryByTestId('guardian-input')).not.toBeInTheDocument();
  });

  it('lets the user skip while the probe is still running', () => {
    const { onSubmit } = renderScreen({ probe: { status: 'probing' } });

    expect(skipButton()).toBeEnabled();
    fireEvent.click(skipButton());
    expect(onSubmit).toHaveBeenCalledWith({});
  });

  it('treats an idle probe as not-running: classic picker, Continue enabled (post-reset state)', () => {
    renderScreen({ probe: { status: 'idle' } });

    // 'idle' is the initial / post-reset state — nothing will ever resolve it,
    // so it must NOT pin an eternal spinner.
    expect(screen.queryByTestId('guardian-probe-spinner')).not.toBeInTheDocument();
    expect(ozPreset()).toBeInTheDocument();
    expect(continueButton()).toBeEnabled();
  });

  it('reveals a manual escape hatch if the probe is still running after 10s', () => {
    jest.useFakeTimers();
    try {
      renderScreen({ probe: { status: 'probing' } });

      expect(screen.queryByRole('button', { name: /useCustomGuardianInstead/ })).not.toBeInTheDocument();

      act(() => {
        jest.advanceTimersByTime(10_000);
      });

      fireEvent.click(customToggleAfterDetection());
      expect(screen.getByRole('button', { name: /OpenZeppelin/ })).toBeInTheDocument();
      expect(screen.getByTestId('guardian-input')).toBeInTheDocument();
    } finally {
      jest.useRealTimers();
    }
  });

  it('lets a manual choice through the escape hatch continue while the probe is still running', () => {
    jest.useFakeTimers();
    try {
      const { onSubmit } = renderScreen({ probe: { status: 'probing' } });

      // Continue is blocked while the probe runs and nothing manual happened.
      expect(continueButton()).toBeDisabled();

      act(() => {
        jest.advanceTimersByTime(10_000);
      });

      // Opening the escape hatch IS the manual choice: the prefilled endpoint
      // is valid, so Continue works immediately — no redundant extra click.
      fireEvent.click(customToggleAfterDetection());
      expect(continueButton()).toBeEnabled();

      // A preset pick still works and wins over the in-flight probe.
      fireEvent.click(screen.getByRole('button', { name: /OpenZeppelin/ }));
      fireEvent.click(continueButton());
      expect(onSubmit).toHaveBeenCalledWith({ guardianEndpoint: OZ_ENDPOINT });
    } finally {
      jest.useRealTimers();
    }
  });

  it('hides the detected banner once the user overrides, so the banner never contradicts the submission', () => {
    const best = match({ endpoint: 'https://detected.example.com', option: undefined });
    const { onSubmit } = renderScreen({ probe: detected(best) });

    expect(screen.getByTestId('guardian-detected')).toBeInTheDocument();

    // User opens the disclosure and picks a different preset: the "found your
    // guardian" headline must go away — Continue now submits the manual pick.
    fireEvent.click(customToggleAfterDetection());
    fireEvent.click(screen.getByRole('button', { name: /Gateway Operator/ }));

    expect(screen.queryByTestId('guardian-detected')).not.toBeInTheDocument();
    fireEvent.click(continueButton());
    expect(onSubmit).toHaveBeenCalledWith({
      guardianEndpoint: expect.stringContaining('gateway')
    });
  });

  it('presents the detected guardian and submits its endpoint', () => {
    const best = match({ endpoint: 'https://detected.example.com', option: undefined });
    const { onSubmit } = renderScreen({ probe: detected(best) });

    expect(screen.getByTestId('guardian-detected')).toBeInTheDocument();
    expect(screen.getByText('guardianDetectedTitle')).toBeInTheDocument();
    expect(screen.getByText('https://detected.example.com')).toBeInTheDocument();
    expect(continueButton()).toBeEnabled();

    fireEvent.click(continueButton());

    expect(onSubmit).toHaveBeenCalledWith({ guardianEndpoint: 'https://detected.example.com' });
  });

  it('strips a trailing slash from the detected endpoint before submitting', () => {
    const { onSubmit } = renderScreen({ probe: detected(match({ endpoint: 'https://detected.example.com/' })) });

    fireEvent.click(continueButton());

    expect(onSubmit).toHaveBeenCalledWith({ guardianEndpoint: 'https://detected.example.com' });
  });

  it("shows the operator's location and a note when more than one guardian answered", () => {
    renderScreen({ probe: detected(match(), [match({ endpoint: 'https://stale.example.com', nonce: 2n })]) });

    expect(screen.getByText(OZ_OPTION.location)).toBeInTheDocument();
    expect(screen.getByText('guardianDetectedMultiple')).toBeInTheDocument();
  });

  it('hides the multi-match note when exactly one guardian answered', () => {
    renderScreen({ probe: detected() });

    expect(screen.queryByText('guardianDetectedMultiple')).not.toBeInTheDocument();
  });

  it('keeps the preset grid behind a disclosure once a guardian is detected', () => {
    renderScreen({ probe: detected() });

    expect(screen.queryByRole('button', { name: /OpenZeppelin/ })).not.toBeInTheDocument();

    fireEvent.click(customToggleAfterDetection());

    expect(screen.getByRole('button', { name: /OpenZeppelin/ })).toBeInTheDocument();
    expect(screen.getByTestId('guardian-input')).toBeInTheDocument();
  });

  it('never clobbers an endpoint the user chose, even when a probe result lands later', () => {
    if (!GATEWAY_OPTION) return; // Networks with a single operator have nothing to override with.
    const { rerender, onSubmit } = renderScreen({ probe: { status: 'error', message: 'boom' } });

    fireEvent.click(screen.getByRole('button', { name: /Gateway Operator/ }));
    expect(screen.getByText(GATEWAY_OPTION.endpoint)).toBeInTheDocument();

    // A late probe result must not silently move the user off their choice.
    rerender(<ImportRecoveryMethodScreen onSubmit={onSubmit} probe={detected()} />);

    expect(screen.getByText(GATEWAY_OPTION.endpoint)).toBeInTheDocument();
    fireEvent.click(continueButton());
    expect(onSubmit).toHaveBeenCalledWith({ guardianEndpoint: GATEWAY_OPTION.endpoint });
  });

  it('never clobbers a custom URL the user typed', () => {
    const { rerender, onSubmit } = renderScreen({ probe: done() });

    fireEvent.click(customToggle());
    fireEvent.change(guardianInput(), { target: { value: 'https://mine.example.com' } });

    rerender(<ImportRecoveryMethodScreen onSubmit={onSubmit} probe={detected()} />);

    expect(guardianInput()).toHaveValue('https://mine.example.com');
  });

  it('falls back to the manual picker with a retry link when nothing was detected', () => {
    const onRetryProbe = jest.fn();
    renderScreen({ probe: done(), onRetryProbe });

    expect(screen.getByTestId('guardian-not-detected')).toBeInTheDocument();
    expect(screen.getByText('guardianNotDetected')).toBeInTheDocument();
    // Exactly today's screen underneath.
    expect(screen.getByRole('button', { name: /OpenZeppelin/ })).toBeInTheDocument();
    expect(screen.getByText('guardianEndpoint')).toBeInTheDocument();
    expect(continueButton()).toBeEnabled();

    fireEvent.click(screen.getByRole('button', { name: /retryGuardianDetection/ }));
    expect(onRetryProbe).toHaveBeenCalledTimes(1);
  });

  it('warns that detection may be incomplete when some operators were unreachable', () => {
    renderScreen({
      probe: done({ failures: [{ endpoint: OZ_ENDPOINT, reason: 'timeout', message: 'timed out' }] })
    });

    expect(screen.getByText('guardianProbePartialFailure')).toBeInTheDocument();
  });

  it('omits the partial-failure warning when every operator answered', () => {
    renderScreen({ probe: done() });

    expect(screen.queryByText('guardianProbePartialFailure')).not.toBeInTheDocument();
  });

  it('omits the retry link when the host cannot re-run the probe', () => {
    renderScreen({ probe: done() });

    expect(screen.queryByRole('button', { name: /retryGuardianDetection/ })).not.toBeInTheDocument();
  });

  it('falls back to the manual picker when the probe itself errored', () => {
    renderScreen({ probe: { status: 'error', message: 'network down' } });

    expect(screen.getByTestId('guardian-not-detected')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /OpenZeppelin/ })).toBeInTheDocument();
    expect(continueButton()).toBeEnabled();
  });

  it('still surfaces the post-register not-found error alongside a detected guardian', () => {
    renderScreen({ probe: detected(), isError: true });

    expect(screen.getByText('noAccountsFoundForSeed')).toBeInTheDocument();
  });
});
