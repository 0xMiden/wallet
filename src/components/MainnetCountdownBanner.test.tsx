import React from 'react';

import { act, fireEvent, render, screen } from '@testing-library/react';

import { MIDEN_NETWORK_NAME } from 'lib/miden-chain/networks-config';
import { hapticLight } from 'lib/mobile/haptics';
import { useMainnetLaunched } from 'lib/remote-config/use-mainnet-launch';

import { MainnetCountdownBanner, formatCountdown } from './MainnetCountdownBanner';

jest.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, params?: Record<string, string>) => (params ? `${key}:${params.time}` : key)
  })
}));

jest.mock('lib/mobile/haptics', () => ({ hapticLight: jest.fn(), hapticSelection: jest.fn() }));

// Vaul renders through a portal that jsdom cannot drive. A flat stand-in that renders its children
// only while open is sufficient for the open and close wiring; with mockKeepContentAfterClose it keeps
// them mounted once opened, as the real sheet does through its exit animation.
let mockKeepContentAfterClose = false;
jest.mock('lib/ui/drawer', () => ({
  Drawer: ({
    open,
    onOpenChange,
    children
  }: {
    open: boolean;
    onOpenChange: (open: boolean) => void;
    children: React.ReactNode;
  }) => {
    const opened = jest.requireActual<typeof import('react')>('react').useRef(false);
    opened.current ||= open;
    return open || (mockKeepContentAfterClose && opened.current) ? (
      <div>
        <button type="button" data-testid="sheet-dismiss" onClick={() => onOpenChange(false)} />
        {children}
      </div>
    ) : null;
  },
  DrawerContent: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  DrawerHeader: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  DrawerTitle: ({ children }: { children: React.ReactNode }) => <h2>{children}</h2>,
  DrawerDescription: ({ children }: { children: React.ReactNode }) => <p>{children}</p>
}));

jest.mock('@capacitor/clipboard', () => ({ Clipboard: { read: jest.fn() } }));

// The mainnet node's answer before the switch; the order log shows what ran before what.
const mockSteps: string[] = [];
const mockCheck = jest.fn<Promise<'granted' | 'rejected'>, [string]>();
jest.mock('lib/mainnet-access', () => ({
  MAINNET_ACCESS_CODE_LENGTH: 12,
  isMainnetAccessCodeComplete: (code: string) => /^(?:[0-9]{8}|[A-Za-z0-9]{12})$/.test(code),
  checkMainnetAccessCodeBeforeSwitch: (code: string) => {
    mockSteps.push('check');
    return mockCheck(code);
  }
}));

const mockOpenExternalUrl = jest.fn((_options: { url: string; title: string }) => Promise.resolve());
jest.mock('lib/mobile/external-browser', () => ({
  openExternalUrl: (options: { url: string; title: string }) => mockOpenExternalUrl(options)
}));

jest.mock('app/constants', () => ({
  MAINNET_EARLY_ACCESS_URL: 'https://miden.xyz/bread'
}));

// The remote config's section, as the runtime hands it to this realm; null stands for no accepted document.
let mockCountdown: { enabled: boolean; launchAt?: number } | null = null;
jest.mock('lib/remote-config/use-feature-availability', () => ({
  useBridgeConfigSnapshot: () => ({
    network: 'testnet',
    status: 'ready',
    config: mockCountdown === null ? null : { mainnetCountdown: mockCountdown },
    derived: null,
    lastFetch: null
  })
}));

// The effective network's name key; null stands for mainnet.
let mockNetworkKey: 'testnet' | 'devnet' | 'localnet' | null = 'testnet';
jest.mock('lib/miden-chain/effective-endpoints', () => ({
  getTestNetworkNameKey: () => mockNetworkKey
}));

let mockWipeFailure = false;
const mockConfirm = jest.fn<Promise<boolean>, [object]>();
const mockAlert = jest.fn<Promise<void>, [object]>();
const mockReset = jest.fn<Promise<void>, [MIDEN_NETWORK_NAME, string | undefined]>();
jest.mock('lib/ui/dialog', () => ({
  useConfirm: () => (options: object) => {
    mockSteps.push('confirm');
    return mockConfirm(options);
  },
  useAlert: () => mockAlert
}));
jest.mock('lib/miden/reset-and-reload', () => ({
  resetWalletAndReload: async (onError: () => Promise<void>, network: MIDEN_NETWORK_NAME, code?: string) => {
    mockSteps.push('reset');
    if (mockWipeFailure) await onError();
    return mockReset(network, code);
  }
}));

const LAUNCH_AT = Date.parse('2026-10-26T00:00:00Z');

// Moves the clock to the launch moment: mainnet has launched, so the banner offers the switch.
const launched = () => jest.setSystemTime(LAUNCH_AT);

