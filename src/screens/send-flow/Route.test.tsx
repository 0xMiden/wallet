import React from 'react';

import { act, fireEvent, render, screen, within } from '@testing-library/react';
import fs from 'fs';
import path from 'path';

import { stepFooterCushionClass } from 'components/flow/footer-cushion';
import { useSlideOnReflow } from 'components/flow/useSlideOnReflow';
import { resolveDisplayMetadata } from 'lib/miden/metadata/resolve';
import type { FeatureAvailability } from 'lib/remote-config/availability';
import { reportUserVisibleError } from 'lib/telemetry/user-visible-error';

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
