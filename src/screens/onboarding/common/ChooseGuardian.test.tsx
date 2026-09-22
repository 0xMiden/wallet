import React from 'react';

import { render, screen, fireEvent } from '@testing-library/react';

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

// `react-i18next` pulls in the full i18n runtime; stub `useTranslation` so
// `t(key)` echoes the key back and every rendered label is the raw key.
jest.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, params?: Record<string, string>) => (params ? `${key}: ${Object.values(params).join(' · ')}` : key)
  })
}));

// Guardian provider list — controlled per-test so we can exercise the
// create/switch/empty branches deterministically. Ids normally match the
// module-private `GUARDIAN_LOGOS` keys; an id with no matching entry falls
// back to the generic avatar instead of throwing (see the "unknown operator"
// regression test below).
const mockGetGuardianOptions = jest.fn();
jest.mock('lib/miden-chain/constants', () => ({
  ...jest.requireActual('lib/miden-chain/constants'),
  getGuardianOptionsForNetwork: (...args: unknown[]) => mockGetGuardianOptions(...args)
}));

// Availability hook — controlled per-test so the offline-banner branches are
// exercised without real network pings (the real hook fans out HTTP requests
// to every provider endpoint on mount).
const mockUseGuardianAvailability = jest.fn();
jest.mock('app/hooks/useGuardianAvailability', () => ({
  useGuardianAvailability: (...args: unknown[]) => mockUseGuardianAvailability(...args)
}));

// Haptics — no-op mock so we can assert taps trigger feedback without dragging
// in the Capacitor plugin.
const mockHapticLight = jest.fn();
const mockHapticSelection = jest.fn();
jest.mock('lib/mobile/haptics', () => ({
  hapticLight: () => mockHapticLight(),
  hapticSelection: () => mockHapticSelection()
}));

// URL helpers — controlled so both the valid and invalid custom-URL branches
// are reachable regardless of the real validation rules.
const mockIsValidGuardianUrl = jest.fn();
const mockSanitizeGuardianUrl = jest.fn();
jest.mock('lib/settings/helpers', () => ({
  isValidGuardianUrl: (...args: unknown[]) => mockIsValidGuardianUrl(...args),
  sanitizeGuardianUrl: (...args: unknown[]) => mockSanitizeGuardianUrl(...args)
}));

// `cn` — deterministic class joiner so selected/badge class assertions are
// stable (no tailwind-merge collapsing).
jest.mock('lib/ui/util', () => ({
  cn: (...args: unknown[]) => args.filter(Boolean).join(' ')
}));

// `Button` — render the title and forward the click so the continue wiring is
// assertable without the real button internals.
jest.mock('components/Button', () => ({
  Button: ({ title, onClick, disabled }: { title?: string; onClick?: () => void; disabled?: boolean }) => (
    <button data-testid="continue-button" onClick={onClick} disabled={disabled}>
      {title}
    </button>
  )
}));

// `TextField` — thin controlled input echoing the props the screen threads through
// (rest props forwarded so keyboard attributes like enterKeyHint are assertable),
// and the error line the real field renders as an alert.
jest.mock('components/ui/TextField', () => ({
  TextField: ({
    id,
    value,
    placeholder,
    onChange,
    error,
    containerClassName: _containerClassName,
    ...rest
  }: {
    id?: string;
    value?: string;
    placeholder?: string;
    error?: React.ReactNode;
    containerClassName?: string;
    onChange?: (e: React.ChangeEvent<HTMLInputElement>) => void;
  } & React.InputHTMLAttributes<HTMLInputElement>) => (
    <>
      <input data-testid="custom-input" id={id} value={value} placeholder={placeholder} onChange={onChange} {...rest} />
      {error && <p role="alert">{error}</p>}
    </>
  )
}));

// `GuardianInfoDrawer` — surface the open flag and a close hook so the
// info-drawer open/close wiring is assertable.
jest.mock('./GuardianInfoDrawer', () => ({
  GuardianInfoDrawer: ({ open, onOpenChange }: { open: boolean; onOpenChange: (o: boolean) => void }) => (
    <div data-testid="info-drawer" data-open={String(open)}>
      <button data-testid="drawer-close" onClick={() => onOpenChange(false)}>
        close
      </button>
    </div>
  )
}));

// eslint-disable-next-line import/first
import { ChooseGuardianScreen, default as DefaultChooseGuardianScreen } from './ChooseGuardian';

// ---------------------------------------------------------------------------
// Fixtures / helpers
// ---------------------------------------------------------------------------

const OZ = {
  id: 'open-zeppelin',
  name: 'OpenZeppelin',
  operatedBy: 'OpenZeppelin',
  location: 'US-EAST',
  endpoint: 'https://oz.example.com'
};
const GATEWAY = {
  id: 'gateway',
  name: 'Gateway Operator',
  operatedBy: 'Gateway',
  location: 'EU-NORTH',
  endpoint: 'https://gw.example.com'
};
const LAMBDA = {
  id: 'lambda-class',
  name: 'LambdaClass',
  operatedBy: 'LambdaClass',
  location: 'EU-WEST',
  endpoint: 'https://lc.example.com'
};

const allOptions = () => [{ ...OZ }, { ...GATEWAY }, { ...LAMBDA }];

// The provider cards are the radios carrying their endpoint; this yields them in provider order.
const optionButtons = (container: HTMLElement): HTMLButtonElement[] =>
  Array.from(container.querySelectorAll<HTMLButtonElement>('button[role="radio"][data-guardian-endpoint]'));

