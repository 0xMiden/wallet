import React from 'react';

import { fireEvent, render, screen } from '@testing-library/react';

import type { BridgeFeature, FeatureAvailability } from 'lib/remote-config/availability';

import { SendRoute, SendRouteProps } from './SendRoute';
import { AgglayerEligibility, useAgglayerEligibility } from './useAgglayerEligibility';

jest.mock('./useAgglayerEligibility', () => ({ useAgglayerEligibility: jest.fn(() => 'allowed') }));

const DOWN: FeatureAvailability = {
  state: 'unavailable',
  reason: 'service-down',
  detail: 'allocator /health: timeout'
};
let mockAvailability: Partial<Record<BridgeFeature, FeatureAvailability>> = {};
jest.mock('lib/remote-config/use-feature-availability', () => ({
  useBridgeConfigSnapshot: () =>
    jest.requireActual<typeof import('lib/epoch/testing/bridge-config')>('lib/epoch/testing/bridge-config')
      .TEST_BRIDGE_CONFIG_SNAPSHOT,
  useFeatureAvailability: (feature: BridgeFeature) => mockAvailability[feature] ?? { state: 'available' }
}));

beforeEach(() => {
  mockAvailability = {};
  mockNearIntentsQuote = { status: 'idle' };
  mockUseNearIntentsSendQuote.mockClear();
});

jest.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key })
}));

// `SendStepLayout` is the shared `FlowLayout`; stub it to a probe that surfaces
// the header title, the back handler and where children/footer land, mirroring
// the sibling `ReviewTransaction.test.tsx`'s `./SendStepLayout` stub.
jest.mock('./SendStepLayout', () => ({
  SendStepLayout: ({ title, onBack, children, footer }: any) => (
    <div data-testid="send-route-layout">
      <h1>{title}</h1>
      <button data-testid="send-route-back" onClick={onBack}>
        back
      </button>
      <div data-testid="send-route-body">{children}</div>
      <div data-testid="send-route-footer">{footer}</div>
    </div>
  )
}));

// `RouteOptions` renders the Fast/Slow route cards; stub it to a probe that
// echoes the props `SendRoute` wires through, including the accent it forces.
jest.mock('./Route', () => ({
  RouteOptions: (props: any) => (
    <div
      data-testid="route-options"
      data-route={props.route}
      data-accent={props.accent}
      data-fast-fee={String(props.fastFeeUsd)}
      data-fast-loading={String(props.fastQuoteLoading)}
      data-slow-status={props.slowStatus}
      data-show-fast={String(props.showFastRoute)}
      data-show-slow={String(props.showSlowRoute)}
      data-fast-state={props.fastAvailability.state}
      data-fast-reason={props.fastAvailability.state === 'unavailable' ? props.fastAvailability.reason : ''}
      data-slow-state={props.slowAvailability.state}
      data-slow-reason={props.slowAvailability.state === 'unavailable' ? props.slowAvailability.reason : ''}
      data-bridge-routes={String(props.bridgeRoutesAvailable)}
    >
      {props.nearIntentsCard}
    </div>
  ),
  NearIntentsRouteCard: (props: any) => (
    <button
      type="button"
      data-testid="near-intents-card"
      data-status={props.quote.status}
      data-selected={String(props.selected)}
      onClick={props.onSelect}
    />
  )
}));

// The quote hook reads the bridge config, the catalog and 1Click; the card states have their own tests.
let mockNearIntentsQuote: { status: string } = { status: 'idle' };
const mockUseNearIntentsSendQuote = jest.fn((_params: unknown) => mockNearIntentsQuote);
jest.mock('./useNearIntentsSendQuote', () => ({
  useNearIntentsSendQuote: (params: unknown) => mockUseNearIntentsSendQuote(params)
}));

// Stubs the accent through to a `data-accent` attribute (the SendAmount.test.tsx pattern) so the
// Confirm CTA's flow colour is assertable without the real Button's cva class computation.
jest.mock('components/Button', () => ({
  ButtonVariant: { Primary: 'primary' },
  Button: ({ title, variant: _variant, accent, ...rest }: any) => (
    <button type="button" data-accent={accent} {...rest}>
      {title}
    </button>
  )
}));

function renderRoute(overrides: Partial<SendRouteProps> = {}) {
  const props: SendRouteProps = {
    faucetId: 'token',
    route: 'epoch',
    onRouteChange: jest.fn(),
    fastQuoteLoading: false,
    onBack: jest.fn(),
    onConfirm: jest.fn(),
    bridgeRoutesAvailable: true,
    ...overrides
  };
  render(<SendRoute {...props} />);
  return props;
}

