import React from 'react';

import { act, render, screen, fireEvent } from '@testing-library/react';

import { setInviteOnboardingUnlocked } from 'lib/invite-onboarding';
import type { BridgeConfigSnapshot } from 'lib/remote-config/runtime';

import { WelcomeScreen } from './Welcome';

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

// `react-i18next` pulls in the full i18n runtime; stub `useTranslation` so
// `t(key)` echoes the key back and every rendered label is the raw key.
jest.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key })
}));

const mockPlatform = { isMobile: false };
jest.mock('lib/platform', () => ({
  isMobile: () => mockPlatform.isMobile,
  isExtension: () => false
}));

// `hapticLight`/`hapticMedium` are native Capacitor wrappers; replace them with
// spies so the logo-unlock tap wiring can be asserted without touching the plugin.
const hapticLight = jest.fn();
const hapticMedium = jest.fn();
jest.mock('lib/mobile/haptics', () => ({
  hapticLight: () => hapticLight(),
  hapticMedium: () => hapticMedium()
}));

// `navigate` from the woozie router; the logo easter-egg calls it directly
// rather than going through `onSubmit`, so it needs its own spy.
const mockNavigate = jest.fn();
jest.mock('lib/woozie', () => ({
  navigate: (to: string) => mockNavigate(to)
}));

// The remote config snapshot Welcome reads its variant from. The runtime itself reads storage and
// the network, so the hook returns this mutable snapshot instead.
const ALL_OFF = { earn: false, fastBridge: false, bridgeIn: false, bridgeOut: false };
const snapshotWith = (
  onboarding: { inviteOnly: boolean } | undefined,
  status: BridgeConfigSnapshot['status'] = 'ready'
): BridgeConfigSnapshot => ({
  network: 'testnet',
  status,
  config: {
    network: 'testnet',
    version: 1,
    evm: {},
    agglayer: {},
    epoch: {},
    features: ALL_OFF,
    ...(onboarding === undefined ? {} : { onboarding })
  },
  derived: null,
  lastFetch: null
});
const LOADING: BridgeConfigSnapshot = {
  network: 'testnet',
  status: 'loading',
  config: null,
  derived: null,
  lastFetch: null
};
let mockSnapshot: BridgeConfigSnapshot = snapshotWith(undefined);
jest.mock('lib/remote-config/use-feature-availability', () => ({
  useBridgeConfigSnapshot: () => mockSnapshot
}));
jest.mock('lib/remote-config/runtime', () => ({ getBridgeConfigSnapshot: () => mockSnapshot }));

// `Button` — render the title and forward the click / tabIndex so the primary
// wiring can be verified. A `btn-<title>` test id makes the CTA addressable.
jest.mock('components/Button', () => ({
  ButtonVariant: { Primary: 'primary', Secondary: 'secondary' },
  Button: ({
    title,
    onClick,
    tabIndex,
    id,
    variant,
    className
  }: {
    title: string;
    onClick?: () => void;
    tabIndex?: number;
    id?: string;
    variant?: string;
    className?: string;
  }) => (
    <button
      id={id}
      className={className}
      data-testid={`btn-${title}`}
      data-tabindex={String(tabIndex)}
      data-variant={variant ?? 'primary'}
      onClick={onClick}
    >
      {title}
    </button>
  )
}));

// Vaul renders through a portal that jsdom cannot drive. A flat stand-in that renders its
// children only while open is sufficient for the open, close and recover wiring.
jest.mock('./NoCodeSheet', () => ({
  NoCodeSheet: ({
    open,
    onOpenChange,
    onRecover
  }: {
    open: boolean;
    onOpenChange: (open: boolean) => void;
    onRecover: () => void;
  }) =>
    open ? (
      <div data-testid="no-code-sheet">
        <button type="button" data-testid="no-code-sheet-close" onClick={() => onOpenChange(false)} />
        <button type="button" data-testid="no-code-sheet-recover" onClick={onRecover} />
      </div>
    ) : null
}));

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const renderComponent = (props: Partial<React.ComponentProps<typeof WelcomeScreen>> = {}) =>
  render(<WelcomeScreen {...props} />);

