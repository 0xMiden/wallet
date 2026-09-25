import React from 'react';

import { fireEvent, render, screen } from '@testing-library/react';

import { EvmBridgeDepositReview, EvmBridgeDepositReviewProps } from './EvmBridgeDepositReview';

/**
 * Deleting `ReviewAmount.test.tsx` (its behaviour absorbed into `Hero` + a `Pill` caption)
 * removed coverage of what this screen actually ships: the fiat subtitle, the You Receive
 * loading/label swap and the route label. This suite covers those, plus the CTA wiring the
 * shared `ReviewLayout` provides.
 */

// This screen renders through ReviewLayout, which hides the tab bar - and the network ribbon
// lives in the tab bar's footer, so it showed no network at all. The banner is ReviewLayout's.
// Its sheet and the endpoint lookup are tested in their own suites; stubbing only those keeps the
// banner itself real, so the assertion below is not on a stub.
jest.mock('lib/miden-chain/effective-endpoints', () => ({
  ...jest.requireActual('lib/miden-chain/effective-endpoints'),
  getTestNetworkNameKey: () => 'testnet'
}));
jest.mock('components/NetworkModeSheet', () => ({ NetworkModeSheet: () => null }));

jest.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, opts?: { value?: string }) => (opts && opts.value !== undefined ? `${key}|${opts.value}` : key)
  })
}));

jest.mock('lib/mobile/useHideNavbarWhileOpen', () => ({
  useHideNavbarWhileOpen: jest.fn()
}));

jest.mock('components/Button', () => {
  const R = require('react');
  return {
    __esModule: true,
    ButtonVariant: { Primary: 'primary', Secondary: 'secondary' },
    Button: ({ title, onClick, disabled, isLoading, 'data-testid': dataTestId }: any) =>
      R.createElement(
        'button',
        { type: 'button', onClick, disabled, 'data-loading': String(!!isLoading), 'data-testid': dataTestId },
        title
      )
  };
});

jest.mock('components/TokenLogo', () => {
  const R = require('react');
  return {
    TokenLogo: ({ symbol, size }: any) =>
      R.createElement('div', { 'data-testid': 'token-logo', 'data-symbol': symbol, 'data-size': size })
  };
});

const baseProps = (overrides: Partial<EvmBridgeDepositReviewProps> = {}): EvmBridgeDepositReviewProps => ({
  amount: '10',
  symbol: 'USDC',
  route: 'epoch',
  networkName: 'Sepolia',
  onConfirm: jest.fn(),
  onBack: jest.fn(),
  ...overrides
});

describe('EvmBridgeDepositReview', () => {
  describe('hero', () => {
    it('renders the deposit caption, logo and amount', () => {
      render(<EvmBridgeDepositReview {...baseProps({ amount: '10', symbol: 'USDC' })} />);

      expect(screen.getByText('youAreDepositing')).toBeInTheDocument();
      expect(screen.getByTestId('token-logo')).toHaveAttribute('data-symbol', 'USDC');
      // Rendered twice by design: once as the Hero value, once as the Amount detail row.
      expect(screen.getAllByText('10 USDC')).toHaveLength(2);
    });

    it('shows the ≈USD subtitle when fiat is provided', () => {
      render(<EvmBridgeDepositReview {...baseProps({ fiat: 100.5 })} />);
      expect(screen.getByText('approxFiatValue|$100.50')).toBeInTheDocument();
    });

    it('shows the ≈USD subtitle when fiat is exactly 0 (0 !== undefined)', () => {
      render(<EvmBridgeDepositReview {...baseProps({ fiat: 0 })} />);
      expect(screen.getByText('approxFiatValue|$0.00')).toBeInTheDocument();
    });

    it('omits the subtitle when fiat is undefined (e.g. testnet ETH with no reliable price)', () => {
      render(<EvmBridgeDepositReview {...baseProps({ fiat: undefined })} />);
      expect(screen.queryByText(/approxFiatValue/)).not.toBeInTheDocument();
    });
  });

  describe('route label', () => {
    it('labels the Epoch route "fast" with its arrival estimate', () => {
      render(<EvmBridgeDepositReview {...baseProps({ route: 'epoch' })} />);
      expect(screen.getByText('fast fastArrival')).toBeInTheDocument();
    });

    it('labels the Agglayer route "slow" with its arrival estimate', () => {
      render(<EvmBridgeDepositReview {...baseProps({ route: 'agglayer' })} />);
      expect(screen.getByText('slow slowArrival')).toBeInTheDocument();
    });
  });

  describe('you receive row', () => {
    it('shows the skeleton while the Fast quote is loading', () => {
      const { container } = render(<EvmBridgeDepositReview {...baseProps({ youReceiveLoading: true })} />);
      expect(container.querySelector('[data-slot="skeleton"]')).toBeInTheDocument();
      expect(screen.queryByText(/≈/)).not.toBeInTheDocument();
    });

    it('shows the quoted "≈ {amount} {symbol}" label once an output amount is known', () => {
      render(<EvmBridgeDepositReview {...baseProps({ symbol: 'USDC', outputAmount: '9.98' })} />);
      expect(screen.getByText('≈ 9.98 USDC')).toBeInTheDocument();
    });

    it('falls back to the bare symbol when no output amount has been quoted yet', () => {
      const { container } = render(
        <EvmBridgeDepositReview {...baseProps({ symbol: 'USDC', outputAmount: undefined })} />
      );
      expect(container.querySelector('[data-slot="skeleton"]')).not.toBeInTheDocument();
      expect(screen.getAllByText('USDC').length).toBeGreaterThan(0);
      expect(screen.queryByText(/≈/)).not.toBeInTheDocument();
    });
  });

  describe('actions', () => {
    it('wires the primary CTA to onConfirm, keeping the confirm testid', () => {
      const props = baseProps();
      render(<EvmBridgeDepositReview {...props} canConfirm />);
      fireEvent.click(screen.getByTestId('bridge-deposit-review-confirm'));
      expect(props.onConfirm).toHaveBeenCalledTimes(1);
    });

    it('disables the primary CTA when canConfirm is false', () => {
      render(<EvmBridgeDepositReview {...baseProps()} canConfirm={false} />);
      expect(screen.getByTestId('bridge-deposit-review-confirm')).toBeDisabled();
    });

    it('wires the secondary CTA to onBack', () => {
      const props = baseProps();
      render(<EvmBridgeDepositReview {...props} />);
      fireEvent.click(screen.getByText('back'));
      expect(props.onBack).toHaveBeenCalledTimes(1);
    });

    it('shows the loading state on the confirm button while submitting', () => {
      render(<EvmBridgeDepositReview {...baseProps()} isSubmitting canConfirm />);
      expect(screen.getByTestId('bridge-deposit-review-confirm')).toHaveAttribute('data-loading', 'true');
    });

    it('uses a custom confirm label (e.g. Retry) when provided', () => {
      render(<EvmBridgeDepositReview {...baseProps({ confirmLabel: 'retry' })} />);
      expect(screen.getByTestId('bridge-deposit-review-confirm')).toHaveTextContent('retry');
    });
  });

  // This screen commits value, so it names the network. The registry test proves the element is
  // in the file; this proves it actually renders - which is the distinction a source match could
  // not make, and how a banner once shipped behind an early return.
  // The banner comes from the shared ReviewLayout, not from this component.
  it('names the network it will commit on', () => {
    render(<EvmBridgeDepositReview {...baseProps({ amount: '10', symbol: 'USDC' })} />);

    expect(screen.getByTestId('network-mode-banner')).toBeInTheDocument();
  });
});
