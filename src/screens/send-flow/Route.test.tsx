import React from 'react';

import { act, fireEvent, render, screen, within } from '@testing-library/react';
import fs from 'fs';
import path from 'path';

import { stepFooterCushionClass } from 'components/flow/footer-cushion';
import { useSlideOnReflow } from 'components/flow/useSlideOnReflow';
import { resolveDisplayMetadata } from 'lib/miden/metadata/resolve';
import type { NearIntentsSendPair } from 'lib/one-click/send';
import type { OneClickQuoteResponse } from 'lib/one-click/types';
import type { FeatureAvailability } from 'lib/remote-config/availability';
import { reportUserVisibleError } from 'lib/telemetry/user-visible-error';

import { formatNearIntentsAmount, nearIntentsArrivalText, nearIntentsFeeUsd } from './near-intents-format';
import { NearIntentsRouteCard, NearIntentsRouteCardProps, Route, RouteOptions, RouteOptionsProps } from './Route';
import { AgglayerEligibility } from './useAgglayerEligibility';
import type { NearIntentsSendQuote, NearIntentsSendQuoteErrorCode } from './useNearIntentsSendQuote';

jest.mock('lib/remote-config/runtime', () =>
  jest
    .requireActual<typeof import('lib/epoch/testing/bridge-config')>('lib/epoch/testing/bridge-config')
    .remoteConfigRuntimeMock(
      () =>
        jest.requireActual<typeof import('lib/epoch/testing/bridge-config')>('lib/epoch/testing/bridge-config')
          .TEST_BRIDGE_CONFIG_SNAPSHOT
    )
);

jest.mock('react-i18next', () => ({
  useTranslation: () => ({
    // A fee label names its asset and a payout row its amount; every other key reads as itself.
    t: (key: string, params?: { symbol?: string; amount?: string }) => {
      const value =
        params?.amount !== undefined && params.symbol !== undefined
          ? `${params.amount} ${params.symbol}`
          : (params?.symbol ?? params?.amount);
      return value === undefined ? key : `${key}|${value}`;
    }
  })
}));
jest.mock('lib/mobile/haptics', () => ({ hapticLight: jest.fn(), hapticSelection: jest.fn() }));
// The USDCx card names the native fee asset as the wallet resolves it; on testnet that is USDCx.
jest.mock('app/hooks/useNativeFeeFaucetId', () => ({ __esModule: true, default: () => 'mtst1usdcxnative' }));
jest.mock('lib/store', () => ({
  useWalletStore: (
    selector: (state: { assetsMetadata: Record<string, never>; tokenPrices: Record<string, never> }) => unknown
  ) => selector({ assetsMetadata: {}, tokenPrices: {} })
}));
jest.mock('lib/miden/metadata/resolve', () => ({
  resolveDisplayMetadata: jest.fn(() => ({ symbol: 'USDCx', name: 'USDCx', decimals: 6 }))
}));
jest.mock('lib/platform', () => ({ isMobile: () => true }));
jest.mock('components/flow/useSlideOnReflow', () => ({ useSlideOnReflow: jest.fn() }));
jest.mock('lib/telemetry/user-visible-error', () => ({
  ...jest.requireActual('lib/telemetry/user-visible-error'),
  reportUserVisibleError: jest.fn()
}));

const AVAILABLE: FeatureAvailability = { state: 'available' };
const DOWN: FeatureAvailability = {
  state: 'unavailable',
  reason: 'service-down',
  detail: 'allocator /health: timeout'
};
const UP = { fastAvailability: AVAILABLE, slowAvailability: AVAILABLE };

