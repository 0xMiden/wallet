import React from 'react';

import { act, fireEvent, render, screen } from '@testing-library/react';

import { hapticLight } from 'lib/mobile/haptics';

import { MainnetCountdownBanner, formatCountdown } from './MainnetCountdownBanner';

jest.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, params?: Record<string, string>) => (params ? `${key}:${params.time}` : key)
  })
}));

jest.mock('lib/mobile/haptics', () => ({ hapticLight: jest.fn() }));

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

const LAUNCH_AT = Date.parse('2026-10-26T00:00:00Z');

const DAY_MS = 24 * 60 * 60 * 1000;

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
  });

  afterEach(() => {
    jest.useRealTimers();
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
    expect(link).toHaveClass('min-h-11', 'focus-visible:ring-2');
    expect(link).not.toHaveClass('underline');
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

  it('renders nothing once the launch moment has passed', () => {
    jest.setSystemTime(Date.parse('2026-10-26T00:00:00Z'));
    render(<MainnetCountdownBanner />);

    expect(screen.queryByTestId('mainnet-countdown-banner')).not.toBeInTheDocument();
  });

  it('goes away on the tick that reaches the launch moment', () => {
    jest.setSystemTime(Date.parse('2026-10-25T23:59:59Z'));
    render(<MainnetCountdownBanner />);
    expect(screen.getByTestId('mainnet-countdown')).toHaveTextContent('00:00:00:01');

    act(() => {
      jest.advanceTimersByTime(1_000);
    });
    expect(screen.queryByTestId('mainnet-countdown-banner')).not.toBeInTheDocument();
  });
});
