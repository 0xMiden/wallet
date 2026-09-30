import React from 'react';

import { fireEvent, render, screen } from '@testing-library/react';

import { hapticLight } from 'lib/mobile/haptics';

import { NetworkModeBanner, NetworkNamedByShell } from './NetworkModeBanner';

jest.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, params?: Record<string, string>) => (params ? `${key}:${params.network}` : key)
  })
}));

jest.mock('lib/mobile/haptics', () => ({ hapticLight: jest.fn() }));

// The banner reads the effective network on every render, so a mutable mock can switch it between
// renders of one mounted instance.
let mockNetworkKey: 'testnet' | 'devnet' | 'localnet' | null = 'testnet';
jest.mock('lib/miden-chain/effective-endpoints', () => ({
  getTestNetworkNameKey: () => mockNetworkKey
}));

// The sheet's own behaviour (back, navigation, the dApp hold) is NetworkModeSheet.test's; here it
// only has to show whether the banner opened it, and hand back a way to close it.
jest.mock('components/NetworkModeSheet', () => ({
  NetworkModeSheet: ({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) =>
    open ? <button type="button" data-testid="network-mode-sheet" onClick={() => onOpenChange(false)} /> : null
}));

// The access sheet has its own suite. Here it shows that the banner opened it, and the function the
// banner gave it to check a code.
const mockRedeem = jest.fn();
jest.mock('lib/mainnet-access', () => ({
  redeemMainnetAccessCode: (code: string) => mockRedeem(code)
}));
jest.mock('components/MainnetAccessSheet', () => ({
  MainnetAccessSheet: ({
    open,
    onOpenChange,
    onSubmit
  }: {
    open: boolean;
    onOpenChange: (open: boolean) => void;
    onSubmit: (code: string) => Promise<string>;
  }) =>
    open ? (
      <div data-testid="mainnet-access-sheet">
        <button type="button" data-testid="mainnet-access-submit" onClick={() => onSubmit('47291835')} />
        <button type="button" data-testid="mainnet-access-close" onClick={() => onOpenChange(false)} />
      </div>
    ) : null
}));

const openSheet = () => fireEvent.click(screen.getByTestId('network-mode-banner'));

describe('NetworkModeBanner (the home variant)', () => {
  beforeEach(() => {
    mockNetworkKey = 'testnet';
    mockRedeem.mockReset();
    jest.mocked(hapticLight).mockClear();
  });

  it('names the effective network and offers the switch to mainnet', () => {
    mockNetworkKey = 'devnet';

    render(<NetworkModeBanner variant="home" />);

    expect(screen.getByTestId('network-mode-banner-network')).toHaveTextContent('networkModeHomeBanner:devnet');
    expect(screen.getByTestId('network-mode-banner-switch')).toHaveTextContent('switchToMainnet');
  });

  it('renders nothing on mainnet', () => {
    mockNetworkKey = null;

    const { container } = render(<NetworkModeBanner variant="home" />);

    expect(container).toBeEmptyDOMElement();
  });

  it('opens the explanation sheet from the network name, with one haptic', () => {
    render(<NetworkModeBanner variant="home" />);
    const name = screen.getByTestId('network-mode-banner-network');
    expect(name).toHaveAttribute('aria-expanded', 'false');

    fireEvent.click(name);

    expect(screen.getByTestId('network-mode-sheet')).toBeInTheDocument();
    expect(screen.queryByTestId('mainnet-access-sheet')).not.toBeInTheDocument();
    expect(name).toHaveAttribute('aria-expanded', 'true');
    expect(hapticLight).toHaveBeenCalledTimes(1);
  });

  it('opens the mainnet access sheet from the switch action, and closes it again', () => {
    render(<NetworkModeBanner variant="home" />);
    const action = screen.getByTestId('network-mode-banner-switch');
    expect(action).toHaveAttribute('aria-haspopup', 'dialog');

    fireEvent.click(action);

    expect(screen.getByTestId('mainnet-access-sheet')).toBeInTheDocument();
    expect(screen.queryByTestId('network-mode-sheet')).not.toBeInTheDocument();
    expect(action).toHaveAttribute('aria-expanded', 'true');
    expect(hapticLight).toHaveBeenCalledTimes(1);

    fireEvent.click(screen.getByTestId('mainnet-access-close'));

    expect(screen.queryByTestId('mainnet-access-sheet')).not.toBeInTheDocument();
    expect(action).toHaveAttribute('aria-expanded', 'false');
  });

  it('checks a submitted code with the access-code service', () => {
    render(<NetworkModeBanner variant="home" />);
    fireEvent.click(screen.getByTestId('network-mode-banner-switch'));

    fireEvent.click(screen.getByTestId('mainnet-access-submit'));

    expect(mockRedeem).toHaveBeenCalledWith('47291835');
  });

  it('stands down under a shell that already names the network', () => {
    render(
      <NetworkNamedByShell>
        <NetworkModeBanner variant="home" />
      </NetworkNamedByShell>
    );

    expect(screen.queryByTestId('network-mode-banner')).not.toBeInTheDocument();
  });
});

describe('NetworkModeBanner (the dApp confirm window)', () => {
  beforeEach(() => {
    mockNetworkKey = 'testnet';
    jest.mocked(hapticLight).mockClear();
  });

  it.each([
    ['testnet', 'networkModeBanner:testnet'],
    ['devnet', 'networkModeBanner:devnet'],
    ['localnet', 'networkModeBanner:localnet']
  ] as const)('names the effective network (%s)', (key, text) => {
    mockNetworkKey = key;

    render(<NetworkModeBanner />);

    expect(screen.getByTestId('network-mode-banner')).toHaveTextContent(text);
  });

  it('renders nothing on mainnet', () => {
    mockNetworkKey = null;

    const { container } = render(<NetworkModeBanner />);

    expect(container).toBeEmptyDOMElement();
  });

  it('follows an override saved while it stays mounted', () => {
    const { rerender } = render(<NetworkModeBanner />);
    mockNetworkKey = 'devnet';

    rerender(<NetworkModeBanner />);

    expect(screen.getByTestId('network-mode-banner')).toHaveTextContent('networkModeBanner:devnet');
  });

  it('opens the shared explanation sheet on tap, with one haptic, and reports it expanded', () => {
    render(<NetworkModeBanner />);
    const banner = screen.getByTestId('network-mode-banner');
    expect(banner).toHaveAttribute('aria-haspopup', 'dialog');
    expect(banner).toHaveAttribute('aria-expanded', 'false');
    expect(screen.queryByTestId('network-mode-sheet')).not.toBeInTheDocument();

    openSheet();

    expect(screen.getByTestId('network-mode-sheet')).toBeInTheDocument();
    expect(banner).toHaveAttribute('aria-expanded', 'true');
    expect(hapticLight).toHaveBeenCalledTimes(1);
  });

  it('collapses once the sheet closes', () => {
    render(<NetworkModeBanner />);
    openSheet();

    fireEvent.click(screen.getByTestId('network-mode-sheet'));

    expect(screen.queryByTestId('network-mode-sheet')).not.toBeInTheDocument();
    expect(screen.getByTestId('network-mode-banner')).toHaveAttribute('aria-expanded', 'false');
  });

  // A shell that already names the network wraps its subtree, and a nested banner stands down.
  // The alternative - the shell suppressing the nested one with a route condition - cannot hold
  // during a transition, because the condition and the exiting card update on different clocks.
  describe('nested under a shell that already names the network', () => {
    it('renders nothing', () => {
      render(
        <NetworkNamedByShell>
          <NetworkModeBanner />
        </NetworkNamedByShell>
      );

      expect(screen.queryByTestId('network-mode-banner')).not.toBeInTheDocument();
    });

    it('still renders outside that shell, so every other consumer is unaffected', () => {
      render(<NetworkModeBanner />);

      expect(screen.getByTestId('network-mode-banner')).toBeInTheDocument();
    });
  });
});