describe('Route', () => {
  it('names the disabled Epoch route while Agglayer Continue remains usable', () => {
    const onConfirm = jest.fn();
    render(
      <Route
        route="agglayer"
        onRouteChange={jest.fn()}
        fastQuoteLoading={false}
        fastAvailability={DOWN}
        slowAvailability={AVAILABLE}
        onConfirm={onConfirm}
      />
    );
    expect(screen.getByTestId('bridge-route-fast')).toHaveTextContent('bridgeRouteEpoch');
    expect(screen.getByTestId('bridge-route-slow')).toHaveTextContent('bridgeRouteAgglayer');

    expect(screen.getByTestId('feature-unavailable-notice-fast')).toHaveTextContent('bridgeRouteUnavailableBody');
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    const continueButton = screen.getByTestId('bridge-route-confirm');
    expect(continueButton).toHaveTextContent('bridgeContinueAgglayer');
    expect(continueButton).toBeEnabled();
    fireEvent.click(continueButton);
    expect(onConfirm).toHaveBeenCalledTimes(1);
  });

  it('pins its CTA in a flow footer that slides and snaps its cushion, like every flow page', () => {
    render(<Route route="epoch" onRouteChange={jest.fn()} fastQuoteLoading={false} {...UP} onConfirm={jest.fn()} />);

    const footer = screen.getByTestId('bridge-route-confirm').parentElement!;
    expect(footer).toHaveAttribute('data-navbar-cushion', 'true');
    expect(footer).toHaveAttribute('data-flow-footer');
    expect(useSlideOnReflow).toHaveBeenCalledWith(expect.objectContaining({ current: footer }));
  });

  // #1109: the CTA's bottom padding is the shared cushion, never a literal of its own, so it follows the tab bar
  // (and drops to 1rem on the slide page this step lives on) instead of pinning a fixed 6rem.
  it('pins its CTA on the shared cushion', () => {
    render(<Route route="epoch" onRouteChange={jest.fn()} fastQuoteLoading={false} {...UP} onConfirm={jest.fn()} />);

    const footer = screen.getByTestId('bridge-route-confirm').parentElement!;
    expect(footer).toHaveClass(stepFooterCushionClass());
    expect(footer.className).not.toContain('pb-24');
  });

  it('leaves Slow and Confirm enabled for an EVM deposit, which has no Miden faucet (#1276)', () => {
    const onConfirm = jest.fn();
    render(<Route route="agglayer" onRouteChange={jest.fn()} fastQuoteLoading={false} {...UP} onConfirm={onConfirm} />);
    expect(screen.getByTestId('bridge-route-slow')).toBeEnabled();
    expect(screen.queryByRole('status')).not.toBeInTheDocument();
    fireEvent.click(screen.getByTestId('bridge-route-confirm'));
    expect(onConfirm).toHaveBeenCalledTimes(1);
  });
});

