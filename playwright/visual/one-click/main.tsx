import React from 'react';
import { createRoot } from 'react-dom/client';
import { MotionConfig } from 'framer-motion';
import '../../../src/i18n';
import '../../../src/main.css';
import { OneClickAmounts } from '../../../src/screens/swap-flow/OneClickAmounts';
import { OneClickReview } from '../../../src/screens/swap-flow/OneClickReview';
import type { OneClickAsset, OneClickQuoteResponse } from '../../../src/lib/one-click/types';
import type { OneClickNetworkOption } from '../../../src/screens/swap-flow/OneClickPickers';

const miden: OneClickAsset = {
  assetId: 'miden:usdcx',
  blockchain: 'miden',
  symbol: 'USDCX',
  decimals: 6,
  faucetId: '0x111111111111111111111111111111'
};
const ethereum: OneClickAsset = {
  assetId: 'eth:usdc',
  blockchain: 'eth',
  symbol: 'USDC',
  decimals: 6,
  contractAddress: '0x2222222222222222222222222222222222222222',
  chainId: 1
};
const midenNetwork: OneClickNetworkOption = { id: 'miden', name: 'Miden', kind: 'miden' };
const ethereumNetwork: OneClickNetworkOption = {
  id: 'eth',
  name: 'Ethereum',
  kind: 'ethereum',
  logoNetwork: 'ethereum'
};
const networks = [midenNetwork, ethereumNetwork];
const quote: OneClickQuoteResponse = {
  correlationId: 'visual-fixture',
  timestamp: '2026-10-22T10:00:00.000Z',
  signature: 'visual-fixture',
  quoteRequest: {
    dry: false,
    swapType: 'EXACT_INPUT',
    slippageTolerance: 100,
    originAsset: miden.assetId,
    depositType: 'ORIGIN_CHAIN',
    destinationAsset: ethereum.assetId,
    amount: '12500000',
    refundTo: '0x3333333333333333333333333333333333333333',
    refundType: 'ORIGIN_CHAIN',
    recipient: '0x4444444444444444444444444444444444444444',
    recipientType: 'DESTINATION_CHAIN',
    deadline: '2026-10-22T10:05:00.000Z'
  },
  quote: {
    depositAddress: '0x5555555555555555555555555555555555555555',
    amountIn: '12500000',
    amountInFormatted: '12.5',
    amountInUsd: '12.5',
    minAmountIn: '12500000',
    amountOut: '12400000',
    amountOutFormatted: '12.4',
    amountOutUsd: '12.4',
    minAmountOut: '12300000',
    deadline: '2026-10-22T10:05:00.000Z',
    timeEstimate: 180,
    refundFee: '1000',
    withdrawFee: '2000'
  }
};

function App() {
  const params = new URLSearchParams(location.search);
  const review = params.has('review');
  const inbound = params.has('inbound');
  const connected = params.has('connected');
  const originAsset = inbound ? ethereum : miden;
  const destinationAsset = inbound ? miden : ethereum;
  const originNetwork = inbound ? ethereumNetwork : midenNetwork;
  const destinationNetwork = inbound ? midenNetwork : ethereumNetwork;
  const inboundQuote: OneClickQuoteResponse = {
    ...quote,
    quoteRequest: {
      ...quote.quoteRequest,
      originAsset: ethereum.assetId,
      destinationAsset: miden.assetId,
      refundTo: '0x3333333333333333333333333333333333333333',
      recipient: 'miden1q2w3e4r5t6y7u8i9o0p'
    },
    quote: {
      ...quote.quote,
      amountIn: '12500000',
      amountInFormatted: '12.5',
      minAmountIn: '12500000',
      amountOut: '12400000',
      amountOutFormatted: '12.4',
      minAmountOut: '12300000'
    }
  };
  return review ? (
    <OneClickReview
      quote={inbound ? inboundQuote : quote}
      originAsset={originAsset}
      destinationAsset={destinationAsset}
      originNetworkName={originNetwork.name}
      destinationNetworkName={destinationNetwork.name}
      recipient={inbound ? 'miden1q2w3e4r5t6y7u8i9o0p' : '0x4444444444444444444444444444444444444444'}
      refundTo="0x3333333333333333333333333333333333333333"
      fees={[
        { label: 'oneClickRefundFee', value: inbound ? '0.001 USDC' : '0.001 USDCX' },
        { label: 'oneClickWithdrawFee', value: inbound ? '0.002 USDCX' : '0.002 USDC' }
      ]}
      nativeFee="0.01 MIDEN"
      now={Date.parse('2026-10-22T10:01:00.000Z')}
      onBack={() => undefined}
      onRefresh={() => undefined}
      onConfirm={() => undefined}
    />
  ) : (
    <OneClickAmounts
      assets={[miden, ethereum]}
      networks={networks}
      offerNetwork={originNetwork}
      requestNetwork={destinationNetwork}
      offerAsset={originAsset}
      requestAsset={destinationAsset}
      offerAmount="12.5"
      previewAmount="12.4"
      offerBalance={25}
      externalAddressLabel={inbound ? 'refund' : 'recipient'}
      externalAddressNetwork={inbound ? ethereumNetwork : undefined}
      externalAddress={inbound ? '' : '0x4444444444444444444444444444444444444444'}
      externalAddressEditable={!inbound}
      connectedExternalAddress={inbound && connected ? '0x3333333333333333333333333333333333333333' : undefined}
      onConnectExternal={inbound ? () => undefined : undefined}
      contacts={[
        { name: 'Savings', address: '0x4444444444444444444444444444444444444444', network: 'ethereum' },
        { name: 'Other chain', address: '0x6666666666666666666666666666666666666666', network: 'arbitrum' }
      ]}
      canContinue
      onOfferNetworkChange={() => undefined}
      onRequestNetworkChange={() => undefined}
      onOfferAssetChange={() => undefined}
      onRequestAssetChange={() => undefined}
      onOfferAmountChange={() => undefined}
      onExternalAddressChange={() => undefined}
      onContinue={() => undefined}
    />
  );
}

createRoot(document.getElementById('root')!).render(
  <MotionConfig reducedMotion="user">
    <App />
  </MotionConfig>
);