describe('SendRoute', () => {
  it.each<AgglayerEligibility>(['loading', 'unsupported', 'error'])(
    'blocks confirmation on Slow while %s (#1276)',
    status => {
      jest.mocked(useAgglayerEligibility).mockReturnValueOnce(status);
      const props = renderRoute({ route: 'agglayer' });
      expect(screen.getByTestId('route-options')).toHaveAttribute('data-slow-status', status);
      expect(screen.getByTestId('bridge-route-confirm')).toBeDisabled();
      fireEvent.click(screen.getByTestId('bridge-route-confirm'));
      expect(props.onConfirm).not.toHaveBeenCalled();
    }
  );

  it('confirms Slow once the token is allowed (#1276)', () => {
    jest.mocked(useAgglayerEligibility).mockReturnValueOnce('allowed');
    const props = renderRoute({ route: 'agglayer' });
    fireEvent.click(screen.getByTestId('bridge-route-confirm'));
    expect(props.onConfirm).toHaveBeenCalledTimes(1);
  });

  it('reads Fast from fastBridgeOut and Slow from bridgeOut', () => {
    mockAvailability = { fastBridgeOut: DOWN };
    renderRoute({ route: 'agglayer' });
    const options = screen.getByTestId('route-options');
    expect(options).toHaveAttribute('data-fast-state', 'unavailable');
    expect(options).toHaveAttribute('data-slow-state', 'available');
    expect(screen.getByTestId('bridge-route-confirm')).toBeEnabled();
  });

  it.each<['epoch' | 'agglayer', BridgeFeature]>([
    ['epoch', 'fastBridgeOut'],
    ['agglayer', 'bridgeOut']
  ])('blocks Confirm on %s while %s is unavailable', (route, feature) => {
    mockAvailability = { [feature]: DOWN };
    const props = renderRoute({ route });
    fireEvent.click(screen.getByTestId('bridge-route-confirm'));
    expect(screen.getByTestId('bridge-route-confirm')).toBeDisabled();
    expect(props.onConfirm).not.toHaveBeenCalled();
  });

  // The USDCx burn needs neither bridge: on testnet the two features can be unavailable together.
  it('confirms the USDCx route while the Fast and Slow features are unavailable', () => {
    mockAvailability = { fastBridgeOut: DOWN, bridgeOut: DOWN };
    jest.mocked(useAgglayerEligibility).mockReturnValueOnce('unsupported');
    const props = renderRoute({ route: 'usdcx', usdcxAvailable: true });

    expect(screen.getByTestId('bridge-route-confirm')).toBeEnabled();
    fireEvent.click(screen.getByTestId('bridge-route-confirm'));
    expect(props.onConfirm).toHaveBeenCalledTimes(1);
  });

  it('blocks Confirm on the USDCx route for a token that cannot use it', () => {
    renderRoute({ route: 'usdcx', usdcxAvailable: false });

    expect(screen.getByTestId('bridge-route-confirm')).toBeDisabled();
  });

  it('shows the route title and forwards the back action', () => {
    const props = renderRoute();

    expect(screen.getByText('bridgeChooseRoute')).toBeInTheDocument();
    fireEvent.click(screen.getByTestId('send-route-back'));
    expect(props.onBack).toHaveBeenCalledTimes(1);
  });

  it('gives Confirm the send flow colour', () => {
    renderRoute();

    expect(screen.getByTestId('bridge-route-confirm')).toHaveAttribute('data-accent', 'send');
  });

  describe('NEAR Intents', () => {
    const NEAR_INTENTS = { chainId: 'sol', recipient: 'SoLaNaRecipient', amount: 20_000_000n };

    it('shows no NEAR Intents card and asks for no quote when NEAR Intents does not offer the network', () => {
      renderRoute();

      expect(screen.queryByTestId('near-intents-card')).not.toBeInTheDocument();
      expect(mockUseNearIntentsSendQuote).toHaveBeenCalledWith(
        expect.objectContaining({ enabled: false, faucetId: 'token' })
      );
    });

    it('shows the NEAR Intents card beside the bridge routes and asks for its quote', () => {
      renderRoute({ nearIntents: NEAR_INTENTS });

      expect(screen.getByTestId('route-options')).toHaveAttribute('data-bridge-routes', 'true');
      expect(screen.getByTestId('near-intents-card')).toHaveAttribute('data-selected', 'false');
      expect(mockUseNearIntentsSendQuote).toHaveBeenCalledWith({
        chainId: 'sol',
        faucetId: 'token',
        amount: 20_000_000n,
        recipient: 'SoLaNaRecipient',
        enabled: true
      });
    });

    it('selects NEAR Intents when the card is tapped', () => {
      const props = renderRoute({ nearIntents: NEAR_INTENTS });

      fireEvent.click(screen.getByTestId('near-intents-card'));

      expect(props.onRouteChange).toHaveBeenCalledWith('near-intents');
    });

    it('selects NEAR Intents at once when no bridge route serves the network', () => {
      const props = renderRoute({ nearIntents: NEAR_INTENTS, bridgeRoutesAvailable: false });

      expect(screen.getByTestId('route-options')).toHaveAttribute('data-bridge-routes', 'false');
      expect(props.onRouteChange).toHaveBeenCalledWith('near-intents');
    });

    it.each(['idle', 'loading', 'unsupported', 'error'])('blocks Confirm while the quote is %s', status => {
      mockNearIntentsQuote = { status };
      const props = renderRoute({ route: 'near-intents', nearIntents: NEAR_INTENTS });

      expect(screen.getByTestId('bridge-route-confirm')).toBeDisabled();
      fireEvent.click(screen.getByTestId('bridge-route-confirm'));
      expect(props.onConfirm).not.toHaveBeenCalled();
    });

    it('confirms NEAR Intents once the quote is ready, whatever the bridge features say', () => {
      mockAvailability = { fastBridgeOut: DOWN, bridgeOut: DOWN };
      mockNearIntentsQuote = { status: 'ready' };
      const props = renderRoute({ route: 'near-intents', nearIntents: NEAR_INTENTS, bridgeRoutesAvailable: false });

      fireEvent.click(screen.getByTestId('bridge-route-confirm'));

      expect(props.onConfirm).toHaveBeenCalledTimes(1);
    });

    it('blocks Confirm on a bridge route when no bridge route serves the network', () => {
      renderRoute({ route: 'epoch', nearIntents: NEAR_INTENTS, bridgeRoutesAvailable: false });

      expect(screen.getByTestId('bridge-route-confirm')).toBeDisabled();
    });
  });

  it('forces the send accent on the route options regardless of the route, and wires Confirm', () => {
    const props = renderRoute({ route: 'agglayer' });

    const options = screen.getByTestId('route-options');
    expect(options).toHaveAttribute('data-accent', 'send');
    expect(options).toHaveAttribute('data-route', 'agglayer');

    fireEvent.click(screen.getByTestId('bridge-route-confirm'));
    expect(props.onConfirm).toHaveBeenCalledTimes(1);
  });
});