describe('RouteOptions', () => {
  it.each<AgglayerEligibility>(['loading', 'unsupported', 'error'])(
    'blocks Slow while %s and keeps Fast available',
    status => {
      const onRouteChange = jest.fn();
      render(
        <RouteOptions
          route="agglayer"
          onRouteChange={onRouteChange}
          fastQuoteLoading={false}
          slowStatus={status}
          {...UP}
        />
      );
      expect(screen.getByTestId('bridge-route-slow')).toBeDisabled();
      fireEvent.click(screen.getByTestId('bridge-route-slow'));
      expect(onRouteChange).not.toHaveBeenCalled();
      fireEvent.click(screen.getByTestId('bridge-route-fast'));
      expect(onRouteChange).toHaveBeenCalledWith('epoch');
      expect(screen.getByRole('status')).toBeInTheDocument();
      expect(screen.getByTestId('bridge-route-slow')).toHaveAttribute('aria-busy', String(status === 'loading'));
    }
  );

  it.each(['off', 'not-configured', 'not-deployed', 'service-down', 'pending'] as const)(
    'describes %s as route availability without claiming a service outage',
    reason => {
      render(
        <RouteOptions
          route="agglayer"
          onRouteChange={jest.fn()}
          fastQuoteLoading={false}
          slowStatus="allowed"
          fastAvailability={{ state: 'unavailable', reason, detail: 'private diagnostics' }}
          slowAvailability={AVAILABLE}
        />
      );
      const notice = screen.getByTestId('feature-unavailable-notice-fast');
      expect(notice).toHaveTextContent('bridgeRouteUnavailableBody');
      expect(notice).not.toHaveTextContent('bridgeFeatureUnavailableBody');
      expect(notice).not.toHaveTextContent('private diagnostics');
      expect(notice).toHaveAttribute('data-tone', 'neutral');
    }
  );

  it('preserves the restricted-region explanation', () => {
    render(
      <RouteOptions
        route="agglayer"
        onRouteChange={jest.fn()}
        fastQuoteLoading={false}
        slowStatus="allowed"
        fastAvailability={{ state: 'unavailable', reason: 'restricted', detail: 'fixture' }}
        slowAvailability={AVAILABLE}
      />
    );
    expect(screen.getByTestId('feature-unavailable-notice-fast')).toHaveTextContent('geoRestrictedBody');
  });

  it.each(['epoch', 'agglayer'] as const)('keeps the selected %s route hint with its card', route => {
    render(
      <RouteOptions
        route={route}
        onRouteChange={jest.fn()}
        fastQuoteLoading={false}
        slowStatus="allowed"
        notice="fixture hint"
        {...UP}
      />
    );
    const card = screen.getByTestId(route === 'epoch' ? 'bridge-route-fast' : 'bridge-route-slow');
    expect(card.parentElement).toContainElement(screen.getByText('fixture hint'));
  });

  it.each<AgglayerEligibility>(['loading', 'unsupported', 'error'])(
    'contains the Agglayer %s explanation within its card',
    slowStatus => {
      render(
        <RouteOptions
          route="epoch"
          onRouteChange={jest.fn()}
          fastQuoteLoading={false}
          slowStatus={slowStatus}
          {...UP}
        />
      );
      expect(screen.getByTestId('bridge-route-slow-card')).toContainElement(screen.getByRole('status'));
      expect(screen.getByTestId('bridge-route-slow')).toHaveAttribute('aria-describedby', 'bridge-route-slow-status');
    }
  );

  it('contains USDCx burn help within its card', () => {
    render(
      <RouteOptions
        usdcxAvailable
        route="usdcx"
        onRouteChange={jest.fn()}
        fastQuoteLoading={false}
        slowStatus="allowed"
        {...UP}
      />
    );
    expect(screen.getByTestId('bridge-route-usdcx-card')).toContainElement(screen.getByTestId('usdcx-burn-notice'));
  });

  it('enables Slow after approval', () => {
    render(
      <RouteOptions route="agglayer" onRouteChange={jest.fn()} fastQuoteLoading={false} slowStatus="allowed" {...UP} />
    );
    expect(screen.getByTestId('bridge-route-slow')).toBeEnabled();
    expect(screen.queryByRole('status')).not.toBeInTheDocument();
    expect(screen.queryByTestId('feature-unavailable-notice-fast')).not.toBeInTheDocument();
    expect(screen.queryByTestId('feature-unavailable-notice-slow')).not.toBeInTheDocument();
  });

  it('contains the Epoch explanation inside its visible card boundary', () => {
    render(
      <RouteOptions
        route="agglayer"
        onRouteChange={jest.fn()}
        fastQuoteLoading={false}
        slowStatus="allowed"
        fastAvailability={DOWN}
        slowAvailability={AVAILABLE}
      />
    );
    const card = screen.getByTestId('bridge-route-fast-card');
    expect(card).toContainElement(screen.getByTestId('feature-unavailable-notice-fast'));
    expect(card).toHaveClass('border');
    expect(card).not.toHaveClass('disabled:opacity-50');
    expect(screen.getByTestId('bridge-route-fast')).toBeDisabled();
  });

  it('greys out an unavailable Fast route under its own notice, and takes no tap', () => {
    const onRouteChange = jest.fn();
    render(
      <RouteOptions
        route="agglayer"
        onRouteChange={onRouteChange}
        fastQuoteLoading={false}
        slowStatus="allowed"
        fastAvailability={DOWN}
        slowAvailability={AVAILABLE}
      />
    );
    const fast = screen.getByTestId('bridge-route-fast');
    expect(fast).toBeDisabled();
    expect(fast).toHaveClass('disabled:opacity-50');
    fireEvent.click(fast);
    expect(onRouteChange).not.toHaveBeenCalled();
    expect(screen.getByTestId('bridge-route-slow')).toBeEnabled();
    const notice = screen.getByTestId('feature-unavailable-notice-fast');
    expect(notice).toHaveTextContent('bridgeRouteUnavailableBody');
    expect(fast).toHaveAttribute('aria-describedby', notice.id);
    expect(fast.parentElement).toContainElement(notice);
  });

  it('greys out Slow while its feature is unavailable, even with the token allowed', () => {
    render(
      <RouteOptions
        route="epoch"
        onRouteChange={jest.fn()}
        fastQuoteLoading={false}
        slowStatus="allowed"
        fastAvailability={AVAILABLE}
        slowAvailability={DOWN}
      />
    );
    const slow = screen.getByTestId('bridge-route-slow');
    const fast = screen.getByTestId('bridge-route-fast');
    expect(slow).toBeDisabled();
    expect(fast).toBeEnabled();
    const notice = screen.getByTestId('feature-unavailable-notice-slow');
    expect(slow).toHaveAttribute('aria-describedby', notice.id);
    expect(slow.parentElement).toContainElement(notice);
    expect(fast).not.toHaveAttribute('aria-describedby');
  });

  // #1428: a working Slow route must not read as unavailable because Fast is down.
  it('shows only the Fast notice, tied to the Fast card, when only Fast is down', () => {
    render(
      <RouteOptions
        route="agglayer"
        onRouteChange={jest.fn()}
        fastQuoteLoading={false}
        slowStatus="allowed"
        fastAvailability={DOWN}
        slowAvailability={AVAILABLE}
      />
    );
    expect(screen.getAllByText('bridgeRouteUnavailableBody')).toHaveLength(1);
    expect(screen.queryByTestId('feature-unavailable-notice-slow')).not.toBeInTheDocument();
    const notice = screen.getByTestId('feature-unavailable-notice-fast');
    expect(screen.getByTestId('bridge-route-fast')).toHaveAttribute('aria-describedby', notice.id);
    expect(screen.getByTestId('bridge-route-slow')).not.toHaveAttribute('aria-describedby');
    expect(screen.getByTestId('bridge-route-slow').parentElement).not.toContainElement(notice);
  });

  it('shows two notices, one under each card, when both routes are down', () => {
    render(
      <RouteOptions
        route="epoch"
        onRouteChange={jest.fn()}
        fastQuoteLoading={false}
        slowStatus="allowed"
        fastAvailability={DOWN}
        slowAvailability={DOWN}
      />
    );
    expect(screen.queryByText('bridgeRouteUnavailableBody')).not.toBeInTheDocument();
    expect(screen.getAllByText('bridgeRouteNoneAvailableBody')).toHaveLength(2);
    const fastNotice = screen.getByTestId('feature-unavailable-notice-fast');
    const slowNotice = screen.getByTestId('feature-unavailable-notice-slow');
    expect(fastNotice.id).not.toBe(slowNotice.id);
    expect(screen.getByTestId('bridge-route-fast')).toHaveAttribute('aria-describedby', fastNotice.id);
    expect(screen.getByTestId('bridge-route-slow')).toHaveAttribute('aria-describedby', slowNotice.id);
  });

  // The Fast notice may point at another route only when the Slow card can be chosen now.
  it.each<[string, React.ComponentProps<typeof RouteOptions>['slowStatus'], FeatureAvailability]>([
    ['refused by its token check', 'unsupported', AVAILABLE],
    ['still loading its availability', 'allowed', { state: 'loading' }]
  ])('says no route is available when Fast is down and Slow is %s', (_case, slowStatus, slowAvailability) => {
    render(
      <RouteOptions
        route="epoch"
        onRouteChange={jest.fn()}
        fastQuoteLoading={false}
        slowStatus={slowStatus}
        fastAvailability={DOWN}
        slowAvailability={slowAvailability}
      />
    );
    expect(screen.getByTestId('bridge-route-slow')).toBeDisabled();
    const notice = screen.getByTestId('feature-unavailable-notice-fast');
    expect(notice).toHaveTextContent('bridgeRouteNoneAvailableBody');
    expect(notice).not.toHaveTextContent('bridgeRouteUnavailableBody');
  });

  it('holds both routes while availability is still loading, with no notice', () => {
    const loading: FeatureAvailability = { state: 'loading' };
    render(
      <RouteOptions
        route="epoch"
        onRouteChange={jest.fn()}
        fastQuoteLoading={false}
        slowStatus="allowed"
        fastAvailability={loading}
        slowAvailability={loading}
      />
    );
    expect(screen.getByTestId('bridge-route-fast')).toBeDisabled();
    expect(screen.getByTestId('bridge-route-slow')).toBeDisabled();
    expect(screen.queryByTestId('feature-unavailable-notice-fast')).not.toBeInTheDocument();
    expect(screen.queryByTestId('feature-unavailable-notice-slow')).not.toBeInTheDocument();
  });

  it('names the native fee asset under the USDCx route, never MIDEN', () => {
    render(
      <RouteOptions
        usdcxAvailable
        route="usdcx"
        onRouteChange={jest.fn()}
        fastQuoteLoading={false}
        slowStatus="allowed"
        {...UP}
      />
    );

    expect(screen.getByTestId('bridge-route-usdcx')).toHaveTextContent('usdcxMidenFees|USDCx');
    expect(resolveDisplayMetadata).toHaveBeenCalledWith('mtst1usdcxnative', {}, 'mtst1usdcxnative');
  });

  it('marks the withdrawal notice under the USDCx route for the e2e harness', () => {
    render(
      <RouteOptions
        usdcxAvailable
        route="usdcx"
        onRouteChange={jest.fn()}
        fastQuoteLoading={false}
        slowStatus="allowed"
        {...UP}
      />
    );

    expect(screen.getByTestId('usdcx-burn-notice')).toHaveTextContent('usdcxWithdrawalNotice');
  });

  // Circle took 2.5635 USDC from a Sepolia payout, so no fee bound or payout is promised on any chain.
  it.each([
    [11155111, 10_000_000n],
    [5042002, 1_000_001n],
    [11155111, 1_500_000n]
  ])('shows Circle fee as varying and no payout for a burn to chain %i', (chainId, amount) => {
    render(
      <RouteOptions
        usdcxAvailable
        route="usdcx"
        onRouteChange={jest.fn()}
        fastQuoteLoading={false}
        slowStatus="allowed"
        usdcxPayout={{ chainId, amount }}
        {...UP}
      />
    );

    const feeRow = within(screen.getByTestId('usdcx-payout-fee'));
    expect(feeRow.getByText('usdcxCircleFee')).toBeInTheDocument();
    expect(feeRow.getByText('usdcxPayoutFeeVaries')).toBeInTheDocument();
    expect(screen.queryByTestId('usdcx-payout-net')).not.toBeInTheDocument();
    expect(screen.queryByText('youReceive')).not.toBeInTheDocument();
  });

  it.each([
    ['before the send has a destination and an amount', undefined],
    ['for a chain that is not a USDCx destination', { chainId: 999, amount: 10_000_000n }]
  ])('shows no payout figures %s', (_case, usdcxPayout) => {
    render(
      <RouteOptions
        usdcxAvailable
        route="usdcx"
        onRouteChange={jest.fn()}
        fastQuoteLoading={false}
        slowStatus="allowed"
        usdcxPayout={usdcxPayout}
        {...UP}
      />
    );

    expect(screen.queryByTestId('usdcx-payout-fee')).not.toBeInTheDocument();
    expect(screen.queryByTestId('usdcx-payout-net')).not.toBeInTheDocument();
  });
});