const isHighlighted = (btn: HTMLElement) => btn.getAttribute('aria-checked') === 'true';

beforeEach(() => {
  jest.clearAllMocks();
  mockGetGuardianOptions.mockReturnValue(allOptions());
  mockUseGuardianAvailability.mockReturnValue({});
  mockIsValidGuardianUrl.mockReturnValue(true);
  mockSanitizeGuardianUrl.mockImplementation((v: string) => v.trim().replace(/\/+$/, ''));
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('ChooseGuardianScreen', () => {
  it('exports the same component as the default export', () => {
    expect(DefaultChooseGuardianScreen).toBe(ChooseGuardianScreen);
  });

  it('renders the default header, all provider cards and the continue button (create flow)', () => {
    const { container } = render(<ChooseGuardianScreen />);

    // Default header copy from i18n keys.
    expect(screen.getByRole('heading', { name: 'chooseYourGuardian' })).toBeInTheDocument();
    expect(screen.getByText('chooseGuardianDescription')).toBeInTheDocument();
    expect(screen.getByText('learnMoreAboutGuardian')).toBeInTheDocument();

    // One card per provider.
    expect(optionButtons(container)).toHaveLength(3);

    // Name, then one meta line (operator · location) inside each card: nothing floats below it.
    expect(screen.getByText('OpenZeppelin')).toBeInTheDocument();
    expect(screen.getByText('Gateway Operator')).toBeInTheDocument();
    expect(screen.getByText('guardianCardMeta: Gateway · EU-NORTH')).toBeInTheDocument();
    const [ozCard] = optionButtons(container);
    expect(ozCard).toContainElement(screen.getByText('guardianCardMeta: OpenZeppelin · US-EAST'));

    // The picker is the design system's radio cards on the onboarding step layout.
    expect(screen.getByRole('radiogroup', { name: 'chooseYourGuardian' })).toBeInTheDocument();
    const footer = screen.getByTestId('continue-button').closest<HTMLElement>('[data-slot="footer"]');
    expect(footer).not.toBeNull();
    expect(screen.getByTestId('onboarding-choose-guardian')).toContainElement(footer);

    // Continue button uses the default label.
    expect(screen.getByTestId('continue-button')).toHaveTextContent('continue');

    // Info drawer starts closed.
    expect(screen.getByTestId('info-drawer')).toHaveAttribute('data-open', 'false');
  });

  // Every card leads with the provider's logo on the same 48px brand tile (white in light mode, a
  // dark neutral in dark mode): OpenZeppelin's colour mark untouched, a grey mark recoloured to ink.
  it('leads each card with the provider mark on the brand tile', () => {
    const { container } = render(<ChooseGuardianScreen />);
    const [ozBtn, gatewayBtn, lambdaBtn] = optionButtons(container);

    [ozBtn, gatewayBtn, lambdaBtn].forEach(btn => {
      const tile = btn!.querySelector('[data-testid="guardian-logo-tile"]');
      expect(tile).toHaveClass('size-12', 'rounded-xl', 'bg-pure-white', 'dark:bg-grey-800');
    });
    expect(ozBtn!.querySelector('[data-testid="guardian-operator-logo"]')).not.toHaveClass('[&_path]:fill-ink');
    expect(gatewayBtn!.querySelector('[data-testid="guardian-operator-logo"]')).toHaveClass('[&_path]:fill-ink');
  });

  it('draws each card flat, with no border, and the selection as the accent ring', () => {
    const { container } = render(<ChooseGuardianScreen />);
    const [ozBtn, gatewayBtn] = optionButtons(container);
    expect(ozBtn).toHaveClass('bg-fill', 'rounded-2xl', 'ring-accent-primary');
    expect(ozBtn!.className).not.toMatch(/border-primary-500|border-4/);
    expect(gatewayBtn).not.toHaveClass('ring-accent-primary');
  });

  it('draws Learn more and Use a custom URL as text actions, never underlined', () => {
    render(<ChooseGuardianScreen allowCustomEndpoint />);
    [screen.getByText('learnMoreAboutGuardian'), screen.getByText('useCustomGuardianUrl')].forEach(action => {
      expect(action).toHaveClass('text-accent-tint-ink');
      expect(action.className).not.toMatch(/underline|text-primary-500/);
    });
  });

  it('renders as a pushed page with the shared header when given onBack (Rotate Guardian)', () => {
    const onBack = jest.fn();
    render(<ChooseGuardianScreen onBack={onBack} />);
    // The title moves into the header; the explainer and Learn more open the body.
    expect(screen.getByRole('heading', { name: 'chooseYourGuardian' })).toBeInTheDocument();
    expect(screen.getByText('chooseGuardianDescription')).toBeInTheDocument();
    expect(screen.getByText('learnMoreAboutGuardian')).toBeInTheDocument();
    fireEvent.click(screen.getByTestId('page-back'));
    expect(onBack).toHaveBeenCalledTimes(1);
    expect(screen.getByTestId('onboarding-choose-guardian').querySelector('[data-slot="step-heading"]')).toBeNull();
  });

  it('honours custom title / description / submitLabel props', () => {
    render(<ChooseGuardianScreen title="Pick one" description="Choose wisely" submitLabel="Go" />);
    expect(screen.getByRole('heading', { name: 'Pick one' })).toBeInTheDocument();
    expect(screen.getByText('Choose wisely')).toBeInTheDocument();
    expect(screen.getByTestId('continue-button')).toHaveTextContent('Go');
  });

  // A rotation failure used to be printed by the caller BELOW this screen, i.e.
  // outside its scroll container — on a short viewport the user tapped Continue,
  // nothing visibly happened, and the reason sat off-screen. It now renders
  // inside, directly above the button, announced.
  it('renders a caller submission error above the continue button', () => {
    render(<ChooseGuardianScreen error="Guardian rejected the request" />);

    const alert = screen.getByRole('alert');
    expect(alert).toHaveTextContent('Guardian rejected the request');
    expect(alert.compareDocumentPosition(screen.getByTestId('continue-button'))).toBe(Node.DOCUMENT_POSITION_FOLLOWING);
    // The error sits in the PINNED footer, not the scrolling body, so it is bounded and scrolls
    // inside its own box. Without the bound a long backend error grows the footer and pushes
    // Continue off the screen (#463) - the sibling rotate-guardian screen already caps it.
    expect(alert).toHaveClass('max-h-24', 'overflow-y-auto');
  });

  it('renders no error region when the caller has no error', () => {
    render(<ChooseGuardianScreen />);
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('hides the header when hideHeader is true', () => {
    render(<ChooseGuardianScreen hideHeader />);
    expect(screen.queryByRole('heading', { name: 'chooseYourGuardian' })).not.toBeInTheDocument();
    expect(screen.queryByText('learnMoreAboutGuardian')).not.toBeInTheDocument();
    // Cards still render.
    expect(screen.getByText('OpenZeppelin')).toBeInTheDocument();
  });

  it('defaults the selection to the first provider and marks it with the "default" badge (create flow)', () => {
    const { container } = render(<ChooseGuardianScreen />);
    const [ozBtn, gwBtn] = optionButtons(container);

    expect(isHighlighted(ozBtn!)).toBe(true);
    expect(isHighlighted(gwBtn!)).toBe(false);

    // Only the default card carries a badge, and it reads "default".
    expect(screen.getByText('default')).toBeInTheDocument();
    expect(screen.queryByText('currentLabel')).not.toBeInTheDocument();
  });

  it('opens and closes the info drawer via learn-more / drawer close', () => {
    render(<ChooseGuardianScreen />);
    const drawer = screen.getByTestId('info-drawer');
    expect(drawer).toHaveAttribute('data-open', 'false');

    fireEvent.click(screen.getByText('learnMoreAboutGuardian'));
    expect(mockHapticLight).toHaveBeenCalledTimes(1);
    expect(screen.getByTestId('info-drawer')).toHaveAttribute('data-open', 'true');

    fireEvent.click(screen.getByTestId('drawer-close'));
    expect(screen.getByTestId('info-drawer')).toHaveAttribute('data-open', 'false');
  });

  it('selects a non-default provider on tap (haptic + highlight moves)', () => {
    const { container } = render(<ChooseGuardianScreen />);
    const [ozBtn, gwBtn] = optionButtons(container);

    fireEvent.click(gwBtn!);
    expect(mockHapticSelection).toHaveBeenCalledTimes(1);
    expect(isHighlighted(gwBtn!)).toBe(true);
    expect(isHighlighted(ozBtn!)).toBe(false);
  });

  it('submits the selected provider id + endpoint on continue', () => {
    const onSubmit = jest.fn();
    const { container } = render(<ChooseGuardianScreen onSubmit={onSubmit} />);
    const [, gwBtn] = optionButtons(container);

    fireEvent.click(gwBtn!);
    fireEvent.click(screen.getByTestId('continue-button'));

    expect(onSubmit).toHaveBeenCalledWith({
      guardianId: 'gateway',
      guardianEndpoint: 'https://gw.example.com'
    });
  });

  it('submits the default provider when the user never changes the selection', () => {
    const onSubmit = jest.fn();
    render(<ChooseGuardianScreen onSubmit={onSubmit} />);

    fireEvent.click(screen.getByTestId('continue-button'));
    expect(onSubmit).toHaveBeenCalledWith({
      guardianId: 'open-zeppelin',
      guardianEndpoint: 'https://oz.example.com'
    });
  });

  it('does not throw on continue when no onSubmit is provided', () => {
    render(<ChooseGuardianScreen />);
    expect(() => fireEvent.click(screen.getByTestId('continue-button'))).not.toThrow();
  });

  it('does nothing on continue when there are no providers', () => {
    mockGetGuardianOptions.mockReturnValue([]);
    const onSubmit = jest.fn();
    const { container } = render(<ChooseGuardianScreen onSubmit={onSubmit} />);

    expect(optionButtons(container)).toHaveLength(0);
    fireEvent.click(screen.getByTestId('continue-button'));
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it('falls back to the generic avatar (no throw) for a provider id with no registered logo', () => {
    // Regression: an operator id absent from the module-private GUARDIAN_LOGOS
    // map (e.g. a newly-added / E2E-only provider whose wordmark hasn't been
    // registered yet) must render a generic-avatar card, not crash the whole
    // screen -- this is exactly what broke when the localnet-only "OpenZeppelin
    // B" test provider was added to getGuardianOptionsForNetwork() without a
    // matching GUARDIAN_LOGOS entry.
    const UNKNOWN = {
      id: 'unknown-operator',
      name: 'Mystery Operator',
      operatedBy: 'Mystery Co',
      location: 'US-WEST',
      endpoint: 'https://mystery.example.com'
    };
    mockGetGuardianOptions.mockReturnValue([{ ...OZ }, UNKNOWN]);

    let container!: HTMLElement;
    expect(() => {
      ({ container } = render(<ChooseGuardianScreen />));
    }).not.toThrow();

    expect(optionButtons(container)).toHaveLength(2);
    expect(screen.getByText('Mystery Operator')).toBeInTheDocument();
    expect(screen.getByText('guardianCardMeta: Mystery Co · US-WEST')).toBeInTheDocument();
    expect(screen.getByTestId('guardian-avatar')).toBeInTheDocument();
  });

  // --- switch flow (currentEndpoint) ---------------------------------------

  it('pre-selects and badges the current provider in the switch flow', () => {
    const { container } = render(<ChooseGuardianScreen currentEndpoint={GATEWAY.endpoint} />);
    const [ozBtn, gwBtn] = optionButtons(container);

    // Current provider is pre-selected...
    expect(isHighlighted(gwBtn!)).toBe(true);
    expect(isHighlighted(ozBtn!)).toBe(false);
    // ...and badged as "currentLabel" (not "default").
    expect(screen.getByText('currentLabel')).toBeInTheDocument();
    expect(screen.queryByText('default')).not.toBeInTheDocument();
  });

  // A stored endpoint can differ from the option's literal by a trailing slash;
  // RotateGuardian compares the two sanitized for the same reason.
  it('recognizes the current provider when the stored endpoint has a trailing slash', () => {
    const { container } = render(<ChooseGuardianScreen currentEndpoint={`${GATEWAY.endpoint}/`} />);
    const [ozBtn, gwBtn] = optionButtons(container);

    expect(isHighlighted(gwBtn!)).toBe(true);
    expect(isHighlighted(ozBtn!)).toBe(false);
    expect(screen.getByText('currentLabel')).toBeInTheDocument();
  });

  it('falls back to the first provider when currentEndpoint matches nothing', () => {
    const { container } = render(<ChooseGuardianScreen currentEndpoint="https://unknown.example.com" />);
    const [ozBtn] = optionButtons(container);

    expect(isHighlighted(ozBtn!)).toBe(true);
    // No "current" badge (nothing matched); the default badge is shown instead.
    expect(screen.queryByText('currentLabel')).not.toBeInTheDocument();
    expect(screen.getByText('default')).toBeInTheDocument();
  });

  // RotateGuardian's current endpoint hydrates from storage after the first render;
  // until the user picks, the highlight follows it.
  it('follows a currentEndpoint that resolves after mount until the user picks', () => {
    const { container, rerender } = render(<ChooseGuardianScreen />);
    const [ozBtn, gwBtn] = optionButtons(container);
    expect(isHighlighted(ozBtn!)).toBe(true);

    rerender(<ChooseGuardianScreen currentEndpoint={GATEWAY.endpoint} />);
    expect(isHighlighted(gwBtn!)).toBe(true);
    expect(isHighlighted(ozBtn!)).toBe(false);
  });

  it('keeps the user selection when currentEndpoint changes after an explicit pick', () => {
    const { container, rerender } = render(<ChooseGuardianScreen currentEndpoint={GATEWAY.endpoint} />);
    const [ozBtn] = optionButtons(container);

    // User explicitly picks OpenZeppelin.
    fireEvent.click(ozBtn!);
    expect(isHighlighted(ozBtn!)).toBe(true);

    // A late-hydrating currentEndpoint change must NOT override the user's pick.
    rerender(<ChooseGuardianScreen currentEndpoint={LAMBDA.endpoint} />);
    const [ozAfter, , lambdaAfter] = optionButtons(container);
    expect(isHighlighted(ozAfter!)).toBe(true);
    expect(isHighlighted(lambdaAfter!)).toBe(false);
  });

  // --- custom endpoint -----------------------------------------------------

  it('does not render the custom-URL affordance unless allowCustomEndpoint is set', () => {
    render(<ChooseGuardianScreen />);
    expect(screen.queryByText('useCustomGuardianUrl')).not.toBeInTheDocument();
  });

  it('toggles the custom-URL input open and closed', () => {
    render(<ChooseGuardianScreen allowCustomEndpoint />);
    expect(screen.queryByTestId('custom-input')).not.toBeInTheDocument();

    fireEvent.click(screen.getByText('useCustomGuardianUrl'));
    expect(mockHapticLight).toHaveBeenCalledTimes(1);
    expect(screen.getByTestId('custom-input')).toBeInTheDocument();

    // Toggle back off.
    fireEvent.click(screen.getByText('useCustomGuardianUrl'));
    expect(screen.queryByTestId('custom-input')).not.toBeInTheDocument();
  });

  it('submits a sanitized custom endpoint when the URL is valid', () => {
    const onSubmit = jest.fn();
    render(<ChooseGuardianScreen allowCustomEndpoint onSubmit={onSubmit} />);

    fireEvent.click(screen.getByText('useCustomGuardianUrl'));
    fireEvent.change(screen.getByTestId('custom-input'), {
      target: { value: 'https://custom.example.com/' }
    });
    fireEvent.click(screen.getByTestId('continue-button'));

    expect(mockSanitizeGuardianUrl).toHaveBeenCalledWith('https://custom.example.com/');
    expect(mockIsValidGuardianUrl).toHaveBeenCalledWith('https://custom.example.com');
    expect(onSubmit).toHaveBeenCalledWith({
      guardianId: 'custom',
      guardianEndpoint: 'https://custom.example.com'
    });
  });

  it('shows an error and blocks submit when the custom URL is invalid, then clears it on edit', () => {
    mockIsValidGuardianUrl.mockReturnValue(false);
    const onSubmit = jest.fn();
    render(<ChooseGuardianScreen allowCustomEndpoint onSubmit={onSubmit} />);

    fireEvent.click(screen.getByText('useCustomGuardianUrl'));
    fireEvent.change(screen.getByTestId('custom-input'), { target: { value: 'not-a-url' } });
    fireEvent.click(screen.getByTestId('continue-button'));

    expect(onSubmit).not.toHaveBeenCalled();
    expect(screen.getByText('invalidUrl')).toBeInTheDocument();

    // Editing the field clears the error (customError truthy branch).
    fireEvent.change(screen.getByTestId('custom-input'), { target: { value: 'still-bad' } });
    expect(screen.queryByText('invalidUrl')).not.toBeInTheDocument();
  });

  it('clears any prior error when re-opening the custom toggle', () => {
    mockIsValidGuardianUrl.mockReturnValue(false);
    render(<ChooseGuardianScreen allowCustomEndpoint />);

    fireEvent.click(screen.getByText('useCustomGuardianUrl'));
    fireEvent.change(screen.getByTestId('custom-input'), { target: { value: 'bad' } });
    fireEvent.click(screen.getByTestId('continue-button'));
    expect(screen.getByText('invalidUrl')).toBeInTheDocument();

    // Toggling off then on resets the error state.
    fireEvent.click(screen.getByText('useCustomGuardianUrl'));
    fireEvent.click(screen.getByText('useCustomGuardianUrl'));
    expect(screen.queryByText('invalidUrl')).not.toBeInTheDocument();
  });

  it('switching back to a provider after enabling custom submits the provider (not custom)', () => {
    const onSubmit = jest.fn();
    const { container } = render(<ChooseGuardianScreen allowCustomEndpoint onSubmit={onSubmit} />);

    // Enable custom mode...
    fireEvent.click(screen.getByText('useCustomGuardianUrl'));
    expect(screen.getByTestId('custom-input')).toBeInTheDocument();

    // ...then tapping a provider card exits custom mode.
    const [, gwBtn] = optionButtons(container);
    fireEvent.click(gwBtn!);
    expect(screen.queryByTestId('custom-input')).not.toBeInTheDocument();

    fireEvent.click(screen.getByTestId('continue-button'));
    expect(onSubmit).toHaveBeenCalledWith({
      guardianId: 'gateway',
      guardianEndpoint: 'https://gw.example.com'
    });
  });

  // `selectedId` seeds from `defaultId` and is never empty, so opening the custom
  // field left a provider card still claiming to be the pressed one — a
  // machine-readable assertion that the wrong operator was selected, on the
  // screen whose entire job is choosing between them.
  it('stops reporting a provider card as pressed once custom mode is the live choice', () => {
    const { container } = render(<ChooseGuardianScreen allowCustomEndpoint />);

    const [ozBtn] = optionButtons(container);
    expect(ozBtn).toHaveAttribute('aria-checked', 'true');

    fireEvent.click(screen.getByText('useCustomGuardianUrl'));
    expect(ozBtn).toHaveAttribute('aria-checked', 'false');
    expect(ozBtn?.className).not.toContain('border-primary-500');

    // Closing the field hands the selection back to the card it came from.
    fireEvent.click(screen.getByText('useCustomGuardianUrl'));
    expect(ozBtn).toHaveAttribute('aria-checked', 'true');
  });

  it('exposes the custom-URL toggle as the disclosure control it is', () => {
    render(<ChooseGuardianScreen allowCustomEndpoint />);

    const toggle = screen.getByText('useCustomGuardianUrl');
    expect(toggle).toHaveAttribute('aria-expanded', 'false');

    fireEvent.click(toggle);
    expect(toggle).toHaveAttribute('aria-expanded', 'true');
  });

  // Latent today (no caller passes both affordances) and one prop combination
  // from being live: `handleSelect` clears `isCustom` but nothing clears
  // `selectedId`, so the no-guardian sentinel outlived the mode that superseded
  // it and Continue built a guardian-LESS account while a typed custom URL sat
  // on screen.
  it('submits the custom URL, not a stale no-guardian selection, when both are offered', () => {
    const onSubmit = jest.fn();
    render(<ChooseGuardianScreen allowCustomEndpoint showNoGuardianOption onSubmit={onSubmit} />);

    fireEvent.click(screen.getByTestId('choose-no-guardian'));
    fireEvent.click(screen.getByText('useCustomGuardianUrl'));
    fireEvent.change(screen.getByTestId('custom-input'), { target: { value: 'https://custom.example.com' } });
    fireEvent.click(screen.getByTestId('continue-button'));

    expect(onSubmit).toHaveBeenCalledWith({ guardianId: 'custom', guardianEndpoint: 'https://custom.example.com' });
    expect(screen.getByTestId('choose-no-guardian')).toHaveAttribute('aria-checked', 'false');
  });

  it('edits the custom URL without a pre-existing error (customError falsy branch)', () => {
    render(<ChooseGuardianScreen allowCustomEndpoint />);
    fireEvent.click(screen.getByText('useCustomGuardianUrl'));

    const input = screen.getByTestId('custom-input') as HTMLInputElement;
    fireEvent.change(input, { target: { value: 'https://abc.example.com' } });
    expect(input.value).toBe('https://abc.example.com');
    // No error was ever shown.
    expect(screen.queryByText('invalidUrl')).not.toBeInTheDocument();
  });
});

describe('ChooseGuardianScreen — custom endpoint keyboard (regression)', () => {
  it('gives the URL field a url keyboard with autocorrect off and a Done key', () => {
    render(<ChooseGuardianScreen allowCustomEndpoint />);
    fireEvent.click(screen.getByText('useCustomGuardianUrl'));

    const input = screen.getByTestId('custom-input');
    expect(input.getAttribute('inputmode')).toBe('url');
    expect(input.getAttribute('autocapitalize')).toBe('none');
    expect(input.getAttribute('autocorrect')).toBe('off');
    expect(input.getAttribute('spellcheck')).toBe('false');
    expect(input.getAttribute('enterkeyhint')).toBe('done');
  });

  it('Enter blurs the URL field so the keyboard dismisses', () => {
    render(<ChooseGuardianScreen allowCustomEndpoint />);
    fireEvent.click(screen.getByText('useCustomGuardianUrl'));

    const input = screen.getByTestId('custom-input') as HTMLInputElement;
    input.focus();
    expect(document.activeElement).toBe(input);

    fireEvent.keyDown(input, { key: 'Enter' });

    expect(document.activeElement).not.toBe(input);
  });
});

describe('ChooseGuardianScreen — offline banner', () => {
  it('pings the resolved provider endpoints', () => {
    render(<ChooseGuardianScreen />);
    expect(mockUseGuardianAvailability).toHaveBeenCalledWith([OZ.endpoint, GATEWAY.endpoint, LAMBDA.endpoint]);
  });

  it('shows the offline banner only on providers reported offline', () => {
    mockUseGuardianAvailability.mockReturnValue({
      [OZ.endpoint]: 'online',
      [GATEWAY.endpoint]: 'offline'
      // LAMBDA absent => still checking
    });
    render(<ChooseGuardianScreen />);

    const banners = screen.getAllByTestId('guardian-offline-banner');
    expect(banners).toHaveLength(1);
    expect(banners[0]).toHaveTextContent('guardianOfflineLabel');
    // The banner sits inside the Gateway card (the button carrying its endpoint).
    expect(banners[0]!.closest('button')).toHaveAttribute('data-guardian-endpoint', GATEWAY.endpoint);
    // The same negative StatusBadge the Guardian settings pill draws.
    expect(banners[0]).toHaveClass('bg-negative-tint');
  });

  it('renders no offline banner while pings are still checking or all online', () => {
    render(<ChooseGuardianScreen />);
    expect(screen.queryByTestId('guardian-offline-banner')).not.toBeInTheDocument();

    mockUseGuardianAvailability.mockReturnValue({
      [OZ.endpoint]: 'online',
      [GATEWAY.endpoint]: 'online',
      [LAMBDA.endpoint]: 'online'
    });
    render(<ChooseGuardianScreen />);
    expect(screen.queryByTestId('guardian-offline-banner')).not.toBeInTheDocument();
  });

  it('keeps the default badge alongside the offline verdict', () => {
    // OZ is the default selection AND offline: both badges show, side by side.
    mockUseGuardianAvailability.mockReturnValue({ [OZ.endpoint]: 'offline' });
    render(<ChooseGuardianScreen />);

    const card = screen.getByTestId('guardian-offline-banner').closest('button');
    expect(card).toHaveAccessibleDescription(/^default guardianOfflineLabel/);
    expect(screen.getByTestId('guardian-offline-banner')).toHaveClass('bg-negative-tint');
  });

  // The card most likely to be offline is the one the user is already on — that
  // is the whole premise of the offline rotation flow — and "which operator am I
  // leaving?" is the question this screen exists to answer. Dropping "Current"
  // there hid it at exactly the moment it mattered.
  it('still shows Current on the operator the account is on while it is down', () => {
    mockUseGuardianAvailability.mockReturnValue({ [GATEWAY.endpoint]: 'offline' });
    render(<ChooseGuardianScreen currentEndpoint={GATEWAY.endpoint} />);

    const card = screen.getByTestId('guardian-offline-banner').closest('button');
    expect(card).toHaveAccessibleDescription(/^currentLabel guardianOfflineLabel/);
    expect(card).toHaveAttribute('data-guardian-endpoint', GATEWAY.endpoint);
  });

  it('names each card by its operator, so a down one is not just "Offline"', () => {
    // With the operator name in a sibling node and the wordmark SVG untitled,
    // the button's accessible name was whatever the strip said — i.e.
    // "guardianOfflineLabel" for every down operator, on the screen whose entire
    // purpose is telling them apart.
    mockUseGuardianAvailability.mockReturnValue({
      [OZ.endpoint]: 'offline',
      [GATEWAY.endpoint]: 'offline'
    });
    render(<ChooseGuardianScreen />);

    const ozCard = screen.getByRole('radio', { name: OZ.name, description: /^default guardianOfflineLabel/ });
    expect(ozCard).toHaveAttribute('data-guardian-endpoint', OZ.endpoint);
    const gwCard = screen.getByRole('radio', { name: GATEWAY.name, description: /^guardianOfflineLabel/ });
    expect(gwCard).toHaveAttribute('data-guardian-endpoint', GATEWAY.endpoint);
  });

  it('exposes the selected card as checked, since selection is otherwise the ring alone', () => {
    render(<ChooseGuardianScreen />);

    // OZ is the default selection.
    expect(screen.getByRole('radio', { name: OZ.name })).toHaveAttribute('aria-checked', 'true');
    const gwCard = screen.getByRole('radio', { name: GATEWAY.name });
    expect(gwCard).toHaveAttribute('aria-checked', 'false');

    fireEvent.click(gwCard);
    expect(gwCard).toHaveAttribute('aria-checked', 'true');
  });

  // An account created against a down operator fails deep in the pipeline,
  // after the seed backup and the password. The card already SAID offline; it
  // still took the tap and Continue still submitted it.
  it('disables an offline provider card so it cannot be selected or submitted', () => {
    mockUseGuardianAvailability.mockReturnValue({ [GATEWAY.endpoint]: 'offline' });
    const onSubmit = jest.fn();
    const { container } = render(<ChooseGuardianScreen onSubmit={onSubmit} />);
    const [ozBtn, gwBtn] = optionButtons(container);

    expect(gwBtn).toBeDisabled();
    expect(ozBtn).not.toBeDisabled();

    fireEvent.click(gwBtn!);
    expect(mockHapticLight).not.toHaveBeenCalled();
    expect(gwBtn).toHaveAttribute('aria-checked', 'false');
    expect(isHighlighted(gwBtn!)).toBe(false);

    fireEvent.click(screen.getByTestId('continue-button'));
    expect(onSubmit).toHaveBeenCalledWith({ guardianId: 'open-zeppelin', guardianEndpoint: OZ.endpoint });
  });

  // Verdicts land AFTER the default is picked (the map starts empty), so the
  // default card can turn out to be offline. The selection has to follow the
  // verdict rather than sit on a card the user cannot tap.
  it('moves the default selection to the first online provider when the default is offline (create flow)', () => {
    mockUseGuardianAvailability.mockReturnValue({ [OZ.endpoint]: 'offline' });
    const onSubmit = jest.fn();
    const { container } = render(<ChooseGuardianScreen onSubmit={onSubmit} />);
    const [ozBtn, gwBtn] = optionButtons(container);

    expect(ozBtn).toHaveAttribute('aria-checked', 'false');
    expect(gwBtn).toHaveAttribute('aria-checked', 'true');
    // The "default" badge still names the first card; only the selection moved.
    expect(ozBtn).toHaveAccessibleDescription(/^default guardianOfflineLabel/);

    fireEvent.click(screen.getByTestId('continue-button'));
    expect(onSubmit).toHaveBeenCalledWith({ guardianId: 'gateway', guardianEndpoint: GATEWAY.endpoint });
  });

  // The 30 s re-probe can flip an explicitly picked card offline while the user
  // is still on the screen. The pick is an intent; the verdict wins.
  it('drops an explicit selection that goes offline on a later probe round', () => {
    const onSubmit = jest.fn();
    const { container, rerender } = render(<ChooseGuardianScreen onSubmit={onSubmit} />);
    const [ozBtn, gwBtn] = optionButtons(container);

    fireEvent.click(gwBtn!);
    expect(gwBtn).toHaveAttribute('aria-checked', 'true');

    mockUseGuardianAvailability.mockReturnValue({ [GATEWAY.endpoint]: 'offline' });
    rerender(<ChooseGuardianScreen onSubmit={onSubmit} />);

    expect(gwBtn).toBeDisabled();
    expect(gwBtn).toHaveAttribute('aria-checked', 'false');
    expect(ozBtn).toHaveAttribute('aria-checked', 'true');

    fireEvent.click(screen.getByTestId('continue-button'));
    expect(onSubmit).toHaveBeenCalledWith({ guardianId: 'open-zeppelin', guardianEndpoint: OZ.endpoint });
  });

  // A card that recovers is selected again without a tap: the intent never
  // changed, only the verdict did.
  it('re-selects the default when it comes back online', () => {
    mockUseGuardianAvailability.mockReturnValue({ [OZ.endpoint]: 'offline' });
    const { container, rerender } = render(<ChooseGuardianScreen />);
    const [ozBtn, gwBtn] = optionButtons(container);
    expect(gwBtn).toHaveAttribute('aria-checked', 'true');

    mockUseGuardianAvailability.mockReturnValue({ [OZ.endpoint]: 'online' });
    rerender(<ChooseGuardianScreen />);
    expect(ozBtn).toHaveAttribute('aria-checked', 'true');
    expect(gwBtn).toHaveAttribute('aria-checked', 'false');
  });

  it('disables Continue when every provider is offline, instead of submitting the first one', () => {
    mockUseGuardianAvailability.mockReturnValue({
      [OZ.endpoint]: 'offline',
      [GATEWAY.endpoint]: 'offline',
      [LAMBDA.endpoint]: 'offline'
    });
    const onSubmit = jest.fn();
    const { container } = render(<ChooseGuardianScreen onSubmit={onSubmit} />);

    optionButtons(container).forEach(btn => {
      expect(btn).toBeDisabled();
      expect(btn).toHaveAttribute('aria-checked', 'false');
    });
    expect(screen.getByTestId('continue-button')).toBeDisabled();
    fireEvent.click(screen.getByTestId('continue-button'));
    expect(onSubmit).not.toHaveBeenCalled();
  });

  // The offline-rotation flow starts BECAUSE the current operator is down, and
  // the pre-selection rule says never nudge the user onto another operator by
  // default. So the down current card is disabled and NOTHING is selected: the
  // user must pick the replacement deliberately.
  it('pre-selects nothing when the offline current operator is stored with a trailing slash', () => {
    mockUseGuardianAvailability.mockReturnValue({ [GATEWAY.endpoint]: 'offline' });
    const { container } = render(<ChooseGuardianScreen currentEndpoint={`${GATEWAY.endpoint}/`} />);

    optionButtons(container).forEach(btn => expect(btn).toHaveAttribute('aria-checked', 'false'));
    expect(screen.getByTestId('guardian-offline-banner').closest('button')).toHaveAccessibleDescription(
      /^currentLabel guardianOfflineLabel/
    );
    expect(screen.getByTestId('continue-button')).toBeDisabled();
  });

  // The rotation flow's rule covers a replacement the user picked, not only the
  // operator the account is on: an offline pick selects nothing there.
  it('drops an explicit pick in the switch flow that goes offline, selecting nothing', () => {
    const onSubmit = jest.fn();
    const { container, rerender } = render(<ChooseGuardianScreen currentEndpoint={OZ.endpoint} onSubmit={onSubmit} />);
    const [ozBtn, gwBtn, lcBtn] = optionButtons(container);

    fireEvent.click(gwBtn!);
    expect(gwBtn).toHaveAttribute('aria-checked', 'true');

    mockUseGuardianAvailability.mockReturnValue({ [GATEWAY.endpoint]: 'offline' });
    rerender(<ChooseGuardianScreen currentEndpoint={OZ.endpoint} onSubmit={onSubmit} />);

    expect(gwBtn).toBeDisabled();
    [ozBtn, gwBtn, lcBtn].forEach(btn => expect(btn).toHaveAttribute('aria-checked', 'false'));
    expect(screen.getByTestId('continue-button')).toBeDisabled();
  });

  it('pre-selects nothing in the switch flow when the current operator is offline', () => {
    mockUseGuardianAvailability.mockReturnValue({ [GATEWAY.endpoint]: 'offline' });
    const onSubmit = jest.fn();
    const { container } = render(<ChooseGuardianScreen currentEndpoint={GATEWAY.endpoint} onSubmit={onSubmit} />);
    const [ozBtn, gwBtn, lcBtn] = optionButtons(container);

    expect(gwBtn).toBeDisabled();
    [ozBtn, gwBtn, lcBtn].forEach(btn => expect(btn).toHaveAttribute('aria-checked', 'false'));
    // "Current" survives on the strip so the user still sees what they are leaving.
    expect(screen.getByTestId('guardian-offline-banner').closest('button')).toHaveAccessibleDescription(
      /^currentLabel guardianOfflineLabel/
    );

    expect(screen.getByTestId('continue-button')).toBeDisabled();
    fireEvent.click(screen.getByTestId('continue-button'));
    expect(onSubmit).not.toHaveBeenCalled();

    fireEvent.click(lcBtn!);
    expect(lcBtn).toHaveAttribute('aria-checked', 'true');
    expect(screen.getByTestId('continue-button')).not.toBeDisabled();
    fireEvent.click(screen.getByTestId('continue-button'));
    expect(onSubmit).toHaveBeenCalledWith({ guardianId: 'lambda-class', guardianEndpoint: LAMBDA.endpoint });
  });

  // The custom field is its own escape hatch: a user pointing at their own
  // Guardian is not blocked by the built-in operators being down.
  it('keeps Continue enabled for a custom URL while every provider is offline', () => {
    mockUseGuardianAvailability.mockReturnValue({
      [OZ.endpoint]: 'offline',
      [GATEWAY.endpoint]: 'offline',
      [LAMBDA.endpoint]: 'offline'
    });
    const onSubmit = jest.fn();
    render(<ChooseGuardianScreen allowCustomEndpoint onSubmit={onSubmit} />);
    expect(screen.getByTestId('continue-button')).toBeDisabled();

    fireEvent.click(screen.getByText('useCustomGuardianUrl'));
    expect(screen.getByTestId('continue-button')).not.toBeDisabled();
    fireEvent.change(screen.getByTestId('custom-input'), { target: { value: 'https://custom.example.com' } });
    fireEvent.click(screen.getByTestId('continue-button'));
    expect(onSubmit).toHaveBeenCalledWith({ guardianId: 'custom', guardianEndpoint: 'https://custom.example.com' });
  });
});

describe('ChooseGuardian — no-guardian option', () => {
  const oneOption = [{ id: 'open-zeppelin', name: 'OZ', operatedBy: 'OZ', location: 'US', endpoint: 'https://g' }];

  it('hides the No guardian card by default', () => {
    mockGetGuardianOptions.mockReturnValue(oneOption);
    render(<ChooseGuardianScreen onSubmit={jest.fn()} />);
    expect(screen.queryByTestId('choose-no-guardian')).toBeNull();
  });

  it('shows the card and submits the sentinel when enabled', () => {
    mockGetGuardianOptions.mockReturnValue(oneOption);
    const onSubmit = jest.fn();
    render(<ChooseGuardianScreen onSubmit={onSubmit} showNoGuardianOption />);
    fireEvent.click(screen.getByTestId('choose-no-guardian'));
    fireEvent.click(screen.getByTestId('continue-button'));
    expect(onSubmit).toHaveBeenCalledWith({ guardianId: 'no-guardian', guardianEndpoint: '' });
  });

  it('exposes the no-guardian card as pressed when selected, since selection is otherwise colour-only', () => {
    mockGetGuardianOptions.mockReturnValue(oneOption);
    render(<ChooseGuardianScreen showNoGuardianOption />);

    const noGuardian = screen.getByTestId('choose-no-guardian');
    // Title + subtitle are children of this button, so they already name it.
    // An aria-label would override that composed name for no gain.
    expect(noGuardian).not.toHaveAttribute('aria-label');
    expect(noGuardian).toHaveAccessibleName(/noGuardianOptionTitle/);
    expect(noGuardian).toHaveAttribute('aria-checked', 'false');

    fireEvent.click(noGuardian);
    expect(noGuardian).toHaveAttribute('aria-checked', 'true');
  });
});