it('hides AggLayer on an Epoch-only chain', () => {
  renderRoute({ destinationChainId: 11155111 });
  expect(screen.getByTestId('route-options')).toHaveAttribute('data-show-fast', 'true');
  expect(screen.getByTestId('route-options')).toHaveAttribute('data-show-slow', 'false');
  expect(screen.getByTestId('route-options')).toHaveAttribute('data-slow-state', 'unavailable');
});

it('keeps the Fast route loading while its availability loads', () => {
  mockAvailability = { fastBridgeOut: { state: 'loading' } };
  renderRoute({ destinationChainId: 11155111, faucetId: 'unlisted' });
  expect(screen.getByTestId('route-options')).toHaveAttribute('data-fast-state', 'loading');
});

it('keeps the Fast route service-down reason while its service is down', () => {
  mockAvailability = { fastBridgeOut: DOWN };
  renderRoute({ destinationChainId: 11155111, faucetId: 'unlisted' });
  expect(screen.getByTestId('route-options')).toHaveAttribute('data-fast-reason', 'service-down');
});

it('keeps the Slow route service-down reason while its service is down', () => {
  mockAvailability = { bridgeOut: DOWN };
  renderRoute({ destinationChainId: 11155111 });
  expect(screen.getByTestId('route-options')).toHaveAttribute('data-slow-reason', 'service-down');
});

it('blocks an Epoch send for a faucet that the destination does not support', () => {
  renderRoute({ destinationChainId: 11155111, faucetId: 'unlisted' });
  expect(screen.getByTestId('bridge-route-confirm')).toBeDisabled();
});