describe('route availability report', () => {
  it('carries a known incoming route through the neutral notice without changing the dwell', () => {
    jest.useFakeTimers();
    jest.mocked(reportUserVisibleError).mockClear();
    render(
      <RouteOptions
        route="agglayer"
        onRouteChange={jest.fn()}
        fastQuoteLoading={false}
        slowStatus="allowed"
        {...{ fastFeature: 'fastBridgeIn' as const }}
        fastAvailability={DOWN}
        slowAvailability={AVAILABLE}
      />
    );
    act(() => jest.advanceTimersByTime(999));
    expect(reportUserVisibleError).not.toHaveBeenCalled();
    act(() => jest.advanceTimersByTime(1));
    expect(reportUserVisibleError).toHaveBeenCalledWith('bridgeFeatureUnavailableBody', 'notice', {
      kind: 'feature_unavailable',
      featureUnavailableFeature: 'fastBridgeIn',
      featureUnavailableReason: 'service-down'
    });
  });

  const mockReport = jest.mocked(reportUserVisibleError);
  beforeEach(() => {
    jest.useFakeTimers();
    mockReport.mockClear();
  });
  afterEach(() => jest.useRealTimers());

  it('reports the unavailable-feature event for a route down for a non-geographic reason', () => {
    render(
      <RouteOptions
        route="agglayer"
        onRouteChange={jest.fn()}
        fastQuoteLoading={false}
        slowStatus="allowed"
        fastAvailability={DOWN}
        slowAvailability={AVAILABLE}
      />
    );
    act(() => jest.advanceTimersByTime(1000));
    expect(mockReport.mock.calls).toEqual([
      [
        'bridgeFeatureUnavailableBody',
        'notice',
        { kind: 'feature_unavailable', featureUnavailableFeature: 'unknown', featureUnavailableReason: 'service-down' }
      ]
    ]);
  });

  it('reports nothing for a route held while the startup decision is pending', () => {
    render(
      <RouteOptions
        route="agglayer"
        onRouteChange={jest.fn()}
        fastQuoteLoading={false}
        slowStatus="allowed"
        fastAvailability={{ state: 'unavailable', reason: 'pending', detail: 'startup feature eligibility is pending' }}
        slowAvailability={AVAILABLE}
      />
    );
    expect(screen.getByTestId('feature-unavailable-notice-fast')).toHaveTextContent('bridgeRouteUnavailableBody');
    act(() => jest.advanceTimersByTime(5000));
    expect(mockReport).not.toHaveBeenCalled();
  });

  it('reports nothing while both routes are available', () => {
    render(
      <RouteOptions route="epoch" onRouteChange={jest.fn()} fastQuoteLoading={false} slowStatus="allowed" {...UP} />
    );
    act(() => jest.advanceTimersByTime(1000));
    expect(mockReport).not.toHaveBeenCalled();
  });
});

