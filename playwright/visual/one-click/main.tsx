import React from 'react';
import { createRoot } from 'react-dom/client';
import { MotionConfig } from 'framer-motion';
import '../../../src/i18n';
import '../../../src/main.css';
import { EvmBridgeDepositReview } from '../../../src/app/templates/EvmConnectModal/EvmBridgeDepositReview';

const TransactionFixture = React.lazy(() =>
  import('./transaction-fixture')
    .then(module => ({ default: module.TransactionFixture }))
    .catch(error => {
      console.error('Transaction fixture import failed:', String(error), JSON.stringify(error, Object.getOwnPropertyNames(error ?? {})));
      throw error;
    })
);

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

// The fixture has two groups of routes: `?tx=` for the transaction views and `?bridge=` for the bridge review.
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
  return null;
}

createRoot(document.getElementById('root')!).render(
  <MotionConfig reducedMotion="user">
    <React.Suspense fallback={null}>
      <App />
    </React.Suspense>
  </MotionConfig>
);
