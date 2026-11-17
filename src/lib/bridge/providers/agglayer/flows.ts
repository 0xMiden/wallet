// Adapted from bridge-portal@cb52c470 src/bridge/providers/agglayer/flows.ts (MIT).
import { parseUnits } from 'viem';

import { initiateB2AggBridge, type B2AggBridgeDeps } from 'lib/agglayer/b2agg';
import { configKey } from 'lib/bridge/core/routes';
import { verifyBridgeSubmission, type SubmissionChecks } from 'lib/bridge/core/submission';
import { captureBridgeWalletScope, findAdmittedBridgeOperation, type BridgeOperationInput } from 'lib/bridge/operation';
import { startBridgeReceiveSubmission } from 'lib/miden/activity/bridge-receive';
import { initiateBridgedReceiveTransaction } from 'lib/miden/transaction/initiate';
import { selectAgglayerRecoveryConfig, selectAgglayerRegistryToken } from 'lib/remote-config/values';

import { submitAgglayerDeposit, type AgglayerDepositRequest } from './deposit';

export async function runAgglayerSend(
  operation: BridgeOperationInput,
  deps: Pick<B2AggBridgeDeps, 'guardianProvider'>
): Promise<string> {
  operation = structuredClone(operation);
  const { review } = operation;
  const { route, amount, accounts } = review;
  const chain = route.recovery.config.supportedEvmChains[route.destination.network];
  if (route.provider !== 'agglayer' || route.mode !== 'send' || route.source.kind !== 'miden' || !chain)
    throw new Error('Agglayer send terms changed');
  return initiateB2AggBridge({
    amount: parseUnits(amount, route.source.decimals),
    faucetId: route.source.faucetId,
    destinationAddress: `0x${accounts.evmAddress.slice(2)}`,
    senderPublicKey: accounts.midenAccount,
    guardianProvider: deps.guardianProvider,
    destinationChainId: chain.chainId,
    operation
  });
}

export async function runAgglayerReceive(
  operation: BridgeOperationInput,
  deps: Omit<AgglayerDepositRequest, 'operation' | 'rowId'> & { checks: SubmissionChecks }
): Promise<string> {
  operation = structuredClone(operation);
  const originalScope = captureBridgeWalletScope();
  const existing = await findAdmittedBridgeOperation(operation);
  if (existing) return existing.id;
  const { review } = operation;
  const { route, amount, accounts, quote } = review;
  const chain = route.recovery.config.supportedEvmChains[route.source.network];
  const recovery =
    chain && selectAgglayerRecoveryConfig({ ...route.recovery, status: 'ready', lastFetch: null }, chain.chainId);
  if (
    route.provider !== 'agglayer' ||
    route.mode !== 'receive' ||
    route.destination.kind !== 'miden' ||
    !recovery ||
    !quote
  )
    throw new Error('Agglayer receive terms changed');
  await verifyBridgeSubmission(review, deps.checks);
  if (configKey(captureBridgeWalletScope()) !== configKey(originalScope))
    throw new Error('Agglayer wallet scope changed');
  const faucetId = route.destination.faucetId;
  const registry =
    route.source.kind === 'erc20' &&
    selectAgglayerRegistryToken(
      { ...route.recovery, status: 'ready', lastFetch: null },
      route.source.address,
      recovery.chainId,
      recovery.evmNetworkId
    );
  if (route.source.kind === 'erc20' && (!registry || registry.midenFaucetId !== faucetId))
    throw new Error('Agglayer delivery identity changed');
  const agglayerDelivery =
    route.source.kind === 'erc20' && registry
      ? {
          originToken: `0x${route.source.address.slice(2)}` satisfies `0x${string}`,
          faucetId: registry.midenFaucetId,
          scale: registry.scale
        }
      : undefined;
  return startBridgeReceiveSubmission(
    () => {
      if (configKey(captureBridgeWalletScope()) !== configKey(originalScope))
        throw new Error('Agglayer wallet scope changed');
      return initiateBridgedReceiveTransaction({
        accountId: accounts.midenAccount,
        amount: parseUnits(quote.received, route.destination.decimals),
        faucetId,
        provider: 'agglayer',
        sourceChainId: recovery.chainId,
        sourceAddress: accounts.evmAddress,
        sourceAmount: amount,
        sourceSymbol: route.source.symbol,
        agglayerRoute: recovery,
        agglayerDelivery,
        operation
      });
    },
    async (rowId, claimed) => {
      if (!claimed) return;
      await submitAgglayerDeposit({
        rowId,
        operation: claimed,
        provider: deps.provider,
        client: deps.client,
        checks: deps.checks
      });
    }
  );
}