describe('NEAR Intents route card', () => {
  const PAIR: NearIntentsSendPair = {
    chain: { id: 'sol', name: 'Solana', addressKind: 'solana', tokens: [] },
    origin: { assetId: 'miden-usdc', blockchain: 'miden', symbol: 'USDC', decimals: 6, faucetId: '0xfaucet' },
    destination: { assetId: 'sol-usdc', blockchain: 'sol', symbol: 'USDC', decimals: 6 }
  };
  const quoteWith = (
    amountOut: string,
    timeEstimate: number,
    usd: { amountInUsd: string; amountOutUsd: string } = { amountInUsd: '20', amountOutUsd: '19.65' }
  ): OneClickQuoteResponse => ({
    correlationId: 'correlation',
    timestamp: '2026-11-11T00:00:00.000Z',
    signature: 'signature',
    quoteRequest: {
      dry: true,
      swapType: 'EXACT_INPUT',
      slippageTolerance: 100,
      originAsset: 'miden-usdc',
      depositType: 'ORIGIN_CHAIN',
      destinationAsset: 'sol-usdc',
      amount: '20000000',
      refundTo: 'mm1refund',
      refundType: 'ORIGIN_CHAIN',
      recipient: 'SoLaNa',
      recipientType: 'DESTINATION_CHAIN',
      deadline: '2026-11-11T00:05:00.000Z'
    },
    quote: {
      amountIn: '20000000',
      amountInFormatted: '20',
      amountInUsd: usd.amountInUsd,
      minAmountIn: '20000000',
      amountOut,
      amountOutFormatted: '19.65',
      amountOutUsd: usd.amountOutUsd,
      minAmountOut: '19400000',
      timeEstimate
    }
  });
  const renderCard = (quote: NearIntentsSendQuote, overrides: Partial<NearIntentsRouteCardProps> = {}) => {
    const props: NearIntentsRouteCardProps = {
      quote,
      selected: false,
      onSelect: jest.fn(),
      accent: 'send',
      ...overrides
    };
    render(<NearIntentsRouteCard {...props} />);
    return props;
  };

  it('shows the bridge fee and the arrival estimate, as the other cards do, and what the recipient gets under them', () => {
    const props = renderCard({ status: 'ready', pair: PAIR, quote: quoteWith('19650000', 32) });

    const card = screen.getByTestId('bridge-route-near-intents');
    expect(card).toHaveTextContent('bridgeRouteNearIntents');
    expect(card).toHaveTextContent('bridgeRouteFee');
    expect(card).toHaveTextContent('bridgeArrivalEstimate');
    expect(card).not.toHaveTextContent('youReceive');
    expect(screen.getByTestId('near-intents-route-fee')).toHaveTextContent('$0.35');
    expect(screen.getByTestId('near-intents-route-fee')).toHaveClass('text-base', 'font-bold', 'text-ink');
    expect(screen.getByTestId('near-intents-route-eta')).toHaveTextContent('nearIntentsSendArrivalSeconds');
    // The amount is a caption outside the two metrics, so a long value cannot run into the second column.
    const receives = screen.getByTestId('near-intents-route-receives');
    expect(receives).toHaveTextContent('nearIntentsSendYouReceive|19.65 USDC');
    expect(card).not.toContainElement(receives);
    expect(card).toBeEnabled();
    fireEvent.click(card);
    expect(props.onSelect).toHaveBeenCalledTimes(1);
  });

  it('rounds a long output amount on the receive line', () => {
    const ether: NearIntentsSendPair = {
      ...PAIR,
      destination: { assetId: 'eth', blockchain: 'eth', symbol: 'ETH', decimals: 18 }
    };
    renderCard({ status: 'ready', pair: ether, quote: quoteWith('962490256881558', 32) });

    expect(screen.getByTestId('near-intents-route-receives')).toHaveTextContent(
      'nearIntentsSendYouReceive|0.000962 ETH'
    );
  });

  it('never shows a negative fee', () => {
    renderCard({
      status: 'ready',
      pair: PAIR,
      quote: quoteWith('19650000', 32, { amountInUsd: '19', amountOutUsd: '19.65' })
    });

    expect(screen.getByTestId('near-intents-route-fee')).toHaveTextContent('$0.00');
  });

  it.each([
    ['an empty', { amountInUsd: '', amountOutUsd: '19.65' }],
    ['a text', { amountInUsd: '20', amountOutUsd: 'n/a' }]
  ])('shows the dash for the fee when 1Click gives %s USD value', (_case, usd) => {
    renderCard({ status: 'ready', pair: PAIR, quote: quoteWith('19650000', 32, usd) });

    expect(screen.getByTestId('near-intents-route-fee')).toHaveTextContent('—');
  });

  it('shows the dash for both metrics, and no receive line, when there is no quote', () => {
    renderCard({ status: 'unsupported' });

    expect(screen.getByTestId('near-intents-route-fee')).toHaveTextContent('—');
    expect(screen.getByTestId('near-intents-route-eta')).toHaveTextContent('—');
    expect(screen.queryByTestId('near-intents-route-receives')).not.toBeInTheDocument();
  });

  it('shows a skeleton in both metrics and takes a tap while the quote loads', () => {
    renderCard({ status: 'loading', pair: PAIR });

    const card = screen.getByTestId('bridge-route-near-intents');
    expect(card).toHaveAttribute('aria-busy', 'true');
    expect(card).toBeEnabled();
    expect(screen.queryByTestId('near-intents-route-fee')).not.toBeInTheDocument();
    expect(screen.queryByTestId('near-intents-route-eta')).not.toBeInTheDocument();
    expect(screen.queryByTestId('near-intents-route-receives')).not.toBeInTheDocument();
  });

  it('greys out the card and says why when NEAR Intents has no pair for the token', () => {
    jest.mocked(reportUserVisibleError).mockClear();
    renderCard({ status: 'unsupported' });

    expect(screen.getByTestId('bridge-route-near-intents')).toBeDisabled();
    expect(screen.getByTestId('near-intents-route-unsupported')).toHaveTextContent('nearIntentsSendUnsupported');
    expect(reportUserVisibleError).not.toHaveBeenCalled();
  });

  it.each<[NearIntentsSendQuoteErrorCode | undefined, string]>([
    ['no_liquidity', 'nearIntentsSendNoLiquidity'],
    ['invalid_recipient', 'nearIntentsSendInvalidRecipient'],
    [undefined, 'oneClickQuoteUnavailable']
  ])('greys out the card on the %s refusal and shows %s', (errorCode, message) => {
    renderCard({ status: 'error', pair: PAIR, errorCode });

    expect(screen.getByTestId('bridge-route-near-intents')).toBeDisabled();
    expect(screen.getByTestId('near-intents-route-error')).toHaveTextContent(message);
    expect(screen.getByTestId('bridge-route-near-intents')).toHaveAttribute(
      'aria-describedby',
      'bridge-route-near-intents-status'
    );
  });

  it.each([
    [false, false],
    [true, true]
  ])('shows the hint on a card selected %s: %s', (selected, shown) => {
    const quote: NearIntentsSendQuote = { status: 'ready', pair: PAIR, quote: quoteWith('19650000', 470) };
    renderCard(quote, { hint: 'balance-hint', selected });
    expect(screen.queryByText('balance-hint') !== null).toBe(shown);
  });

  it('keeps a long estimate in minutes', () => {
    renderCard({ status: 'ready', pair: PAIR, quote: quoteWith('19650000', 470) });

    expect(screen.getByTestId('near-intents-route-eta')).toHaveTextContent('nearIntentsSendArrivalMinutes');
  });

  describe('in RouteOptions', () => {
    const card = <div data-testid="near-intents-slot" />;
    const base: Pick<RouteOptionsProps, 'route' | 'onRouteChange' | 'fastQuoteLoading' | 'slowStatus'> = {
      route: 'epoch',
      onRouteChange: jest.fn(),
      fastQuoteLoading: false,
      slowStatus: 'allowed'
    };

    it('shows the bridge cards and the NEAR Intents card when both serve the network', () => {
      render(<RouteOptions {...base} {...UP} nearIntentsCard={card} />);

      expect(screen.getByTestId('bridge-route-fast')).toBeInTheDocument();
      expect(screen.getByTestId('bridge-route-slow')).toBeInTheDocument();
      expect(screen.getByTestId('near-intents-slot')).toBeInTheDocument();
    });

    it('shows the NEAR Intents card under the USDCx card', () => {
      render(<RouteOptions {...base} {...UP} route="usdcx" usdcxAvailable nearIntentsCard={card} />);

      expect(screen.getByTestId('bridge-route-usdcx')).toBeInTheDocument();
      expect(screen.getByTestId('near-intents-slot')).toBeInTheDocument();
      expect(screen.queryByTestId('bridge-route-fast')).not.toBeInTheDocument();
    });

    it('shows only the NEAR Intents card when no bridge route serves the network', () => {
      render(<RouteOptions {...base} {...UP} bridgeRoutesAvailable={false} nearIntentsCard={card} />);

      expect(screen.getByTestId('near-intents-slot')).toBeInTheDocument();
      expect(screen.queryByTestId('bridge-route-fast')).not.toBeInTheDocument();
      expect(screen.queryByTestId('bridge-route-slow')).not.toBeInTheDocument();
      expect(screen.queryByTestId('bridge-route-usdcx')).not.toBeInTheDocument();
    });
  });
});

