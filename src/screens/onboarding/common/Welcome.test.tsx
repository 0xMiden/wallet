import React from 'react';

import { createEvent, render, screen, fireEvent } from '@testing-library/react';

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

// The remote config snapshot Welcome waits on before it shows its actions. The runtime itself reads
// storage and the network, so the hook returns this mutable snapshot instead.
const ALL_OFF = { earn: false, nearIntents: false, fastBridge: false, bridgeIn: false, bridgeOut: false };
const snapshotWith = (
  onboarding: { inviteOnly: boolean } | undefined,
  status: BridgeConfigSnapshot['status'] = 'ready'
): BridgeConfigSnapshot => ({
  network: 'testnet',
  status,
  config: {
    network: 'testnet',
    version: 1,
    'bridge-providers': { epoch: {}, agglayer: {}, usdcx: {} },
    supportedEvmChains: {},
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
  NoCodeSheet: ({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) =>
    open ? (
      <div data-testid="no-code-sheet">
        <button type="button" data-testid="no-code-sheet-close" onClick={() => onOpenChange(false)} />
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
    // The actions use one column in the footer.
    const footer = screen.getByTestId('btn-getStarted').closest('[data-slot="footer"]');
    expect(footer).toBeInTheDocument();
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

describe('WelcomeScreen logo taps', () => {
  it('ask the host to unlock the invite-only Welcome after 7 taps on the general one', () => {
    const onUnlockInviteOnly = jest.fn();
    renderComponent({ onUnlockInviteOnly });
    tapLogo(6);
    expect(onUnlockInviteOnly).not.toHaveBeenCalled();
    expect(hapticMedium).not.toHaveBeenCalled();

    tapLogo(1);
    expect(onUnlockInviteOnly).toHaveBeenCalledTimes(1);
    expect(hapticMedium).toHaveBeenCalledTimes(1);
    expect(mockNavigate).not.toHaveBeenCalled();
    // The host decides the variant: the taps alone change nothing on screen.
    expect(screen.getByTestId('btn-getStarted')).toBeInTheDocument();
  });

  it('open developer settings after 7 taps when the invite-only Welcome already shows', () => {
    const onUnlockInviteOnly = jest.fn();
    renderComponent({ inviteOnly: true, onUnlockInviteOnly });
    tapLogo(6);
    expect(mockNavigate).not.toHaveBeenCalled();
    tapLogo(1);
    expect(mockNavigate).toHaveBeenCalledWith('/developer-settings');
    expect(onUnlockInviteOnly).not.toHaveBeenCalled();
    expect(hapticMedium).toHaveBeenCalledTimes(1);
  });

  it('open developer settings after 7 taps when the host has no unlock', () => {
    renderComponent();
    tapLogo(7);
    expect(mockNavigate).toHaveBeenCalledWith('/developer-settings');
    expect(screen.queryByTestId('btn-iHaveACode')).not.toBeInTheDocument();
  });

  it('opens nothing when the seventh tap comes more than two seconds after the sixth', () => {
    const onUnlockInviteOnly = jest.fn();
    renderComponent({ onUnlockInviteOnly });
    const logo = screen.getByTestId('onboarding-bread-logo');
    // The count reads the event's own time stamp; React falls back to Date.now() for a zero one.
    const tapAt = (timeStamp: number) => {
      const event = createEvent.click(logo);
      Object.defineProperty(event, 'timeStamp', { value: timeStamp });
      fireEvent(logo, event);
    };
    for (let i = 0; i < 6; i++) tapAt(10_000 + i * 300);
    tapAt(10_000 + 5 * 300 + 2_001);
    expect(onUnlockInviteOnly).not.toHaveBeenCalled();
    expect(mockNavigate).not.toHaveBeenCalled();
  });

  it('prevents text selection on the logo tap target', () => {
    renderComponent();
    const logo = screen.getByTestId('onboarding-bread-logo');
    expect(logo).toHaveClass('select-none');
  });
});

describe('WelcomeScreen invite-only variant', () => {
  it('replaces the test-network ways in with I have a code', () => {
    const onSubmit = jest.fn();
    renderComponent({ inviteOnly: true, onSubmit });
    expect(screen.getByTestId('onboarding-bread-logo')).toHaveAttribute('data-invite-onboarding', 'true');
    expect(screen.queryByTestId('btn-getStarted')).not.toBeInTheDocument();
    expect(document.getElementById('import-link')).toHaveAttribute('data-variant', 'secondary');

    const button = screen.getByTestId('btn-iHaveACode');
    expect(button).toHaveAttribute('data-tabindex', '0');
    expect(button).toHaveAttribute('data-variant', 'primary');
    fireEvent.click(button);
    expect(onSubmit).toHaveBeenLastCalledWith('mainnet-access');
    expect(screen.getByTestId('onboarding-no-code')).toHaveTextContent('iDontHaveACode');
  });

  it('opens and closes the no-code sheet, and recovers from the welcome page', () => {
    const onSubmit = jest.fn();
    renderComponent({ inviteOnly: true, onSubmit });
    expect(screen.queryByTestId('no-code-sheet')).not.toBeInTheDocument();

    fireEvent.click(screen.getByTestId('onboarding-no-code'));
    expect(screen.getByTestId('no-code-sheet')).toBeInTheDocument();
    expect(onSubmit).not.toHaveBeenCalled();

    fireEvent.click(screen.getByTestId('no-code-sheet-close'));
    expect(screen.queryByTestId('no-code-sheet')).not.toBeInTheDocument();

    fireEvent.click(screen.getByTestId('onboarding-no-code'));
    expect(screen.queryByTestId('no-code-sheet-recover')).not.toBeInTheDocument();
    fireEvent.click(screen.getByTestId('no-code-sheet-close'));
    fireEvent.click(screen.getByTestId('btn-recoverYourAccount'));
    expect(onSubmit).toHaveBeenCalledTimes(1);
    expect(onSubmit).toHaveBeenCalledWith('select-import-type');
    expect(screen.queryByTestId('no-code-sheet')).not.toBeInTheDocument();
  });

  it('does not throw when I have a code is clicked without an onSubmit handler', () => {
    renderComponent({ inviteOnly: true });
    expect(() => fireEvent.click(screen.getByTestId('btn-iHaveACode'))).not.toThrow();
  });

  it.each([{ inviteOnly: true }, { inviteOnly: false }, undefined])(
    'takes the variant from its host, not from the document (onboarding %j)',
    onboarding => {
      mockSnapshot = snapshotWith(onboarding);
      const view = renderComponent();
      expect(screen.getByTestId('btn-getStarted')).toBeInTheDocument();
      expect(screen.queryByTestId('btn-iHaveACode')).not.toBeInTheDocument();

      view.rerender(<WelcomeScreen inviteOnly />);
      expect(screen.getByTestId('btn-iHaveACode')).toBeInTheDocument();
      expect(screen.queryByTestId('btn-getStarted')).not.toBeInTheDocument();
    }
  );
});

describe('WelcomeScreen recover-only variant', () => {
  it('offers recovery alone, as the primary action', () => {
    const onSubmit = jest.fn();
    renderComponent({ recoverOnly: true, onSubmit });
    expect(screen.queryByTestId('btn-getStarted')).not.toBeInTheDocument();
    expect(screen.queryByTestId('btn-iHaveACode')).not.toBeInTheDocument();
    const recover = document.getElementById('import-link');
    expect(recover).toHaveAttribute('data-variant', 'primary');
    fireEvent.click(recover!);
    expect(onSubmit).toHaveBeenCalledWith('select-import-type');
  });
});

describe('WelcomeScreen while the remote config loads', () => {
  it('shows invite actions at once', () => {
    mockSnapshot = LOADING;
    renderComponent({ inviteOnly: true });
    expect(screen.queryByRole('status')).not.toBeInTheDocument();
    expect(screen.getByTestId('btn-recoverYourAccount')).toBeVisible();
    expect(screen.getByTestId('btn-iHaveACode')).toBeVisible();
    expect(screen.getByTestId('onboarding-no-code')).toBeVisible();
    expect(screen.getByTestId('onboarding-no-code')).toHaveClass('underline');
  });

  it('shows developer network actions at once', () => {
    mockSnapshot = LOADING;
    renderComponent();
    expect(screen.queryByRole('status')).not.toBeInTheDocument();
    expect(screen.getByTestId('btn-recoverYourAccount')).toBeVisible();
    expect(screen.getByTestId('btn-getStarted')).toBeVisible();
  });
});
