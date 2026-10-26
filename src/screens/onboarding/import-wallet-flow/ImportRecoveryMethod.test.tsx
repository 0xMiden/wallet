import React from 'react';

import { act, render, screen, fireEvent } from '@testing-library/react';

import type { GuardianDiscoveryResult, GuardianProbeMatch } from 'lib/miden/guardian/discover';
import { GUARDIAN_OPTIONS, MIDEN_NETWORK_NAME, getGuardianOptionsForNetwork } from 'lib/miden-chain/constants';
import { _resetGuardianRegistryForTest, setDocumentGuardians } from 'lib/miden-chain/guardian-registry';
import { reportUserVisibleError } from 'lib/telemetry/user-visible-error';

import { ImportRecoveryMethodScreen } from './ImportRecoveryMethod';
import { GuardianProbeState, WalletType } from '../types';

// `react-i18next` drags in the full i18n runtime; stub `useTranslation` so
// `t(key)` echoes the key and we can assert against raw i18n keys.
jest.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key })
}));

// Pin the effective network to testnet: jest loads dotenv (`setupFiles`), so a
// developer `.env` with MIDEN_NETWORK=devnet would otherwise shrink the preset
// grid to the single devnet operator and break the multi-preset assertions
// below. The mainnet cases set it, as a stored network choice does.
const DEFAULT_NETWORK = MIDEN_NETWORK_NAME.TESTNET;
let mockEffectiveNetwork: MIDEN_NETWORK_NAME = MIDEN_NETWORK_NAME.TESTNET;
// The developer's custom Guardian, set while the effective network is the one it belongs to.
let mockCustomGuardian = '';
jest.mock('lib/miden-chain/effective-endpoints', () => ({
  ...jest.requireActual('lib/miden-chain/effective-endpoints'),
  getEffectiveNetworkName: () => mockEffectiveNetwork,
  getEffectiveGuardianUrl: () => mockCustomGuardian
}));

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

jest.mock('components/ui/TextField', () => ({
  // Forward rest props so the keyboard attributes (inputmode, autocapitalize,
  // autocorrect, spellcheck) and the Enter-to-blur handler reach the DOM and
  // are assertable.
  TextField: ({ id, value, placeholder, onChange, label: _label, ...rest }: any) => (
    <input data-testid="guardian-input" id={id} value={value} placeholder={placeholder} onChange={onChange} {...rest} />
  )
}));

jest.mock('components/ui/Checkbox', () => ({
  ...jest.requireActual('components/ui/Checkbox'),
  CheckboxConsent: ({ checked, onCheckedChange, children, 'data-testid': testId }: any) => (
    <button
      type="button"
      role="checkbox"
      aria-checked={checked}
      data-testid={testId}
      onClick={() => onCheckedChange(!checked)}
    >
      {children}
    </button>
  )
}));

jest.mock('app/icons/v2', () => ({
  IconName: { ChevronUp: 'ChevronUp', ChevronDown: 'ChevronDown', Checkmark: 'Checkmark' },
  Icon: ({ name, size }: any) => (
    <span data-testid={name === 'Checkmark' ? 'check-icon' : 'chevron-icon'} data-name={name} data-size={size} />
  )
}));

jest.mock('components/ui/Pill', () => ({
  Pill: ({ tone, className, children, 'data-testid': dataTestId }: any) => (
    <span data-testid={dataTestId} data-tone={tone} className={className}>
      {children}
    </span>
  )
}));

// Endpoint the component seeds `endpointInput` with (OpenZeppelin on the
// test network pinned above.
const DEFAULT_ENDPOINT = GUARDIAN_OPTIONS[0]!.endpoint.get(DEFAULT_NETWORK)!;
const GATEWAY_ENDPOINT = GUARDIAN_OPTIONS.find(option => option.id === 'gateway')!.endpoint.get(DEFAULT_NETWORK)!;

