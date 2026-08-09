import React from 'react';

import { render, screen, fireEvent } from '@testing-library/react';

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

// `react-i18next` pulls in the full i18n runtime; stub `useTranslation` so
// `t(key)` echoes the key back and every rendered label is the raw key.
jest.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key })
}));

// Guardian provider list — controlled per-test so we can exercise the
// create/switch/empty branches deterministically. Ids normally match the
// module-private `GUARDIAN_LOGOS` keys; an id with no matching entry falls
// back to the generic avatar instead of throwing (see the "unknown operator"
// regression test below).
const mockGetGuardianOptions = jest.fn();
jest.mock('lib/miden-chain/constants', () => ({
  getGuardianOptionsForNetwork: (...args: unknown[]) => mockGetGuardianOptions(...args)
}));

// Haptics — no-op mock so we can assert taps trigger feedback without dragging
// in the Capacitor plugin.
const mockHapticLight = jest.fn();
jest.mock('lib/mobile/haptics', () => ({
  hapticLight: () => mockHapticLight()
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
  Button: ({ title, onClick }: { title?: string; onClick?: () => void }) => (
    <button data-testid="continue-button" onClick={onClick}>
      {title}
    </button>
  )
}));

// `Input` — thin controlled input echoing the props the screen threads through
// (rest props forwarded so keyboard attributes like enterKeyHint are assertable).
jest.mock('components/Input', () => ({
  Input: ({
    id,
    value,
    placeholder,
    onChange,
    ...rest
  }: {
    id?: string;
    value?: string;
    placeholder?: string;
    onChange?: (e: React.ChangeEvent<HTMLInputElement>) => void;
  } & React.InputHTMLAttributes<HTMLInputElement>) => (
    <input data-testid="custom-input" id={id} value={value} placeholder={placeholder} onChange={onChange} {...rest} />
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
  name: 'Lambda Class',
  operatedBy: 'Lambda Class',
  location: 'EU-WEST',
  endpoint: 'https://lc.example.com'
};

const allOptions = () => [{ ...OZ }, { ...GATEWAY }, { ...LAMBDA }];

// Option cards are the only `<button>`s carrying a Logo `<svg>` child; this
// yields them in provider order.
const optionButtons = (container: HTMLElement): HTMLButtonElement[] =>
  Array.from(container.querySelectorAll('button')).filter(b => b.querySelector('svg')) as HTMLButtonElement[];

const isHighlighted = (btn: HTMLElement) => btn.className.includes('border-primary-500');

beforeEach(() => {
  jest.clearAllMocks();
  mockGetGuardianOptions.mockReturnValue(allOptions());
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

    // Operator + location labels are rendered per card.
    expect(screen.getByText('OpenZeppelin')).toBeInTheDocument();
    expect(screen.getByText('Gateway')).toBeInTheDocument();
    expect(screen.getByText('US-EAST')).toBeInTheDocument();

    // Continue button uses the default label.
    expect(screen.getByTestId('continue-button')).toHaveTextContent('continue');

    // Info drawer starts closed.
    expect(screen.getByTestId('info-drawer')).toHaveAttribute('data-open', 'false');
  });

  it('honours custom title / description / submitLabel props', () => {
    render(<ChooseGuardianScreen title="Pick one" description="Choose wisely" submitLabel="Go" />);
    expect(screen.getByRole('heading', { name: 'Pick one' })).toBeInTheDocument();
    expect(screen.getByText('Choose wisely')).toBeInTheDocument();
    expect(screen.getByTestId('continue-button')).toHaveTextContent('Go');
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
    expect(mockHapticLight).toHaveBeenCalledTimes(1);
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
    expect(screen.getByText('Mystery Co')).toBeInTheDocument();
    expect(screen.getByText('US-WEST')).toBeInTheDocument();
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

  it('falls back to the first provider when currentEndpoint matches nothing', () => {
    const { container } = render(<ChooseGuardianScreen currentEndpoint="https://unknown.example.com" />);
    const [ozBtn] = optionButtons(container);

    expect(isHighlighted(ozBtn!)).toBe(true);
    // No "current" badge (nothing matched); the default badge is shown instead.
    expect(screen.queryByText('currentLabel')).not.toBeInTheDocument();
    expect(screen.getByText('default')).toBeInTheDocument();
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
});
