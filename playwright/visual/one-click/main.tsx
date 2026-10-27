import React from 'react';
import { createRoot } from 'react-dom/client';
import { MotionConfig } from 'framer-motion';
import '../../../src/i18n';
import '../../../src/main.css';
import { EvmBridgeDepositReview } from '../../../src/app/templates/EvmConnectModal/EvmBridgeDepositReview';
import type { OneClickEvmBalanceSnapshot } from '../../../src/lib/one-click/evm-balance';
import { OneClickAmounts } from '../../../src/screens/swap-flow/OneClickAmounts';
import { OneClickReview } from '../../../src/screens/swap-flow/OneClickReview';
import type { OneClickAsset, OneClickQuoteResponse } from '../../../src/lib/one-click/types';
import type { OneClickNetworkOption } from '../../../src/screens/swap-flow/OneClickPickers';

const TransactionFixture = React.lazy(() =>
  import('./transaction-fixture')
    .then(module => ({ default: module.TransactionFixture }))
    .catch(error => {
      console.error('Transaction fixture import failed:', String(error), JSON.stringify(error, Object.getOwnPropertyNames(error ?? {})));
      throw error;
    })
);

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
const inboundEvmBalance: OneClickEvmBalanceSnapshot = {
  chainId: 1,
  account: '0x3333333333333333333333333333333333333333',
  assetId: ethereum.assetId,
  tokenBalance: 25_000_000n,
  nativeBalance: 1_000_000_000_000_000_000n,
  gasReserve: 0n,
  spendableTokenBalance: 25_000_000n,
  spendableNativeBalance: 1_000_000_000_000_000_000n,
  requiredTokenAmount: 12_500_000n,
  tokenSufficient: true,
  gasSufficient: true,
  gasCheckComplete: true,
  canDeposit: true,
  estimatedGas: 100_000n,
  maxFeePerGas: 1_000_000_000n,
  updatedAt: Date.parse('2026-10-22T10:00:00.000Z')
};
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

function BridgeReviewFixture({ kind }: { kind: string }) {
  const existing = kind === 'existing';
  const slow = kind === 'slow';
  const executor = kind === 'executor';
  return (
    <EvmBridgeDepositReview
      amount={slow ? '0.05' : executor ? '10' : '10.6512'}
      symbol={slow ? 'ETH' : 'USDC'}
      route={slow ? 'agglayer' : executor ? 'usdcx' : 'epoch'}
      outputAmount={slow ? '0.05' : '10'}
      fee={executor ? '0.006' : undefined}
      networkName="Sepolia"
      networkId="sepolia"
      destinationName="Main account"
      sourceChainId={11155111}
      extensionId="abcdefghijklmnopabcdefghijklmnop"
      promptAmount={slow ? '0.05' : executor ? '10' : '10.6512'}
      promptContract={
        slow
          ? '0x1111111111111111111111111111111111111111'
          : executor
            ? '0x2222222222222222222222222222222222222222'
            : '0x00000000000000171ede64904551eeDF3C6C9788'
      }
      nativeSource={slow}
      usdcxExecutor={executor}
      epochResourceLockRequired={!existing}
      epochQuoteTransactions={
        existing
          ? [
              {
                chainId: 11155111,
                target: '0x3333333333333333333333333333333333333333',
                value: '0',
                callData: '0x12345678'
              }
            ]
          : []
      }
      canConfirm
      onConfirm={() => undefined}
      onBack={() => undefined}
    />
  );
}

function App() {
  const params = new URLSearchParams(location.search);
  if (params.has('tx')) {
    return (
      <TransactionFixture
        surface={params.get('tx') === 'asset' ? 'asset' : 'modal'}
        variant={params.has('partial') ? 'partial' : 'main'}
      />
    );
  }
  const bridge = params.get('bridge');
  if (bridge) return <BridgeReviewFixture kind={bridge} />;
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
      nativeFee={inbound ? undefined : '0.01 MIDEN'}
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
      offerBalance={inbound ? undefined : 25}
      evmBalance={inbound && connected ? { status: 'ready', snapshot: inboundEvmBalance, gasSymbol: 'ETH' } : undefined}
      externalAddressLabel={inbound ? 'refund' : 'recipient'}
      externalAddressNetwork={ethereumNetwork}
      externalAddress={inbound ? '' : '0x4444444444444444444444444444444444444444'}
      externalAddressEditable={!inbound}
      connectedExternalAddress={inbound && connected ? '0x3333333333333333333333333333333333333333' : undefined}
      onConnectExternal={inbound ? () => undefined : undefined}
      contacts={[
        { name: 'Savings', address: '0x4444444444444444444444444444444444444444', network: 'ethereum' },
        { name: 'Other chain', address: '0x6666666666666666666666666666666666666666', network: 'arbitrum' }
      ]}
      canContinue={!inbound || connected}
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
    <React.Suspense fallback={null}>
      <App />
    </React.Suspense>
  </MotionConfig>
);