const renderScreen = (overrides: Partial<React.ComponentProps<typeof ImportRecoveryMethodScreen>> = {}) => {
  const onSubmit = jest.fn();
  const utils = render(<ImportRecoveryMethodScreen onSubmit={onSubmit} {...overrides} />);
  return { onSubmit, ...utils };
};

const continueButton = () => screen.getByTestId('continue-button') as HTMLButtonElement;
const acknowledgeReusedPhrase = () => fireEvent.click(screen.getByTestId('reused-phrase-acknowledge'));
const guardianInput = () => screen.getByTestId('guardian-input') as HTMLInputElement;
const ozPreset = () => screen.getByRole('radio', { name: /OpenZeppelin/ });
const gatewayPreset = () => screen.getByRole('radio', { name: /Gateway Operator/ });
const customToggle = () => screen.getByRole('button', { name: /useDifferentGuardian/ });
const selectGuardian = () => fireEvent.click(screen.getByText('importViaGuardian'));
const selectOnChain = () => fireEvent.click(screen.getByText('importPublicAccount'));

beforeEach(() => {
  jest.clearAllMocks();
  mockEffectiveNetwork = MIDEN_NETWORK_NAME.TESTNET;
  mockCustomGuardian = '';
});

afterEach(() => {
  _resetGuardianRegistryForTest();
});

jest.mock('lib/telemetry/user-visible-error', () => ({ reportUserVisibleError: jest.fn() }));
const privateErrorFixture =
  'failure 0x1234abcd amount 42 abandon ability able about above absent absorb abstract absurd abuse access accident';