const tapLogo = (times: number) => {
  const logo = screen.getByTestId('onboarding-bread-logo');
  for (let i = 0; i < times; i++) fireEvent.click(logo);
};

beforeEach(() => {
  mockPlatform.isMobile = false;
  mockSnapshot = snapshotWith(undefined);
  setInviteOnboardingUnlocked(false);
  hapticLight.mockClear();
  hapticMedium.mockClear();
  mockNavigate.mockClear();
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('WelcomeScreen', () => {
  it('renders the onboarding welcome container with its test id', () => {
    renderComponent();
    expect(screen.getByTestId('onboarding-welcome')).toBeInTheDocument();
  });

  it('renders the bread logo and the hero on the shared layout, the actions pinned in its footer', () => {
    const { container } = renderComponent();
    expect(container.querySelector('svg')).toHaveClass('w-[140px]');
    expect(screen.getByRole('heading', { level: 1 })).toHaveClass('font-heading', 'text-ink');
    // 56px on a normal screen, smaller on the narrowest, and a long translated word wraps rather than clips.
    expect(screen.getByRole('heading', { level: 1 })).toHaveClass('text-[min(56px,15vw)]', '[overflow-wrap:anywhere]');
    expect(screen.getByText('breadWalletDescription')).toHaveClass('text-muted');
    const footer = screen.getByTestId('btn-getStarted').parentElement;
    expect(footer).toHaveAttribute('data-slot', 'footer');
    expect(footer).toContainElement(document.getElementById('import-link'));
  });

  it('renders the translated heading copy across its spans', () => {
    renderComponent();
    const heading = screen.getByRole('heading', { level: 1 });
    expect(heading).toHaveTextContent('welcome');
    expect(heading).toHaveTextContent('toLowercase');
    expect(heading).toHaveTextContent('midenWallet');
  });

  it('renders the primary get-started button as focusable (tabIndex 0), and no invite-only way in', () => {
    renderComponent();
    const button = screen.getByTestId('btn-getStarted');
    expect(button).toHaveTextContent('getStarted');
    expect(button).toHaveAttribute('data-tabindex', '0');
    expect(button).toHaveAttribute('data-variant', 'primary');
    expect(screen.queryByTestId('btn-iHaveACode')).not.toBeInTheDocument();
    expect(screen.queryByTestId('onboarding-no-code')).not.toBeInTheDocument();
  });

  it('renders recover-account as the secondary button under Get started', () => {
    renderComponent();
    const link = document.getElementById('import-link');
    expect(link).toHaveTextContent('recoverYourAccount');
    expect(link).toHaveAttribute('data-variant', 'secondary');
  });

  it('invokes onSubmit with "select-wallet-type" when get-started is clicked', () => {
    const onSubmit = jest.fn();
    renderComponent({ onSubmit });

    fireEvent.click(screen.getByTestId('btn-getStarted'));
    expect(onSubmit).toHaveBeenCalledTimes(1);
    expect(onSubmit).toHaveBeenCalledWith('select-wallet-type');
  });

  it('calls onSubmit with "select-import-type" when recover is clicked (the Button owns the haptic)', () => {
    const onSubmit = jest.fn();
    renderComponent({ onSubmit });

    fireEvent.click(document.getElementById('import-link')!);
    expect(onSubmit).toHaveBeenCalledTimes(1);
    expect(onSubmit).toHaveBeenCalledWith('select-import-type');
  });

  it('does not throw on recover or get-started without an onSubmit handler', () => {
    renderComponent();
    expect(() => fireEvent.click(document.getElementById('import-link')!)).not.toThrow();
    expect(() => fireEvent.click(screen.getByTestId('btn-getStarted'))).not.toThrow();
  });

  it('does not fire any callback before interaction', () => {
    const onSubmit = jest.fn();
    renderComponent({ onSubmit });

    expect(onSubmit).not.toHaveBeenCalled();
    expect(hapticLight).not.toHaveBeenCalled();
  });
});

describe('WelcomeScreen invite-only unlock, when the config sets no onboarding.inviteOnly', () => {
  it('turns the invite-only Welcome on after 7 taps on the logo: I have a code replaces the test-network ways in', () => {
    const onSubmit = jest.fn();
    renderComponent({ onSubmit });
    tapLogo(6);
    expect(screen.queryByTestId('btn-iHaveACode')).not.toBeInTheDocument();
    expect(hapticMedium).not.toHaveBeenCalled();

    tapLogo(1);
    expect(hapticMedium).toHaveBeenCalledTimes(1);
    expect(mockNavigate).not.toHaveBeenCalled();
    expect(screen.getByTestId('onboarding-bread-logo')).toHaveAttribute('data-invite-onboarding', 'true');
    expect(screen.queryByTestId('btn-getStarted')).not.toBeInTheDocument();
    expect(document.getElementById('import-link')).toBeNull();

    const button = screen.getByTestId('btn-iHaveACode');
    expect(button).toHaveAttribute('data-tabindex', '0');
    expect(button).toHaveAttribute('data-variant', 'primary');
    fireEvent.click(button);
    expect(onSubmit).toHaveBeenLastCalledWith('mainnet-access');
    expect(screen.getByTestId('onboarding-no-code')).toHaveTextContent('iDontHaveACode');
  });

  it("opens the no-code sheet from I don't have a code, closes it, and recovers through it", () => {
    const onSubmit = jest.fn();
    renderComponent({ onSubmit });
    tapLogo(7);
    expect(screen.queryByTestId('no-code-sheet')).not.toBeInTheDocument();

    fireEvent.click(screen.getByTestId('onboarding-no-code'));
    expect(screen.getByTestId('no-code-sheet')).toBeInTheDocument();
    expect(onSubmit).not.toHaveBeenCalled();

    fireEvent.click(screen.getByTestId('no-code-sheet-close'));
    expect(screen.queryByTestId('no-code-sheet')).not.toBeInTheDocument();

    fireEvent.click(screen.getByTestId('onboarding-no-code'));
    fireEvent.click(screen.getByTestId('no-code-sheet-recover'));
    expect(onSubmit).toHaveBeenCalledTimes(1);
    expect(onSubmit).toHaveBeenCalledWith('select-import-type');
    expect(screen.queryByTestId('no-code-sheet')).not.toBeInTheDocument();
  });

  it('does not throw when I have a code is clicked without an onSubmit handler', () => {
    renderComponent();
    tapLogo(7);
    expect(() => fireEvent.click(screen.getByTestId('btn-iHaveACode'))).not.toThrow();
  });

  it('stays on for the page: a remount keeps the invite-only Welcome', () => {
    const first = renderComponent();
    tapLogo(7);
    first.unmount();

    renderComponent();
    expect(screen.getByTestId('btn-iHaveACode')).toBeInTheDocument();
  });

  it('navigates to developer settings after 7 more taps', () => {
    renderComponent();
    tapLogo(7);
    expect(mockNavigate).not.toHaveBeenCalled();
    tapLogo(6);
    expect(mockNavigate).not.toHaveBeenCalled();
    tapLogo(1);
    expect(mockNavigate).toHaveBeenCalledWith('/developer-settings');
    expect(hapticMedium).toHaveBeenCalledTimes(2);
  });

  it('prevents text selection on the logo tap target', () => {
    renderComponent();
    const logo = screen.getByTestId('onboarding-bread-logo');
    expect(logo).toHaveClass('select-none');
  });
});

describe('WelcomeScreen variant from the remote config', () => {
  it('shows the general Welcome for a document with no onboarding section', () => {
    mockSnapshot = snapshotWith(undefined);
    renderComponent();
    expect(screen.getByTestId('btn-getStarted')).toBeInTheDocument();
    expect(screen.queryByTestId('btn-iHaveACode')).not.toBeInTheDocument();
  });

  it('shows the invite-only Welcome when the config sets inviteOnly true', () => {
    mockSnapshot = snapshotWith({ inviteOnly: true });
    const onSubmit = jest.fn();
    renderComponent({ onSubmit });
    expect(screen.getByTestId('onboarding-bread-logo')).toHaveAttribute('data-invite-onboarding', 'true');
    expect(screen.queryByTestId('btn-getStarted')).not.toBeInTheDocument();
    fireEvent.click(screen.getByTestId('btn-iHaveACode'));
    expect(onSubmit).toHaveBeenCalledWith('mainnet-access');
  });

  it('opens developer settings after 7 taps when the config sets inviteOnly true, with no variant switch', () => {
    mockSnapshot = snapshotWith({ inviteOnly: true });
    renderComponent();
    tapLogo(7);
    expect(mockNavigate).toHaveBeenCalledWith('/developer-settings');
    expect(hapticMedium).toHaveBeenCalledTimes(1);
    expect(screen.getByTestId('btn-iHaveACode')).toBeInTheDocument();
    expect(screen.queryByTestId('btn-getStarted')).not.toBeInTheDocument();
  });

  it('shows the general Welcome when the config sets inviteOnly false', () => {
    mockSnapshot = snapshotWith({ inviteOnly: false });
    renderComponent();
    expect(screen.getByTestId('onboarding-bread-logo')).not.toHaveAttribute('data-invite-onboarding');
    expect(screen.getByTestId('btn-getStarted')).toBeInTheDocument();
    expect(screen.queryByTestId('btn-iHaveACode')).not.toBeInTheDocument();
  });

  it('keeps the invite-only Welcome of an earlier unlock when the config sets inviteOnly false', () => {
    setInviteOnboardingUnlocked(true);
    mockSnapshot = snapshotWith({ inviteOnly: false });
    renderComponent();
    expect(screen.getByTestId('btn-iHaveACode')).toBeInTheDocument();
    expect(screen.queryByTestId('btn-getStarted')).not.toBeInTheDocument();
  });

  it('unlocks the invite-only Welcome after 7 taps when the config sets inviteOnly false, then opens developer settings', () => {
    mockSnapshot = snapshotWith({ inviteOnly: false });
    renderComponent();
    tapLogo(7);
    expect(mockNavigate).not.toHaveBeenCalled();
    expect(hapticMedium).toHaveBeenCalledTimes(1);
    expect(screen.getByTestId('btn-iHaveACode')).toBeInTheDocument();
    expect(screen.queryByTestId('btn-getStarted')).not.toBeInTheDocument();

    tapLogo(7);
    expect(mockNavigate).toHaveBeenCalledWith('/developer-settings');
  });

  it('follows the config when it lands after the first render', () => {
    mockSnapshot = snapshotWith(undefined);
    const view = renderComponent();
    expect(screen.getByTestId('btn-getStarted')).toBeInTheDocument();

    mockSnapshot = snapshotWith({ inviteOnly: true });
    view.rerender(<WelcomeScreen />);
    expect(screen.getByTestId('btn-iHaveACode')).toBeInTheDocument();
  });
});

describe('WelcomeScreen while the remote config loads', () => {
  beforeEach(() => jest.useFakeTimers());
  afterEach(() => jest.useRealTimers());

  it('hides the actions while the config loads, and shows the variant it sets once it lands', () => {
    mockSnapshot = LOADING;
    const view = renderComponent();
    expect(screen.getByTestId('btn-getStarted')).toHaveClass('invisible');
    expect(document.getElementById('import-link')).toHaveClass('invisible');

    mockSnapshot = snapshotWith({ inviteOnly: true });
    view.rerender(<WelcomeScreen />);
    expect(screen.getByTestId('btn-iHaveACode')).not.toHaveClass('invisible');
    expect(screen.getByTestId('onboarding-no-code')).not.toHaveClass('invisible');
  });

  it('shows the general actions when the config does not land within the wait', () => {
    mockSnapshot = LOADING;
    renderComponent();
    act(() => {
      jest.advanceTimersByTime(2_999);
    });
    expect(screen.getByTestId('btn-getStarted')).toHaveClass('invisible');
    act(() => {
      jest.advanceTimersByTime(1);
    });
    expect(screen.getByTestId('btn-getStarted')).not.toHaveClass('invisible');
    expect(document.getElementById('import-link')).not.toHaveClass('invisible');
  });
});
