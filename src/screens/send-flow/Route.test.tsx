import React from 'react';

import { fireEvent, render, screen, within } from '@testing-library/react';

import { stepFooterCushionClass } from 'components/flow/footer-cushion';
import { useSlideOnReflow } from 'components/flow/useSlideOnReflow';
import { resolveDisplayMetadata } from 'lib/miden/metadata/resolve';
import type { FeatureAvailability } from 'lib/remote-config/availability';

import { Route, RouteOptions } from './Route';
import { AgglayerEligibility } from './useAgglayerEligibility';

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
      const value = params?.symbol ?? params?.amount;
      return value === undefined ? key : `${key}|${value}`;
    }
  })
}));
jest.mock('lib/mobile/haptics', () => ({ hapticLight: jest.fn(), hapticSelection: jest.fn() }));
// The USDCx card names the native fee asset as the wallet resolves it; on testnet that is USDCx.
jest.mock('app/hooks/useNativeFeeFaucetId', () => ({ __esModule: true, default: () => 'mtst1usdcxnative' }));
jest.mock('lib/store', () => ({
  useWalletStore: (selector: (state: { assetsMetadata: Record<string, never> }) => unknown) =>
    selector({ assetsMetadata: {} })
}));
jest.mock('lib/miden/metadata/resolve', () => ({
  resolveDisplayMetadata: jest.fn(() => ({ symbol: 'USDCx', name: 'USDCx', decimals: 6 }))
}));
jest.mock('lib/platform', () => ({ isMobile: () => true }));
jest.mock('components/flow/useSlideOnReflow', () => ({ useSlideOnReflow: jest.fn() }));

const AVAILABLE: FeatureAvailability = { state: 'available' };
const DOWN: FeatureAvailability = {
  state: 'unavailable',
  reason: 'service-down',
  detail: 'allocator /health: timeout'
};
const UP = { fastAvailability: AVAILABLE, slowAvailability: AVAILABLE };

describe('Route', () => {
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
    expect(footer).toHaveClass('pt-4');
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

  it('enables Slow after approval', () => {
    render(
      <RouteOptions route="agglayer" onRouteChange={jest.fn()} fastQuoteLoading={false} slowStatus="allowed" {...UP} />
    );
    expect(screen.getByTestId('bridge-route-slow')).toBeEnabled();
    expect(screen.queryByRole('status')).not.toBeInTheDocument();
    expect(screen.queryByText('bridgeFeatureUnavailableTitle')).not.toBeInTheDocument();
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
    expect(notice).toHaveTextContent('bridgeFeatureUnavailableTitle');
    expect(fast).toHaveAttribute('aria-describedby', notice.id);
    expect(fast.parentElement).toBe(notice.parentElement);
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
    expect(slow.parentElement).toBe(notice.parentElement);
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
    expect(screen.getAllByText('bridgeFeatureUnavailableTitle')).toHaveLength(1);
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
    expect(screen.getAllByText('bridgeFeatureUnavailableTitle')).toHaveLength(2);
    const fastNotice = screen.getByTestId('feature-unavailable-notice-fast');
    const slowNotice = screen.getByTestId('feature-unavailable-notice-slow');
    expect(fastNotice.id).not.toBe(slowNotice.id);
    expect(screen.getByTestId('bridge-route-fast')).toHaveAttribute('aria-describedby', fastNotice.id);
    expect(screen.getByTestId('bridge-route-slow')).toHaveAttribute('aria-describedby', slowNotice.id);
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
    expect(screen.queryByText('bridgeFeatureUnavailableTitle')).not.toBeInTheDocument();
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

  // Circle charges a flat ~1,003,500 (about 1.0035 USDC) to pay a burn out on Ethereum; the allowance is 1.5 USDC.
  it.each([
    [11155111, 10_000_000n, '1.5', '8.5'],
    [5042002, 1_000_001n, '0.1', '0.900001']
  ])('shows Circle fee and the least payout for a burn to chain %i', (chainId, amount, fee, payout) => {
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
    expect(feeRow.getByText(`usdcxPayoutFeeUpTo|${fee}`)).toBeInTheDocument();
    const payoutRow = within(screen.getByTestId('usdcx-payout-net'));
    expect(payoutRow.getByText('youReceive')).toBeInTheDocument();
    expect(payoutRow.getByText(`usdcxPayoutAtLeast|${payout}`)).toBeInTheDocument();
  });

  it('leaves out the payout while the fee allowance takes the whole amount', () => {
    render(
      <RouteOptions
        usdcxAvailable
        route="usdcx"
        onRouteChange={jest.fn()}
        fastQuoteLoading={false}
        slowStatus="allowed"
        usdcxPayout={{ chainId: 11155111, amount: 1_500_000n }}
        {...UP}
      />
    );

    expect(screen.getByTestId('usdcx-payout-fee')).toBeInTheDocument();
    expect(screen.queryByTestId('usdcx-payout-net')).not.toBeInTheDocument();
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
