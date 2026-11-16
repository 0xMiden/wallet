import { accounts, connections, now, referenceSnapshot } from './fixtures';
import { bindTransferQuote } from '../core/quote';
import { assertReviewedBridge, type ReviewedTransfer } from '../core/review';
import type { BridgeRoute } from '../core/routes';

export function reviewedErc20Transfer(
  provider: 'agglayer' | 'epoch',
  mode: 'receive' | 'send' = 'receive'
): ReviewedTransfer {
  const connection = connections.testnet.find(
    item => item.provider === provider && item.evm.kind === 'erc20' && !item.disabled && item.routes[mode]
  );
  const snapshot = referenceSnapshot('testnet');
  if (!connection?.evm.address || !snapshot.config || !snapshot.derived)
    throw new Error('Missing accepted ERC20 fixture');
  const evm = {
    kind: 'erc20',
    network: connection.evm.network,
    symbol: connection.evm.symbol,
    decimals: connection.evm.decimals,
    address: connection.evm.address
  } satisfies BridgeRoute['source'];
  const miden = {
    kind: 'miden',
    network: connection.miden.network,
    symbol: connection.miden.symbol,
    decimals: connection.miden.decimals,
    faucetId: connection.miden.faucetId
  } satisfies BridgeRoute['source'];
  const route: BridgeRoute = {
    id: `test:${provider}:${mode}`,
    provider,
    mode,
    source: mode === 'receive' ? evm : miden,
    destination: mode === 'receive' ? miden : evm,
    recovery: { network: 'testnet', config: snapshot.config, derived: snapshot.derived }
  };
  const amount = '1.000000';
  const review: ReviewedTransfer = {
    route,
    amount,
    accounts: { ...accounts },
    quote: bindTransferQuote(
      { route, amount, ...accounts },
      {
        kind: provider,
        received: '1',
        validity: { kind: 'time', expiresAt: now + 60000 }
      }
    )
  };
  assertReviewedBridge(review, structuredClone(review), now);
  return review;
}
