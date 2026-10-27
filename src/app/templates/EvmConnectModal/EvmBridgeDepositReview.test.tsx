import React from 'react';

import { act, fireEvent, render, screen } from '@testing-library/react';

import { arrivingTokenName, EvmBridgeDepositReview, EvmBridgeDepositReviewProps } from './EvmBridgeDepositReview';

/**
 * Deleting `ReviewAmount.test.tsx` (its behaviour absorbed into `Hero` + a `Pill` caption)
 * removed coverage of what this screen actually ships: the fiat subtitle, the You Receive
 * loading/label swap and the route label. This suite covers those, plus the CTA wiring the
 * shared `ReviewLayout` provides.
 */

// This screen renders through ReviewLayout, far from Home's network pill, so without the banner it
// would show no network at all. The banner is ReviewLayout's.
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
  it('matches the actual extension ID and the Slow ETH bridge action before opening the mobile wallet', () => {
    render(
      <EvmBridgeDepositReview
        {...baseProps({
          route: 'agglayer',
          symbol: 'ETH',
          nativeSource: true,
          extensionId: 'abcdefghijklmnopabcdefghijklmnop',
          promptAmount: '1.25',
          promptContract: '0x1111111111111111111111111111111111111111'
        })}
      />
    );

    expect(screen.getByText('abcdefghijklmnopabcdefghijklmnop')).toBeInTheDocument();
    expect(screen.getByText('bridgeWalletPromptIdentity')).toBeInTheDocument();
    expect(screen.getByText('bridgeWalletPromptAgglayerDeposit')).toBeInTheDocument();
    expect(screen.queryByText('bridgeWalletPromptAgglayerApprove')).not.toBeInTheDocument();
    expect(screen.getByText('0x1111111111111111111111111111111111111111')).toBeInTheDocument();
  });

  it('names the bounded approval and deposit for each token route', () => {
    const cases: Array<[EvmBridgeDepositReviewProps['route'], string, string]> = [
      ['epoch', 'bridgeWalletPromptEpochApprove', 'bridgeWalletPromptEpochDeposit'],
      ['agglayer', 'bridgeWalletPromptAgglayerApprove', 'bridgeWalletPromptAgglayerDeposit'],
      ['usdcx', 'bridgeWalletPromptUsdcxApprove', 'bridgeWalletPromptUsdcxDeposit']
    ];
    for (const [route, approval, deposit] of cases) {
      const { unmount } = render(
        <EvmBridgeDepositReview
          {...baseProps({
            route,
            promptAmount: '10',
            promptContract: '0x1111111111111111111111111111111111111111'
          })}
        />
      );
      expect(screen.getByText(approval)).toBeInTheDocument();
      expect(screen.getByText(deposit)).toBeInTheDocument();
      unmount();
    }
  });

  it('still names the approval for an ERC-20 whose symbol happens to be ETH', () => {
    render(<EvmBridgeDepositReview {...baseProps({ route: 'agglayer', symbol: 'ETH', nativeSource: false })} />);
    expect(screen.getByText('bridgeWalletPromptAgglayerApprove')).toBeInTheDocument();
  });

  it('names the Circle burn instead of an xReserve deposit when the source uses the executor', () => {
    render(<EvmBridgeDepositReview {...baseProps({ route: 'usdcx', usdcxExecutor: true })} />);
    expect(screen.getByText('bridgeWalletPromptExecutorApprove')).toBeInTheDocument();
    expect(screen.getByText('bridgeWalletPromptExecutorBurn')).toBeInTheDocument();
    expect(screen.queryByText('bridgeWalletPromptUsdcxDeposit')).not.toBeInTheDocument();
  });

  it('shows the quoted wallet calls instead of a Compact deposit when Fast reuses collateral', () => {
    render(
      <EvmBridgeDepositReview
        {...baseProps({
          epochResourceLockRequired: false,
          epochQuoteTransactions: [
            {
              chainId: 11155111,
              target: '0x1234567890123456789012345678901234567890',
              value: '1000000000000000',
              callData: '0x12345678abcdef'
            }
          ]
        })}
      />
    );

    expect(screen.queryByText('bridgeWalletPromptEpochApprove')).not.toBeInTheDocument();
    expect(screen.queryByText('bridgeWalletPromptEpochDeposit')).not.toBeInTheDocument();
    expect(screen.getByText('bridgeWalletPromptEpochExistingCollateral')).toBeInTheDocument();
    expect(screen.getByText('0x1234567890123456789012345678901234567890')).toBeInTheDocument();
    expect(screen.getByText('0x12345678')).toBeInTheDocument();
    expect(screen.getByText('1000000000000000')).toBeInTheDocument();
  });

  it('does not imply a wallet prompt when the Fast quote has no execution transactions', () => {
    render(<EvmBridgeDepositReview {...baseProps({ epochResourceLockRequired: false, epochQuoteTransactions: [] })} />);

    expect(screen.getByText('bridgeWalletPromptEpochNoTransactions')).toBeInTheDocument();
    expect(screen.queryByText('bridgeWalletPromptEpochApprove')).not.toBeInTheDocument();
    expect(screen.queryByText('bridgeWalletPromptEpochDeposit')).not.toBeInTheDocument();
  });

  describe('hero', () => {
    it('renders the deposit caption, logo and amount', () => {
      render(<EvmBridgeDepositReview {...baseProps({ amount: '10', symbol: 'USDC' })} />);

      expect(screen.getByText('youAreDepositing')).toBeInTheDocument();
      expect(screen.getByTestId('token-logo')).toHaveAttribute('data-symbol', 'USDC');
      // Rendered twice by design: once as the Hero value, once as the Amount detail row.
      expect(screen.getAllByText('10 USDC')).toHaveLength(2);
    });

    it('shows the source quote estimate instead of trusting a supplied fiat total', () => {
      render(
        <EvmBridgeDepositReview
          {...baseProps({
            fiat: 100.5,
            sourceQuote: { price: 10.05, change24h: 0, percentageChange24h: 0, observedAt: Date.now() }
          })}
        />
      );
      expect(screen.getByText('approxFiatValue|$100.50')).toBeInTheDocument();
    });

    it('omits an unverified fiat total even when exactly zero', () => {
      render(<EvmBridgeDepositReview {...baseProps({ fiat: 0 })} />);
      expect(screen.queryByText('approxFiatValue|$0.00')).not.toBeInTheDocument();
    });

    it('omits the subtitle when fiat is undefined (e.g. testnet ETH with no reliable price)', () => {
      render(<EvmBridgeDepositReview {...baseProps({ fiat: undefined })} />);
      expect(screen.queryByText(/approxFiatValue/)).not.toBeInTheDocument();
    });
  });

  it('names the token by its label in the hero, the amount row and "you receive", keeping the logo on its symbol', () => {
    render(
      <EvmBridgeDepositReview
        {...baseProps({ amount: '10', symbol: 'USDC', label: 'Test Epoch USDC', outputAmount: '9.5' })}
      />
    );

    expect(screen.getByTestId('token-logo')).toHaveAttribute('data-symbol', 'USDC');
    expect(screen.getAllByText('10 Test Epoch USDC')).toHaveLength(2);
    expect(screen.getByText('≈ 9.5 Test Epoch USDC')).toBeInTheDocument();
  });

  it('names the received token by its symbol on the Slow route, which does not mint the labelled faucet', () => {
    render(
      <EvmBridgeDepositReview
        {...baseProps({ route: 'agglayer', symbol: 'USDC', label: 'Test Epoch USDC', outputAmount: '12.5' })}
      />
    );

    expect(screen.getByText('≈ 12.5 USDC')).toBeInTheDocument();
    expect(screen.getAllByText('10 Test Epoch USDC')).toHaveLength(2);
  });

  it('keeps the label in "you receive" on the Fast route', () => {
    render(
      <EvmBridgeDepositReview
        {...baseProps({ route: 'epoch', symbol: 'USDC', label: 'Test Epoch USDC', outputAmount: '12.5' })}
      />
    );

    expect(screen.getByText('≈ 12.5 Test Epoch USDC')).toBeInTheDocument();
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

    it('labels the Circle xReserve route "USDCx" with its arrival estimate', () => {
      render(<EvmBridgeDepositReview {...baseProps({ route: 'usdcx' })} />);
      expect(screen.getByText('usdcxRouteName usdcxArrival')).toBeInTheDocument();
    });

    it('reads about a minute for a USDCx deposit from Arc Testnet', () => {
      render(<EvmBridgeDepositReview {...baseProps({ route: 'usdcx', sourceChainId: 5042002 })} />);
      expect(screen.getByText('usdcxRouteName usdcxArrivalArc')).toBeInTheDocument();
    });

    it.each([11155111, 84532, 421614])('reads ~2 min for a USDCx deposit from chain %i', sourceChainId => {
      render(<EvmBridgeDepositReview {...baseProps({ route: 'usdcx', sourceChainId })} />);
      expect(screen.getByText('usdcxRouteName usdcxArrival')).toBeInTheDocument();
    });

    it('keeps the Fast estimate whatever the source chain', () => {
      render(<EvmBridgeDepositReview {...baseProps({ route: 'epoch', sourceChainId: 5042002 })} />);
      expect(screen.getByText('fast fastArrival')).toBeInTheDocument();
    });
  });

  describe('Circle fee row', () => {
    it('shows the quoted fee in the source token for an executor-route deposit', () => {
      render(<EvmBridgeDepositReview {...baseProps({ symbol: 'USDC', route: 'usdcx', fee: '0.0134' })} />);
      expect(screen.getByText('usdcxCircleFee')).toBeInTheDocument();
      expect(screen.getByText('0.0134 USDC')).toBeInTheDocument();
    });

    it('draws no fee row when there is no quote', () => {
      render(<EvmBridgeDepositReview {...baseProps({ symbol: 'USDC', route: 'usdcx' })} />);
      expect(screen.queryByText('usdcxCircleFee')).not.toBeInTheDocument();
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

    // A USDC deposit through xReserve arrives as USDCx: the hero keeps the source
    // symbol and only the You Receive row shows the Miden-side one.
    it('shows the output symbol on the You Receive row when it differs from the source', () => {
      render(<EvmBridgeDepositReview {...baseProps({ symbol: 'USDC', outputAmount: '10', route: 'usdcx' })} />);
      expect(screen.getByText('≈ 10 USDCx')).toBeInTheDocument();
      expect(screen.getAllByText('10 USDC')).toHaveLength(2);
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

describe('arrivingTokenName', () => {
  // Only the Epoch route mints the bridge's Miden faucet the label names; Slow delivers the plain symbol.
  it('names the plain symbol on the Slow route and the label on Fast', () => {
    expect(arrivingTokenName('agglayer', 'USDC', 'Test Epoch USDC')).toBe('USDC');
    expect(arrivingTokenName('epoch', 'USDC', 'Test Epoch USDC')).toBe('Test Epoch USDC');
  });
});

const mockReportUserVisibleError = jest.fn();
jest.mock('lib/telemetry/user-visible-error', () => ({
  ...jest.requireActual('lib/telemetry/user-visible-error'),
  reportUserVisibleError: (...args: unknown[]) => mockReportUserVisibleError(...args)
}));

const expectErrorAfterDwell = async (id: string, surface: string) => {
  await act(async () => {
    jest.advanceTimersByTime(999);
  });
  expect(mockReportUserVisibleError.mock.calls).toEqual([]);
  await act(async () => {
    jest.advanceTimersByTime(1);
  });
  expect(mockReportUserVisibleError.mock.calls).toEqual([[id, surface]]);
  await act(async () => {
    jest.advanceTimersByTime(1000);
  });
  expect(mockReportUserVisibleError.mock.calls).toEqual([[id, surface]]);
};

describe('user-visible bridge review errors', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    jest.useFakeTimers();
  });
  afterEach(() => {
    jest.useRealTimers();
  });

  it('reports raw submit text through the real review surface once', async () => {
    render(<EvmBridgeDepositReview {...baseProps({ error: 'private submit 42 https://synthetic.invalid/0xabc' })} />);
    expect(screen.getByText('private submit 42 https://synthetic.invalid/0xabc')).toBeInTheDocument();
    await expectErrorAfterDwell('raw_bridge_deposit_submit_failed', 'review');
  });

  it('keeps quoting and submitting progress quiet without an error', async () => {
    const view = render(<EvmBridgeDepositReview {...baseProps({ youReceiveLoading: true })} />);
    await act(async () => {
      jest.advanceTimersByTime(2000);
    });
    view.rerender(<EvmBridgeDepositReview {...baseProps({ isSubmitting: true })} />);
    await act(async () => {
      jest.advanceTimersByTime(2000);
    });
    expect(mockReportUserVisibleError.mock.calls).toEqual([]);
  });

  it.each(['clear', 'unmount'])('cancels a review failure on %s before dwell', async action => {
    const view = render(<EvmBridgeDepositReview {...baseProps({ error: 'private review failure' })} />);
    await act(async () => {
      jest.advanceTimersByTime(999);
    });
    if (action === 'clear') view.rerender(<EvmBridgeDepositReview {...baseProps()} />);
    else view.unmount();
    await act(async () => {
      jest.advanceTimersByTime(2000);
    });
    expect(screen.queryByText('private review failure')).not.toBeInTheDocument();
    expect(mockReportUserVisibleError.mock.calls).toEqual([]);
  });
});