describe('nearIntentsArrivalText', () => {
  const t = (key: string, values?: Record<string, string>) => `${key}:${values?.seconds ?? values?.minutes}`;

  it.each<[number, string]>([
    [32, 'nearIntentsSendArrivalSeconds:30'],
    [22, 'nearIntentsSendArrivalSeconds:20'],
    [2, 'nearIntentsSendArrivalSeconds:5'],
    [58, 'nearIntentsSendArrivalMinutes:1'],
    [470, 'nearIntentsSendArrivalMinutes:8'],
    [0, 'nearIntentsSendArrivalMinutes:1']
  ])('reads %s s as %s', (seconds, text) => {
    expect(nearIntentsArrivalText(t, seconds)).toBe(text);
  });
});

describe('formatNearIntentsAmount', () => {
  it.each<[string, number, string]>([
    ['962490256881558', 18, '0.000962'],
    ['19650000', 6, '19.65'],
    ['20000000', 6, '20'],
    ['1234567890', 6, '1234.56'],
    ['123456789', 6, '123.456'],
    ['500000', 6, '0.5'],
    ['1234', 18, '0.0000000000000012'],
    ['0', 6, '0']
  ])('shows %s at %s decimals as %s', (value, decimals, text) => {
    expect(formatNearIntentsAmount(value, decimals)).toBe(text);
  });

  it.each([['1.5'], ['-1'], [''], [undefined]])('gives nothing for %s', value => {
    expect(formatNearIntentsAmount(value, 6)).toBeUndefined();
  });
});

