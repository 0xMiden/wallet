import { parseUnits } from 'viem';

import { BridgedSendTransaction } from 'lib/miden/db/types';
import { getEffectiveNetworkName, getEffectiveRpcUrl } from 'lib/miden-chain/effective-endpoints';
import { selectAgglayerRecoveryConfig } from 'lib/remote-config/values';

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

export function ownedNativeBridgeRow(): BridgedSendTransaction {
  const review = reviewedErc20Transfer('agglayer', 'send');
  const snapshot = referenceSnapshot('testnet');
  const recovery = selectAgglayerRecoveryConfig(snapshot, 11155111);
  if (!recovery || review.route.source.kind !== 'miden') throw new Error('Missing native bridge fixture');
  const row = new BridgedSendTransaction(
    accounts.midenAccount,
    parseUnits(review.amount, review.route.source.decimals),
    accounts.evmAddress,
    recovery.evmNetworkId,
    'agglayer',
    review.route.source.faucetId,
    new Uint8Array([81, 82, 83]),
    false
  );
  row.approvedOutputNoteIds = ['note:recorded'];
  row.extraInputs.agglayerRoute = recovery;
  row.extraInputs.bridgeOperation = {
    version: 1,
    owner: 'wallet',
    operationId: 'native-operation',
    revision: 'admitted',
    review,
    walletScope: { network: getEffectiveNetworkName(), rpcUrl: getEffectiveRpcUrl() }
  };
  return row;
}
