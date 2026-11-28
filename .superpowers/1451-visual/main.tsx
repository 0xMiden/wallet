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
import type { NearIntentsSendQuote } from '../../src/screens/send-flow/useNearIntentsSendQuote';

const available: FeatureAvailability = { state: 'available' };
const unavailable: FeatureAvailability = { state: 'unavailable', reason: 'service-down', detail: 'Simulated outage' };
const payout: RoutePayout = { assetId: 'fixture-dollar', amount: '19.8', symbol: 'USDC' };
const payouts = { epoch: payout, agglayer: { ...payout, amount: '20' } };
const noop = () => undefined;
const contractAddress = '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const simulatedIntents: NearIntentsSendQuote = {
  status: 'ready',
  pair: {
    chain: { id: 'eth', name: 'Ethereum', addressKind: 'evm', tokens: [] },
    origin: { assetId: 'miden-usdc', blockchain: 'miden', symbol: 'USDC', decimals: 6, faucetId: 'fixture-faucet' },
    destination: { assetId: 'eth-usdc', blockchain: 'eth', symbol: 'USDC', decimals: 6, contractAddress }
  },
  quote: {
    correlationId: 'fixture',
    timestamp: '2026-11-28T00:00:00Z',
    signature: 'fixture',
    quoteRequest: {
      dry: true,
      swapType: 'EXACT_INPUT',
      slippageTolerance: 100,
      originAsset: 'miden-usdc',
      depositType: 'ORIGIN_CHAIN',
      destinationAsset: 'eth-usdc',
      amount: '21000000',
      refundTo: 'fixture',
      refundType: 'ORIGIN_CHAIN',
      recipient: 'fixture',
      recipientType: 'DESTINATION_CHAIN',
      deadline: '2026-11-28T00:05:00Z'
    },
    quote: {
      amountIn: '21000000',
      amountInFormatted: '21',
      amountInUsd: '21',
      minAmountIn: '21000000',
      amountOut: '20000000',
      amountOutFormatted: '20',
      amountOutUsd: '20',
      minAmountOut: '19700000',
      timeEstimate: 10
    }
  }
};

function BridgeFixture() {
  const params = new URLSearchParams(location.search);
  const surface = params.get('surface') ?? 'receive';
  const failed = params.has('failed');
  const retry = params.has('retry');
  const mixed = params.has('mixed');
  const [retryPending, setRetryPending] = useState(false);
  const [route, setRoute] = useState<BridgeRoute>(surface === 'circle' && !retry ? 'usdcx' : failed ? 'agglayer' : 'epoch');
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
        bridgeRoutesAvailable
        nearIntents={mixed ? { chainId: 'eth', recipient: 'fixture' } : undefined}
        nearIntentsQuote={mixed ? simulatedIntents : { status: 'idle' }}
        payouts={mixed ? { epoch: { ...payout, assetId: `1:${contractAddress}` } } : options.payouts}
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
        confirmLabel={retry && !retryPending ? 'Retry' : undefined}
        confirmDisabled={retryPending}
        availability={available}
        sourceChainId={84532}
        fast={{
          selected: route === 'epoch',
          onSelect: () => setRoute('epoch'),
          availability: available,
          loading: retryPending,
          feeUsd: 0.2,
          payout: { ...payout, symbol: 'USDCx' }
        }}
        onSelectCircle={() => setRoute('usdcx')}
        onConfirm={retry ? () => setRetryPending(true) : noop}
        payout={{ ...payout, amount: '20', symbol: 'USDCx' }}
        fee="0.03 USDC"
      />
    );
  }

  return (
    <Route
      {...options}
      accent="receive"
      confirmLabel={retry && !retryPending ? 'Retry' : undefined}
      confirmDisabled={retryPending || (route === 'epoch' && failed)}
      fastQuoteLoading={retryPending}
      onConfirm={retry ? () => setRetryPending(true) : noop}
    />
  );
}

createRoot(document.getElementById('root')!).render(
  <MotionConfig reducedMotion="always">
    <BridgeFixture />
  </MotionConfig>
);