describe('nearIntentsFeeUsd', () => {
  it.each<[string, string, number]>([
    ['20', '19.65', 0.35],
    ['19', '19.65', 0]
  ])('reads %s in and %s out as %s', (amountInUsd, amountOutUsd, fee) => {
    expect(nearIntentsFeeUsd({ amountInUsd, amountOutUsd })).toBeCloseTo(fee);
  });

  it.each<[string, string]>([
    ['', '19.65'],
    ['20', 'NaN'],
    ['Infinity', '1']
  ])('gives no fee for %s in and %s out', (amountInUsd, amountOutUsd) => {
    expect(nearIntentsFeeUsd({ amountInUsd, amountOutUsd })).toBeUndefined();
  });
});

// The route cards and Continue name their provider; a translation that renames the brand, or reads "continue
// reading" or "on the website", tells the user something else.
describe('provider route labels', () => {
  const LOCALES_DIR = path.join(__dirname, '../../../public/_locales');
  const locales = fs
    .readdirSync(LOCALES_DIR)
    .filter(dir => fs.existsSync(path.join(LOCALES_DIR, dir, 'messages.json')));

  it('sweeps every locale', () => {
    expect(locales).toHaveLength(14);
  });

  it.each(locales)('%s names each provider on its route label and Continue', locale => {
    const dir = path.join(LOCALES_DIR, locale);
    const messages = JSON.parse(fs.readFileSync(path.join(dir, 'messages.json'), 'utf8'));
    // The app renders the flat bundle; the translation job keeps messages.json. Both must agree.
    const bundle = JSON.parse(fs.readFileSync(path.join(dir, `${locale}.json`), 'utf8'));
    const labels: Array<[string, string]> = [
      ['bridgeRouteEpoch', 'Epoch'],
      ['bridgeRouteAgglayer', 'Agglayer'],
      ['bridgeContinueEpoch', 'Epoch'],
      ['bridgeContinueAgglayer', 'Agglayer']
    ];
    for (const [key, provider] of labels) {
      for (const label of [messages[key].message as string, bundle[key] as string]) {
        expect(label).toContain(provider);
        expect(label).not.toMatch(/読|읽|阅读|閱讀|stronie|serwisie/);
      }
    }
  });
});
