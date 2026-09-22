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

const openSheet = () => fireEvent.click(screen.getByTestId('network-mode-banner'));

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