const CODE = '8gKIgL0O6HcU';

// Opens the switch from the banner, enters a code and asks for it to be checked.
const submitCode = async (code: string = CODE) => {
  fireEvent.click(screen.getByTestId('mainnet-switch-link'));
  fireEvent.change(screen.getByTestId('mainnet-switch-code'), { target: { value: code } });
  await act(async () => {
    fireEvent.click(screen.getByTestId('mainnet-switch-submit'));
  });
};

const DAY_MS = 24 * 60 * 60 * 1000;
const visibilityDescriptor = Object.getOwnPropertyDescriptor(document, 'visibilityState');

function setVisibility(state: 'visible' | 'hidden'): void {
  Object.defineProperty(document, 'visibilityState', { configurable: true, value: state });
}

function restoreVisibility(): void {
  if (visibilityDescriptor) Object.defineProperty(document, 'visibilityState', visibilityDescriptor);
  else Reflect.deleteProperty(document, 'visibilityState');
}

const LaunchState = () => (
  <output data-testid="mainnet-launch-state">{useMainnetLaunched() ? 'launched' : 'pending'}</output>
);

describe('formatCountdown', () => {
  const launchAt = LAUNCH_AT;

  it('reads days, hours, minutes and seconds, each two digits', () => {
    expect(formatCountdown(launchAt - (17 * DAY_MS + 4 * 3600_000 + 12 * 60_000 + 36_000), launchAt)).toBe(
      '17:04:12:36'
    );
    expect(formatCountdown(launchAt - 5_000, launchAt)).toBe('00:00:00:05');
  });

  it('drops the sub-second remainder instead of rounding it up', () => {
    expect(formatCountdown(launchAt - 1_999, launchAt)).toBe('00:00:00:01');
  });

  it('is null at the launch moment and after it', () => {
    expect(formatCountdown(launchAt, launchAt)).toBeNull();
    expect(formatCountdown(launchAt + 1, launchAt)).toBeNull();
  });
});

