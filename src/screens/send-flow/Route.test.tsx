import React from 'react';

import { fireEvent, render, screen } from '@testing-library/react';

import { stepFooterCushionClass } from 'components/flow/footer-cushion';
import { useSlideOnReflow } from 'components/flow/useSlideOnReflow';
import type { FeatureAvailability } from 'lib/remote-config/availability';

import { Route, RouteOptions } from './Route';
import { AgglayerEligibility } from './useAgglayerEligibility';

jest.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
jest.mock('lib/mobile/haptics', () => ({ hapticLight: jest.fn() }));
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
    expect(screen.queryByTestId('feature-unavailable-notice')).not.toBeInTheDocument();
  });

  it('greys out an unavailable Fast route under the notice, and takes no tap', () => {
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
    expect(screen.getByTestId('feature-unavailable-notice')).toHaveTextContent('bridgeFeatureUnavailableTitle');
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
    expect(screen.getByTestId('bridge-route-slow')).toBeDisabled();
    expect(screen.getByTestId('bridge-route-fast')).toBeEnabled();
    expect(screen.getByTestId('feature-unavailable-notice')).toBeInTheDocument();
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
    expect(screen.queryByTestId('feature-unavailable-notice')).not.toBeInTheDocument();
  });
});