const dwellForError = () => {
  act(() => {
    jest.advanceTimersByTime(999);
  });
  expect(reportUserVisibleError).not.toHaveBeenCalled();
  act(() => {
    jest.advanceTimersByTime(1);
  });
};
const expectDisplayReport = (id: string, surface: string) => {
  expect(reportUserVisibleError).toHaveBeenCalledTimes(1);
  expect(reportUserVisibleError).toHaveBeenCalledWith(id, surface);
  expect(JSON.stringify(jest.mocked(reportUserVisibleError).mock.calls)).not.toContain(privateErrorFixture);
};

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
    expect(badge).toHaveAttribute('data-tone', 'selected');
  });

  it('lays out on the step layout: the choice as radio cards, presets as radio cards, Continue pinned', () => {
    renderScreen();
    const choice = screen.getByRole('radiogroup', { name: 'importRecoveryMethodTitle' });
    expect(screen.getByRole('radio', { name: 'importViaGuardian' })).toHaveAttribute('aria-checked', 'true');
    expect(choice).toContainElement(screen.getByRole('radio', { name: 'importPublicAccount' }));
    expect(screen.getByRole('radiogroup', { name: 'guardianEndpoint' })).toContainElement(ozPreset());
    expect(screen.getByRole('heading', { level: 1, name: 'importRecoveryMethodTitle' })).toBeInTheDocument();
    expect(continueButton().closest('[data-slot="footer"]')).not.toBeNull();
    expect(customToggle()).toHaveClass('text-accent-tint-ink');
    expect(customToggle()).toHaveAttribute('aria-expanded', 'false');
  });

  it('defaults to Guardian: shows presets, the endpoint readout, a down chevron, and no custom input', () => {
    renderScreen();

    // All testnet Guardian providers are offered as presets.
    expect(ozPreset()).toBeInTheDocument();
    expect(gatewayPreset()).toBeInTheDocument();
    expect(screen.getByRole('radio', { name: /LambdaClass/ })).toBeInTheDocument();
    expect(screen.getByRole('radio', { name: /Koda/ })).toBeInTheDocument();

    // The seeded OpenZeppelin preset is active; the others are not.
    expect(ozPreset()).toHaveAttribute('aria-checked', 'true');
    expect(gatewayPreset()).toHaveAttribute('aria-checked', 'false');

    // Not customizing: the endpoint readout is shown, the input is not.
    expect(screen.getByText('guardianEndpoint')).toBeInTheDocument();
    expect(screen.getByText(DEFAULT_ENDPOINT)).toBeInTheDocument();
    expect(screen.queryByTestId('guardian-input')).not.toBeInTheDocument();

    // Chevron points down while collapsed.
    expect(screen.getByTestId('chevron-icon')).toHaveAttribute('data-name', 'ChevronDown');

    // The default endpoint is a valid https URL, so Continue is enabled.
    expect(continueButton()).toBeEnabled();
  });

  it('highlights a preset matching a host-case spelling of its endpoint', () => {
    renderScreen();

    fireEvent.click(customToggle());
    fireEvent.change(guardianInput(), { target: { value: GATEWAY_ENDPOINT.toUpperCase() } });
    fireEvent.click(customToggle());

    expect(gatewayPreset()).toHaveAttribute('aria-checked', 'true');
    expect(ozPreset()).toHaveAttribute('aria-checked', 'false');
  });

  it('submits the Guardian wallet type with the sanitized default endpoint', () => {
    const { onSubmit } = renderScreen();

    fireEvent.click(continueButton());

    expect(onSubmit).toHaveBeenCalledWith({
      walletType: WalletType.Guardian,
      guardianEndpoint: DEFAULT_ENDPOINT
    });
  });

  it('shows the not-found error only when error is set, not dirty, and Guardian is selected', () => {
    renderScreen({ error: 'guardianAccountNotFound' });

    expect(screen.getByText('guardianAccountNotFound')).toBeInTheDocument();
  });

  it('does not show the error when error is unset', () => {
    renderScreen();

    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('shows the real reason when the failure is not a not-found', () => {
    renderScreen({ error: 'This key is no longer active for the account. Paste the current everyday key.' });

    expect(screen.getByRole('alert')).toHaveTextContent('This key is no longer active for the account.');
    expect(screen.queryByText('guardianAccountNotFound')).toBeNull();
  });

  it('clears the error once the user interacts (dirty), e.g. picking a preset', () => {
    renderScreen({ error: 'guardianAccountNotFound' });
    expect(screen.getByText('guardianAccountNotFound')).toBeInTheDocument();

    // Selecting a preset updates the endpoint, activates that preset, and marks
    // the form dirty so the stale error is suppressed.
    fireEvent.click(gatewayPreset());

    const gatewayEndpoint = GUARDIAN_OPTIONS.find(o => o.id === 'gateway')!.endpoint.get(DEFAULT_NETWORK)!;
    expect(screen.getByText(gatewayEndpoint)).toBeInTheDocument();
    expect(gatewayPreset()).toHaveAttribute('aria-checked', 'true');
    expect(ozPreset()).toHaveAttribute('aria-checked', 'false');
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
    expect(ozPreset()).toHaveAttribute('aria-checked', 'false');

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
    expect(screen.queryByRole('radio', { name: /OpenZeppelin/ })).not.toBeInTheDocument();

    // On-chain never needs an endpoint; it needs the reused-phrase acknowledgement instead.
    acknowledgeReusedPhrase();
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
    expect(screen.queryByRole('radio', { name: /OpenZeppelin/ })).not.toBeInTheDocument();
    expect(screen.queryByTestId('guardian-input')).not.toBeInTheDocument();
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
      expect(screen.getByRole('radio', { name: /OpenZeppelin/ })).toBeInTheDocument();
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
      fireEvent.click(screen.getByRole('radio', { name: /OpenZeppelin/ }));
      fireEvent.click(continueButton());
      expect(onSubmit).toHaveBeenCalledWith({
        walletType: WalletType.Guardian,
        guardianEndpoint: OZ_ENDPOINT
      });
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
    fireEvent.click(screen.getByRole('radio', { name: /Gateway Operator/ }));

    expect(screen.queryByTestId('guardian-detected')).not.toBeInTheDocument();
    fireEvent.click(continueButton());
    expect(onSubmit).toHaveBeenCalledWith({
      walletType: WalletType.Guardian,
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

    expect(onSubmit).toHaveBeenCalledWith({
      walletType: WalletType.Guardian,
      guardianEndpoint: 'https://detected.example.com'
    });
  });

  it('strips a trailing slash from the detected endpoint before submitting', () => {
    const { onSubmit } = renderScreen({ probe: detected(match({ endpoint: 'https://detected.example.com/' })) });

    fireEvent.click(continueButton());

    expect(onSubmit).toHaveBeenCalledWith({
      walletType: WalletType.Guardian,
      guardianEndpoint: 'https://detected.example.com'
    });
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

    expect(screen.queryByRole('radio', { name: /OpenZeppelin/ })).not.toBeInTheDocument();

    fireEvent.click(customToggleAfterDetection());

    expect(screen.getByRole('radio', { name: /OpenZeppelin/ })).toBeInTheDocument();
    expect(screen.getByTestId('guardian-input')).toBeInTheDocument();
  });

  it('never clobbers an endpoint the user chose, even when a probe result lands later', () => {
    if (!GATEWAY_OPTION) return; // Networks with a single operator have nothing to override with.
    const { rerender, onSubmit } = renderScreen({ probe: { status: 'error', message: 'boom' } });

    fireEvent.click(screen.getByRole('radio', { name: /Gateway Operator/ }));
    expect(screen.getByText(GATEWAY_OPTION.endpoint)).toBeInTheDocument();

    // A late probe result must not silently move the user off their choice.
    rerender(<ImportRecoveryMethodScreen onSubmit={onSubmit} probe={detected()} />);

    expect(screen.getByText(GATEWAY_OPTION.endpoint)).toBeInTheDocument();
    fireEvent.click(continueButton());
    expect(onSubmit).toHaveBeenCalledWith({
      walletType: WalletType.Guardian,
      guardianEndpoint: GATEWAY_OPTION.endpoint
    });
  });

  it('never clobbers a custom URL the user typed', () => {
    const { rerender, onSubmit } = renderScreen({ probe: done() });

    fireEvent.click(customToggle());
    fireEvent.change(guardianInput(), { target: { value: 'https://mine.example.com' } });

    rerender(<ImportRecoveryMethodScreen onSubmit={onSubmit} probe={detected()} />);

    expect(guardianInput()).toHaveValue('https://mine.example.com');
  });

  it('says no backup was found, and offers a new account, when every Guardian answered with none', () => {
    const onCreateNew = jest.fn();
    renderScreen({ probe: done(), onCreateNew });

    expect(screen.getByTestId('guardian-no-backup')).toBeInTheDocument();
    expect(screen.getByText('guardianNoBackupFoundTitle')).toBeInTheDocument();
    expect(screen.queryByTestId('guardian-lookup-uncertain')).not.toBeInTheDocument();
    // Exactly today's screen underneath: a Guardian the probe cannot list is still reachable.
    expect(screen.getByRole('radio', { name: /OpenZeppelin/ })).toBeInTheDocument();
    expect(continueButton()).toBeEnabled();

    fireEvent.click(screen.getByTestId('create-account-with-phrase'));
    expect(onCreateNew).toHaveBeenCalledTimes(1);
  });

  it('does not offer a new account when the host cannot create one', () => {
    renderScreen({ probe: done() });

    expect(screen.getByTestId('guardian-no-backup')).toBeInTheDocument();
    expect(screen.queryByTestId('create-account-with-phrase')).not.toBeInTheDocument();
  });

  it('does not offer a new account for a hot-key import, which holds no phrase', () => {
    renderScreen({ probe: done(), onCreateNew: jest.fn(), guardianOnly: true });

    expect(screen.getByTestId('guardian-no-backup')).toBeInTheDocument();
    expect(screen.queryByTestId('create-account-with-phrase')).not.toBeInTheDocument();
  });

  it('never presents the new-account offer as a recovery', () => {
    renderScreen({ probe: done(), onCreateNew: jest.fn() });

    expect(screen.getByTestId('create-account-with-phrase')).toHaveTextContent('createAccountWithPhrase');
    // The Continue button is the recovery; the offer is a separate, differently named action.
    expect(continueButton()).toHaveTextContent('continue');
  });

  it('treats a lookup that failed as uncertain: a retry, and no offer to create an account', () => {
    const onRetryProbe = jest.fn();
    renderScreen({
      probe: done({ failures: [{ endpoint: OZ_ENDPOINT, reason: 'timeout', message: 'timed out' }] }),
      onRetryProbe,
      onCreateNew: jest.fn()
    });

    expect(screen.getByTestId('guardian-lookup-uncertain')).toBeInTheDocument();
    expect(screen.getByText('guardianLookupUncertain')).toBeInTheDocument();
    expect(screen.queryByTestId('guardian-no-backup')).not.toBeInTheDocument();
    expect(screen.queryByTestId('create-account-with-phrase')).not.toBeInTheDocument();
    expect(screen.getByRole('radio', { name: /OpenZeppelin/ })).toBeInTheDocument();
    expect(continueButton()).toBeEnabled();

    fireEvent.click(screen.getByRole('button', { name: /retryGuardianDetection/ }));
    expect(onRetryProbe).toHaveBeenCalledTimes(1);
  });

  it('treats a probe that errored as uncertain, never as not found', () => {
    renderScreen({ probe: { status: 'error', message: 'network down' }, onCreateNew: jest.fn() });

    expect(screen.getByTestId('guardian-lookup-uncertain')).toBeInTheDocument();
    expect(screen.queryByTestId('guardian-no-backup')).not.toBeInTheDocument();
    expect(screen.queryByTestId('create-account-with-phrase')).not.toBeInTheDocument();
    expect(screen.getByRole('radio', { name: /OpenZeppelin/ })).toBeInTheDocument();
    expect(continueButton()).toBeEnabled();
  });

  it('keeps the plain picker when Guardians answered but none is clearly the current one', () => {
    renderScreen({
      probe: done({ matches: [match(), match({ endpoint: GATEWAY_ENDPOINT, nonce: undefined })] }),
      onCreateNew: jest.fn()
    });

    expect(screen.getByTestId('guardian-not-detected')).toBeInTheDocument();
    expect(screen.getByText('guardianNotDetected')).toBeInTheDocument();
    expect(screen.queryByTestId('create-account-with-phrase')).not.toBeInTheDocument();
  });

  it('offers a new account after a chosen Guardian answered "not found" at registration', () => {
    const onCreateNew = jest.fn();
    renderScreen({
      probe: detected(),
      error: 'guardianAccountNotFound',
      errorId: 'guardianAccountNotFound',
      onCreateNew
    });

    fireEvent.click(screen.getByTestId('create-account-with-phrase'));
    expect(onCreateNew).toHaveBeenCalledTimes(1);
  });

  it('does not offer a new account after any other lookup failure', () => {
    renderScreen({
      probe: detected(),
      error: 'guardianUrlUnreachable',
      errorId: 'guardianUrlUnreachable',
      onCreateNew: jest.fn()
    });

    expect(screen.getByText('guardianUrlUnreachable')).toBeInTheDocument();
    expect(screen.queryByTestId('create-account-with-phrase')).not.toBeInTheDocument();
  });

  it('asks for the reused-phrase acknowledgement before a public import, which may create an account', () => {
    const { onSubmit } = renderScreen({ onCreateNew: jest.fn() });

    selectOnChain();

    expect(screen.getByText('publicImportMayCreate')).toBeInTheDocument();
    expect(screen.getByText('reusedPhraseWarning')).toBeInTheDocument();
    expect(continueButton()).toBeDisabled();

    acknowledgeReusedPhrase();
    expect(continueButton()).toBeEnabled();
    fireEvent.click(continueButton());
    expect(onSubmit).toHaveBeenCalledWith({ walletType: WalletType.OnChain });

    // Taking the tick back holds Continue again.
    acknowledgeReusedPhrase();
    expect(continueButton()).toBeDisabled();
  });

  it('does not ask for the acknowledgement on a Guardian import', () => {
    renderScreen();

    expect(screen.queryByTestId('reused-phrase-acknowledge')).not.toBeInTheDocument();
    expect(continueButton()).toBeEnabled();
  });

  // #1648: the only listed operator that knows the account serves a state the chain has moved past,
  // so the account was moved to a guardian the probe cannot list. The screen names that operator,
  // opens the URL field empty and holds Continue back until a URL is entered.
  it('asks for the guardian URL when the only operator that knows the account serves a superseded state', () => {
    const { onSubmit } = renderScreen({
      probe: done({ matches: [match({ holdsCurrentState: false })] })
    });

    expect(screen.getByTestId('guardian-state-behind-chain')).toBeInTheDocument();
    expect(screen.getByText('guardianStateBehindChain')).toBeInTheDocument();
    expect(screen.queryByTestId('guardian-not-detected')).not.toBeInTheDocument();
    expect(screen.queryByTestId('guardian-detected')).not.toBeInTheDocument();
    expect(guardianInput()).toHaveValue('');
    expect(continueButton()).toBeDisabled();

    fireEvent.change(guardianInput(), { target: { value: 'https://mine.example.com' } });
    expect(continueButton()).toBeEnabled();
    fireEvent.click(continueButton());

    expect(onSubmit).toHaveBeenCalledWith({
      walletType: WalletType.Guardian,
      guardianEndpoint: 'https://mine.example.com'
    });
  });

  it('keeps the listed operators reachable behind the toggle when a superseded state was found', () => {
    const { onSubmit } = renderScreen({
      probe: done({ matches: [match({ holdsCurrentState: false })] })
    });

    fireEvent.click(customToggle());
    fireEvent.click(ozPreset());
    expect(continueButton()).toBeEnabled();
    fireEvent.click(continueButton());

    expect(onSubmit).toHaveBeenCalledWith({ walletType: WalletType.Guardian, guardianEndpoint: OZ_ENDPOINT });
  });

  it('still shows the detected guardian when a current operator outranks a superseded one', () => {
    renderScreen({
      probe: detected(match(), [match({ endpoint: 'https://old.example.com', holdsCurrentState: false })])
    });

    expect(screen.getByTestId('guardian-detected')).toBeInTheDocument();
    expect(screen.queryByTestId('guardian-state-behind-chain')).not.toBeInTheDocument();
  });

  it('omits the retry link when the host cannot re-run the probe', () => {
    renderScreen({
      probe: done({ failures: [{ endpoint: OZ_ENDPOINT, reason: 'timeout', message: 'timed out' }] })
    });

    expect(screen.getByTestId('guardian-lookup-uncertain')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /retryGuardianDetection/ })).not.toBeInTheDocument();
  });

  it('still surfaces the post-register not-found error alongside a detected guardian', () => {
    renderScreen({ probe: detected(), error: 'guardianAccountNotFound' });

    expect(screen.getByText('guardianAccountNotFound')).toBeInTheDocument();
  });

  it('leaves the on-chain option untouched while a probe is running', () => {
    const { onSubmit } = renderScreen({ probe: { status: 'probing' } });

    selectOnChain();

    expect(screen.queryByTestId('guardian-probe-spinner')).not.toBeInTheDocument();
    acknowledgeReusedPhrase();
    expect(continueButton()).toBeEnabled();
    fireEvent.click(continueButton());
    expect(onSubmit).toHaveBeenCalledWith({ walletType: WalletType.OnChain });
  });
});

