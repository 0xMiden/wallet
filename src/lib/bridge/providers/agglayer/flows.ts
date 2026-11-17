// Adapted from bridge-portal@cb52c470 src/bridge/providers/agglayer/flows.ts (MIT).
import { parseUnits } from 'viem';

import { verifyBridgeSubmission, type SubmissionChecks } from 'lib/bridge/core/submission';
import { findAdmittedBridgeOperation, type BridgeOperationInput } from 'lib/bridge/operation';
import { startBridgeReceiveSubmission } from 'lib/miden/activity/bridge-receive';
import { initiateBridgedReceiveTransaction } from 'lib/miden/transaction/initiate';
import { selectAgglayerRecoveryConfig } from 'lib/remote-config/values';

import { submitAgglayerDeposit, type AgglayerDepositRequest } from './deposit';

export async function runAgglayerReceive(operation: BridgeOperationInput, deps: Omit<AgglayerDepositRequest, 'operation' | 'rowId'> & { checks: SubmissionChecks }): Promise<string> {
  operation = structuredClone(operation);
  const existing = await findAdmittedBridgeOperation(operation);
  if (existing) return existing.id;
  const { review } = operation;
  const { route, amount, accounts, quote } = review;
  const chain = route.recovery.config.supportedEvmChains[route.source.network];
  const recovery = chain && selectAgglayerRecoveryConfig({ ...route.recovery, status: 'ready', lastFetch: null }, chain.chainId);
  if (route.provider !== 'agglayer' || route.mode !== 'receive' || route.destination.kind !== 'miden' || !recovery || !quote)
    throw new Error('Agglayer receive terms changed');
  await verifyBridgeSubmission(review, deps.checks);
  const faucetId = route.destination.faucetId;
  return startBridgeReceiveSubmission(() => initiateBridgedReceiveTransaction({
    accountId: accounts.midenAccount, amount: parseUnits(quote.received, route.destination.decimals), faucetId,
    provider: 'agglayer', sourceChainId: recovery.chainId, sourceAddress: accounts.evmAddress,
    sourceAmount: amount, sourceSymbol: route.source.symbol, agglayerRoute: recovery, operation
  }), async (rowId, claimed) => {
    if (!claimed) return;
    await submitAgglayerDeposit({ rowId, operation: claimed, provider: deps.provider, client: deps.client });
  });
}
