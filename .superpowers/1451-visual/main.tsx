import React, { useState } from 'react';

import { MotionConfig } from 'framer-motion';
import { createRoot } from 'react-dom/client';

import { EvmBridgeUsdcxRoute } from '../../src/app/templates/EvmConnectModal/EvmBridgeUsdcxRoute';
import '../../src/i18n';
import type { FeatureAvailability } from '../../src/lib/remote-config/availability';
import '../../src/main.css';
import { Route, type RoutePayout } from '../../src/screens/send-flow/Route';
import { SendRoute } from '../../src/screens/send-flow/SendRoute';
import type { BridgeRoute } from '../../src/screens/send-flow/types';

const available: FeatureAvailability = { state: 'available' };
const unavailable: FeatureAvailability = { state: 'unavailable', reason: 'service-down', detail: 'Simulated outage' };
const payout: RoutePayout = { assetId: 'fixture-dollar', amount: '19.8', symbol: 'USDC' };
const payouts = { epoch: payout, agglayer: { ...payout, amount: '20' } };
const noop = () => undefined;

function BridgeFixture() {
  const params = new URLSearchParams(location.search);
  const surface = params.get('surface') ?? 'receive';
  const failed = params.has('failed');
  const [route, setRoute] = useState<BridgeRoute>(surface === 'circle' ? 'usdcx' : failed ? 'agglayer' : 'epoch');
  const fastAvailability = failed ? unavailable : available;
  const options = {
    slowAvailability: available,
    fastAvailability,
    route,
    onRouteChange: setRoute,
    payouts: failed ? { agglayer: payouts.agglayer } : payouts,
    fastFeeUsd: failed ? undefined : 0.2,
    fastQuoteLoading: false,
    onConfirm: noop
  };

  if (surface === 'send') {
    return (
      <SendRoute
        {...options}
        onBack={noop}
        eligibility={{
          blocked: route === 'epoch' && failed,
          fastAvailability,
          slowAvailability: available,
          slowStatus: 'allowed',
          showFastRoute: true,
          showSlowRoute: true
        }}
      />
    );
  }

  if (surface === 'circle') {
    return (
      <EvmBridgeUsdcxRoute
        availability={available}
        sourceChainId={84532}
        fast={{
          selected: route === 'epoch',
          onSelect: () => setRoute('epoch'),
          availability: available,
          loading: false,
          feeUsd: 0.2,
          payout: { ...payout, symbol: 'USDCx' }
        }}
        onSelectCircle={() => setRoute('usdcx')}
        onConfirm={noop}
        payout={{ ...payout, amount: '20', symbol: 'USDCx' }}
        fee="0.03 USDC"
      />
    );
  }

  return <Route {...options} accent="receive" confirmDisabled={route === 'epoch' && failed} />;
}

createRoot(document.getElementById('root')!).render(
  <MotionConfig reducedMotion="always">
    <BridgeFixture />
  </MotionConfig>
);