describe('guardianOnly (hot-key import)', () => {
  it('hides the public-account option and keeps Guardian selected', () => {
    renderScreen({ guardianOnly: true });

    expect(screen.getByText('importViaGuardian')).toBeInTheDocument();
    expect(screen.queryByText('importPublicAccount')).not.toBeInTheDocument();
  });

  it('submits a Guardian payload with the picked endpoint', () => {
    const { onSubmit } = renderScreen({ guardianOnly: true });

    fireEvent.click(continueButton());

    expect(onSubmit).toHaveBeenCalledWith(
      expect.objectContaining({ walletType: WalletType.Guardian, guardianEndpoint: expect.any(String) })
    );
  });

  it('still renders both options without the flag', () => {
    renderScreen();

    expect(screen.getByText('importViaGuardian')).toBeInTheDocument();
    expect(screen.getByText('importPublicAccount')).toBeInTheDocument();
  });
});

/**
 * A release build is a testnet or devnet build, and mainnet is a stored choice. The screen offers the operators of the
 * network the recovery restores into (the effective one, or the one the host names), so on a mainnet whose document
 * lists none, nothing points at a testnet operator.
 */
describe('on a network that lists no Guardian operator', () => {
  const MAINNET_OPERATOR = {
    id: 'mainnet-operator',
    name: 'Mainnet Operator',
    operatedBy: 'Operator Co',
    location: 'EU',
    endpoint: 'https://guardian-mainnet.example'
  };
  beforeEach(() => setDocumentGuardians(MIDEN_NETWORK_NAME.MAINNET, []));

  const mainnetScreens: Array<[string, () => ReturnType<typeof renderScreen>]> = [
    [
      'the effective network',
      () => {
        mockEffectiveNetwork = MIDEN_NETWORK_NAME.MAINNET;
        return renderScreen({ probe: { status: 'idle' } });
      }
    ],
    [
      'the network the host names',
      () => renderScreen({ probe: { status: 'idle' }, network: MIDEN_NETWORK_NAME.MAINNET })
    ]
  ];

  it.each(mainnetScreens)('selects the public account on mainnet as %s, with no endpoint', (_case, render) => {
    const { onSubmit } = render();

    expect(screen.getByRole('radio', { name: 'importPublicAccount' })).toHaveAttribute('aria-checked', 'true');
    expect(screen.getByRole('radio', { name: 'importViaGuardian' })).toHaveAttribute('aria-checked', 'false');
    expect(screen.queryByTestId('default-badge')).not.toBeInTheDocument();
    expect(screen.queryByText('guardianEndpoint')).not.toBeInTheDocument();
    expect(document.body.textContent).not.toContain(DEFAULT_ENDPOINT);

    acknowledgeReusedPhrase();
    fireEvent.click(continueButton());
    expect(onSubmit).toHaveBeenCalledWith({ walletType: WalletType.OnChain });
  });

  it.each(mainnetScreens)('offers no testnet operator on mainnet as %s once Guardian is chosen', (_case, render) => {
    render();
    selectGuardian();

    expect(screen.queryByRole('radio', { name: /OpenZeppelin/ })).not.toBeInTheDocument();
    expect(screen.queryByText('guardianEndpoint')).not.toBeInTheDocument();
    expect(document.body.textContent).not.toContain(DEFAULT_ENDPOINT);
    expect(continueButton()).toBeDisabled();
  });

  it('pins Guardian with no endpoint for a hot key on mainnet', () => {
    mockEffectiveNetwork = MIDEN_NETWORK_NAME.MAINNET;
    renderScreen({ guardianOnly: true, probe: { status: 'idle' } });

    expect(screen.getByRole('radio', { name: 'importViaGuardian' })).toHaveAttribute('aria-checked', 'true');
    expect(document.body.textContent).not.toContain(DEFAULT_ENDPOINT);
    expect(continueButton()).toBeDisabled();
  });

  it('starts on the custom Guardian set on mainnet, and Continue submits it', () => {
    mockEffectiveNetwork = MIDEN_NETWORK_NAME.MAINNET;
    mockCustomGuardian = 'https://custom.guardian.example';
    const { onSubmit } = renderScreen({ probe: { status: 'idle' } });

    expect(screen.getByRole('radio', { name: 'importViaGuardian' })).toHaveAttribute('aria-checked', 'true');
    expect(screen.getByRole('radio', { name: /Custom/ })).toHaveAttribute('aria-checked', 'true');

    fireEvent.click(continueButton());
    expect(onSubmit).toHaveBeenCalledWith({
      walletType: WalletType.Guardian,
      guardianEndpoint: 'https://custom.guardian.example'
    });
  });

  it('leaves a recovery the host names as mainnet on the public account when the custom Guardian is on testnet', () => {
    mockCustomGuardian = 'https://custom.guardian.example';
    const { onSubmit } = renderScreen({ probe: { status: 'idle' }, network: MIDEN_NETWORK_NAME.MAINNET });

    expect(screen.getByRole('radio', { name: 'importPublicAccount' })).toHaveAttribute('aria-checked', 'true');
    expect(document.body.textContent).not.toContain('https://custom.guardian.example');

    acknowledgeReusedPhrase();
    fireEvent.click(continueButton());
    expect(onSubmit).toHaveBeenCalledWith({ walletType: WalletType.OnChain });
  });

  it('defaults to the operator mainnet lists, once it lists one', () => {
    mockEffectiveNetwork = MIDEN_NETWORK_NAME.MAINNET;
    setDocumentGuardians(MIDEN_NETWORK_NAME.MAINNET, [MAINNET_OPERATOR]);
    const { onSubmit } = renderScreen({ probe: { status: 'idle' } });

    expect(screen.getByRole('radio', { name: 'importViaGuardian' })).toHaveAttribute('aria-checked', 'true');
    expect(screen.getByRole('radio', { name: /Mainnet Operator/ })).toHaveAttribute('aria-checked', 'true');
    expect(screen.queryByRole('radio', { name: /OpenZeppelin/ })).not.toBeInTheDocument();

    fireEvent.click(continueButton());
    expect(onSubmit).toHaveBeenCalledWith({
      walletType: WalletType.Guardian,
      guardianEndpoint: MAINNET_OPERATOR.endpoint
    });
  });
});