describe('MainnetCountdownBanner', () => {
  beforeEach(() => {
    jest.useFakeTimers();
    jest.setSystemTime(Date.parse('2026-10-08T19:47:24Z'));
    jest.clearAllMocks();
    mockCountdown = { enabled: true, launchAt: LAUNCH_AT };
    mockNetworkKey = 'testnet';
    mockWipeFailure = false;
    mockConfirm.mockResolvedValue(false);
    mockAlert.mockResolvedValue(undefined);
    mockReset.mockResolvedValue(undefined);
    mockCheck.mockResolvedValue('granted');
    mockSteps.length = 0;
    mockKeepContentAfterClose = false;
  });

  afterEach(() => {
    jest.useRealTimers();
    restoreVisibility();
  });

  it('updates the banner and launch state together when a hidden page becomes visible', () => {
    setVisibility('hidden');
    jest.setSystemTime(LAUNCH_AT - 60_000);
    render(
      <>
        <MainnetCountdownBanner />
        <LaunchState />
      </>
    );

    expect(screen.getByTestId('mainnet-countdown')).toBeInTheDocument();
    expect(screen.getByTestId('mainnet-launch-state')).toHaveTextContent('pending');

    act(() => {
      jest.setSystemTime(LAUNCH_AT + 60_000);
      setVisibility('visible');
      document.dispatchEvent(new Event('visibilitychange'));
    });

    expect(screen.getByTestId('mainnet-switch-banner')).toBeInTheDocument();
    expect(screen.getByTestId('mainnet-launch-state')).toHaveTextContent('launched');
  });

  it('asks for a mainnet access code once the launch moment has passed, in place of the countdown', () => {
    launched();
    render(<MainnetCountdownBanner />);
    expect(screen.getByRole('button', { name: 'mainnetAccessTitle' })).toBeInTheDocument();
    expect(screen.queryByTestId('mainnet-countdown')).not.toBeInTheDocument();
    expect(mockReset).not.toHaveBeenCalled();
  });

  it('opens the code entry first, asking nothing and wiping nothing', () => {
    launched();
    render(<MainnetCountdownBanner />);
    fireEvent.click(screen.getByTestId('mainnet-switch-link'));
    expect(screen.getByRole('heading', { level: 2 })).toHaveTextContent('switchToMainnet');
    expect(screen.getByText('mainnetSwitchCodeBody')).toBeInTheDocument();
    expect(screen.getByTestId('mainnet-switch-submit')).toBeDisabled();
    expect(mockSteps).toEqual([]);
  });

  it('wipes nothing for a code the mainnet node refuses, and says so', async () => {
    launched();
    mockCheck.mockResolvedValue('rejected');
    render(<MainnetCountdownBanner />);
    await submitCode('47291835');
    expect(mockCheck).toHaveBeenCalledWith('47291835');
    expect(mockSteps).toEqual(['check']);
    expect(mockReset).not.toHaveBeenCalled();
    expect(screen.getByTestId('mainnet-switch-error')).toHaveTextContent('mainnetAccessCodeRejected');
  });

  it('wipes nothing when the code cannot be checked, and says so', async () => {
    launched();
    mockCheck.mockRejectedValue(new Error('Failed to fetch'));
    render(<MainnetCountdownBanner />);
    await submitCode();
    expect(mockSteps).toEqual(['check']);
    expect(mockReset).not.toHaveBeenCalled();
    expect(screen.getByTestId('mainnet-switch-error')).toHaveTextContent('mainnetAccessCheckFailed');
    expect(screen.getByTestId('mainnet-switch-submit')).toBeEnabled();
  });

  it('keeps the wallet when the switch confirmation is cancelled', async () => {
    launched();
    render(<MainnetCountdownBanner />);
    await submitCode();
    expect(mockConfirm).toHaveBeenCalledWith(
      expect.objectContaining({ children: 'switchToMainnetConfirm', destructive: true })
    );
    expect(mockReset).not.toHaveBeenCalled();
    expect(screen.getByTestId('mainnet-switch-submit')).toBeEnabled();
  });

  it('resets for mainnet, carrying the code, only after the node accepted it and the user confirmed', async () => {
    launched();
    mockConfirm.mockResolvedValue(true);
    render(<MainnetCountdownBanner />);
    await submitCode();
    expect(mockSteps).toEqual(['check', 'confirm', 'reset']);
    expect(mockReset).toHaveBeenCalledWith(MIDEN_NETWORK_NAME.MAINNET, CODE);
  });

  it.each<[string, boolean]>([
    ['unmounts the entry', false],
    ['keeps the entry mounted through its exit', true]
  ])(
    'asks nothing more and wipes nothing when the sheet is closed before the node answers and %s',
    async (_label, keepContent) => {
      launched();
      mockKeepContentAfterClose = keepContent;
      mockConfirm.mockResolvedValue(true);
      let settle: (outcome: 'granted') => void = () => {};
      mockCheck.mockReturnValue(new Promise(resolve => (settle = resolve)));
      render(<MainnetCountdownBanner />);
      await submitCode();
      fireEvent.click(screen.getByTestId('sheet-dismiss'));
      await act(async () => settle('granted'));
      expect(mockConfirm).not.toHaveBeenCalled();
      expect(mockSteps).toEqual(['check']);
      expect(mockReset).not.toHaveBeenCalled();
      expect(screen.queryByTestId('mainnet-switch-submit') !== null).toBe(keepContent);
    }
  );

  it('checks no code submitted while the closed sheet is still mounted', async () => {
    launched();
    mockKeepContentAfterClose = true;
    render(<MainnetCountdownBanner />);
    fireEvent.click(screen.getByTestId('mainnet-switch-link'));
    fireEvent.change(screen.getByTestId('mainnet-switch-code'), { target: { value: CODE } });
    fireEvent.click(screen.getByTestId('sheet-dismiss'));
    await act(async () => {
      fireEvent.click(screen.getByTestId('mainnet-switch-submit'));
    });
    expect(mockCheck).not.toHaveBeenCalled();
    expect(mockSteps).toEqual([]);
  });

  it('reports a failed reset and permits a retry', async () => {
    launched();
    mockConfirm.mockResolvedValue(true);
    mockReset.mockRejectedValueOnce(new Error('Reset failed'));
    render(<MainnetCountdownBanner />);
    await submitCode();
    expect(mockAlert).toHaveBeenCalledWith({
      title: 'error',
      children: 'resetDidNotFinish',
      errorId: 'resetDidNotFinish'
    });
    expect(screen.getByTestId('mainnet-switch-submit')).toBeEnabled();
  });

  it('forwards resetDidNotFinish from the actual mainnet wipe-error callback', async () => {
    launched();
    mockConfirm.mockResolvedValue(true);
    mockWipeFailure = true;
    render(<MainnetCountdownBanner />);

    await submitCode();

    expect(mockReset).toHaveBeenCalledWith(MIDEN_NETWORK_NAME.MAINNET, CODE);
    expect(mockAlert.mock.calls).toEqual([
      [{ title: 'error', children: 'resetDidNotFinish', errorId: 'resetDidNotFinish' }]
    ]);
    expect(screen.getByTestId('mainnet-switch-submit')).toBeEnabled();
  });

  it('forwards resetDidNotFinish from the actual mainnet reset outer catch', async () => {
    launched();
    mockConfirm.mockResolvedValue(true);
    mockReset.mockRejectedValueOnce(new Error('prepare or reload refused'));
    render(<MainnetCountdownBanner />);

    await submitCode();

    expect(mockReset).toHaveBeenCalledWith(MIDEN_NETWORK_NAME.MAINNET, CODE);
    expect(mockAlert.mock.calls).toEqual([
      [{ title: 'error', children: 'resetDidNotFinish', errorId: 'resetDidNotFinish' }]
    ]);
    expect(screen.getByTestId('mainnet-switch-submit')).toBeEnabled();
  });

  it('does not offer the switch on mainnet', () => {
    launched();
    mockNetworkKey = null;
    render(<MainnetCountdownBanner />);
    expect(screen.queryByTestId('mainnet-switch-banner')).not.toBeInTheDocument();
  });

  it('counts down to the launch once a second', () => {
    render(<MainnetCountdownBanner />);

    const clock = screen.getByTestId('mainnet-countdown');
    expect(clock).toHaveTextContent('17:04:12:36');
    expect(clock).toHaveAttribute('aria-label', 'mainnetCountdownLabel:17:04:12:36');

    act(() => {
      jest.advanceTimersByTime(1_000);
    });
    expect(clock).toHaveTextContent('17:04:12:35');
  });

  it('opens the early-access list with a tap haptic', () => {
    render(<MainnetCountdownBanner />);

    const link = screen.getByRole('button', { name: 'mainnetCountdownLink' });
    fireEvent.click(link);

    expect(hapticLight).toHaveBeenCalledTimes(1);
    expect(link).toHaveClass('min-h-11', 'focus-visible:ring-2', 'underline');
    expect(mockOpenExternalUrl).toHaveBeenCalledWith({ url: 'https://miden.xyz/bread', title: 'mainnetCountdownLink' });
  });

  it.each([
    ['the switch is off', { enabled: false, launchAt: LAUNCH_AT }],
    ['the switch is on with no moment', { enabled: true }],
    ['no document has been accepted', null]
  ])('renders nothing while %s', (_label, countdown) => {
    mockCountdown = countdown;
    render(<MainnetCountdownBanner />);

    expect(screen.queryByTestId('mainnet-countdown-banner')).not.toBeInTheDocument();
  });

  it('renders nothing on mainnet, even with a countdown set', () => {
    mockNetworkKey = null;
    render(<MainnetCountdownBanner />);

    expect(screen.queryByTestId('mainnet-countdown-banner')).not.toBeInTheDocument();
  });

  it('offers the switch instead of the countdown once the launch moment has passed', () => {
    jest.setSystemTime(Date.parse('2026-10-26T00:00:00Z'));
    render(<MainnetCountdownBanner />);

    expect(screen.queryByTestId('mainnet-countdown-banner')).not.toBeInTheDocument();
    expect(screen.getByTestId('mainnet-switch-banner')).toBeInTheDocument();
  });

  it.each([
    ['the switch is off', { enabled: false, launchAt: LAUNCH_AT }],
    ['the switch is on with no moment', { enabled: true }],
    ['no document has been accepted', null]
  ])('offers no switch after the moment while %s', (_label, countdown) => {
    jest.setSystemTime(Date.parse('2026-10-26T00:00:00Z'));
    mockCountdown = countdown;
    render(<MainnetCountdownBanner />);

    expect(screen.queryByTestId('mainnet-switch-banner')).not.toBeInTheDocument();
    expect(screen.queryByTestId('mainnet-countdown-banner')).not.toBeInTheDocument();
  });

  it('turns into the switch on the tick that reaches the launch moment', () => {
    jest.setSystemTime(Date.parse('2026-10-25T23:59:59Z'));
    render(<MainnetCountdownBanner />);
    expect(screen.getByTestId('mainnet-countdown')).toHaveTextContent('00:00:00:01');

    act(() => {
      jest.advanceTimersByTime(1_000);
    });
    expect(screen.queryByTestId('mainnet-countdown-banner')).not.toBeInTheDocument();
    expect(screen.getByTestId('mainnet-switch-banner')).toBeInTheDocument();
  });

  it('counts down again when the document moves the moment ahead after the launch', () => {
    jest.setSystemTime(Date.parse('2026-10-26T00:00:00Z'));
    const view = render(<MainnetCountdownBanner />);
    expect(screen.getByTestId('mainnet-switch-banner')).toBeInTheDocument();

    mockCountdown = { enabled: true, launchAt: LAUNCH_AT + DAY_MS };
    view.rerender(<MainnetCountdownBanner />);
    expect(screen.queryByTestId('mainnet-switch-banner')).not.toBeInTheDocument();
    expect(screen.getByTestId('mainnet-countdown')).toHaveTextContent('01:00:00:00');
  });
});