describe('user-visible error reporting', () => {
  it('does not report the no-match fallback or partial-discovery caution', () => {
    renderScreen({
      probe: {
        status: 'done',
        result: {
          matches: [],
          probedEndpoints: [DEFAULT_ENDPOINT],
          failures: [{ endpoint: DEFAULT_ENDPOINT, reason: 'timeout', message: privateErrorFixture }]
        }
      }
    });
    expect(screen.getByText('guardianLookupUncertain')).toBeVisible();
    dwellForError();
    expect(reportUserVisibleError).not.toHaveBeenCalled();
  });

  beforeEach(() => {
    jest.useFakeTimers();
    jest.mocked(reportUserVisibleError).mockClear();
  });
  afterEach(() => {
    jest.clearAllTimers();
    jest.useRealTimers();
  });

  it('reports the displayed lookup failure using a closed site identity', () => {
    renderScreen({ error: privateErrorFixture });
    expect(screen.getByRole('alert')).toHaveTextContent(privateErrorFixture);
    expect(reportUserVisibleError).not.toHaveBeenCalled();
    dwellForError();
    expectDisplayReport('raw_import_recovery_lookup_failed', 'notice');
  });
  it('does not report a lookup error hidden by the public-account selection', () => {
    renderScreen({ error: privateErrorFixture });
    selectOnChain();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    dwellForError();
    expect(reportUserVisibleError).not.toHaveBeenCalled();
  });
  it('does not report detecting progress', () => {
    renderScreen({ probe: { status: 'probing' } });
    expect(screen.getByText('detectingGuardian')).toBeVisible();
    dwellForError();
    expect(reportUserVisibleError).not.toHaveBeenCalled();
  });
});
