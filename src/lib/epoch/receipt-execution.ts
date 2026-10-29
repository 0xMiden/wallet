import { getClaimHash } from '@epoch-protocol/epoch-commons-sdk';
import {
  CollateralType,
  type EpochIntentSDK,
  type SolveIntentParams,
  type TransactionExecutionStatus
} from '@epoch-protocol/epoch-intents-sdk';
import {
  executeWalletBatch,
  groupContiguousByChain,
  isUserWalletRejection,
  isBatchingUnsupported,
  mapBundleReceiptsToLegs
} from '@epoch-protocol/epoch-intents-sdk/dist/batch';
import { ARBITER_ADDRESS, SUPPORTED_CHAINS } from '@epoch-protocol/epoch-intents-sdk/dist/constants';
import { resolveWalletBatchStrategy } from '@epoch-protocol/epoch-intents-sdk/dist/gasless/capability';
import { apiFetch } from '@epoch-protocol/epoch-intents-sdk/dist/http';
import {
  computeMidenRecallBlocks,
  encodeMidenMandateBindingToFelts,
  MIDEN_COLLATERAL_NOTE_TYPE,
  validateMidenCollateralInputs
} from '@epoch-protocol/epoch-intents-sdk/dist/miden';
import {
  TRANSACTION_RECEIPT_TIMEOUT_MS,
  waitUntilTransactionSimulates
} from '@epoch-protocol/epoch-intents-sdk/dist/sdk/transaction-utils';
import {
  checkIfDepositNeeded,
  depositToCompact,
  getCompactData,
  getForcedWithdrawalStatusService,
  getMidenCollateralConfig
} from '@epoch-protocol/epoch-intents-sdk/dist/services';
import {
  createPublicClient,
  createWalletClient,
  custom,
  http,
  isAddress,
  isHex,
  type Chain,
  type TransactionReceipt
} from 'viem';
import { z } from 'zod';

import { recoveryCompactRequest } from 'lib/miden/recovery/provider-record';

import type { EpochReceiptHooks } from './bridge';

const address = z.custom<`0x${string}`>(value => typeof value === 'string' && isAddress(value));
const hex = z.custom<`0x${string}`>(value => typeof value === 'string' && isHex(value) && value.length <= 1_000_000);
const uint = z
  .union([z.bigint(), z.string().regex(/^(0|[1-9][0-9]{0,77})$/)])
  .transform(value => BigInt(value))
  .refine(value => value >= 0n && value < 2n ** 256n);
const compactResult = z
  .object({
    compactData: z
      .object({
        arbiter: address,
        sponsor: address,
        nonce: uint,
        expires: uint,
        id: uint,
        lockTag: uint,
        token: address,
        amount: uint,
        mandate: recoveryCompactRequest.shape.compact.shape.mandate
      })
      .strict(),
    claimHash: hex,
    witnessTypeString: z.string().min(1).max(2048),
    typehash: hex,
    tokenType: z.enum(['native', 'erc20'])
  })
  .strict();
const executionTransactions = z
  .array(
    z
      .object({
        target: address,
        callData: hex,
        value: z.string().regex(/^(0|[1-9][0-9]{0,77})$/),
        chainId: z.number().int().positive().safe()
      })
      .strict()
  )
  .max(256);

/** Composes the pinned SDK services without allocating a second compact nonce. */
export async function executeRetainedEpochIntent(
  sdk: Pick<EpochIntentSDK, 'submitAllocation'>,
  params: SolveIntentParams,
  hooks: EpochReceiptHooks
) {
  const original = hooks.config;
  if (
    original.walletClient.account?.type === 'local' &&
    (params.allowGaslessSmartAccount ?? original.allowGaslessSmartAccount)
  ) {
    throw new Error('This bridge requires a wallet-paid Epoch deposit');
  }
  const raw: unknown = await getCompactData(original, params);
  const { compactData, witnessTypeString, typehash, tokenType } = compactResult.parse(raw);
  const withdrawal = await getForcedWithdrawalStatusService(original, params.sponsorAddress, compactData.id.toString());
  if (withdrawal.status !== 'Disabled')
    throw new Error(`Cannot solve intent: forced withdrawal status is "${withdrawal.status}"`);
  const quotedInput = params.quoteResult?.tokenIn;
  if (quotedInput && compactData.mandate.tokenInAmount === '0') {
    compactData.amount = uint.parse(quotedInput);
    compactData.mandate.tokenInAmount = compactData.amount.toString();
  }
  const chainId = original.walletClient.chain?.id;
  const arbiter = chainId && ARBITER_ADDRESS[chainId];
  if (!chainId || !arbiter) throw new Error('Unsupported Epoch source chain');
  const collateralType = params.collateralType ?? CollateralType.EVM;
  const request = recoveryCompactRequest.parse({
    chainId: String(chainId),
    compact: {
      ...compactData,
      arbiter,
      nonce: String(compactData.nonce),
      expires: String(compactData.expires),
      id: String(compactData.id),
      amount: String(compactData.amount),
      lockTag: `0x${compactData.lockTag.toString(16).padStart(24, '0')}`
    },
    witnessTypeString,
    sponsorSignature: '0x',
    isRegisteredOnchain: collateralType !== CollateralType.Miden,
    routingAndLiquidityOptions: params.routingAndLiquidityOptions
  });
  const quote = params.quoteResult ?? (await checkIfDepositNeeded(original, request));
  const transactions = executionTransactions.parse(quote.transactions);
  const claimHash = getClaimHash(compactData, witnessTypeString);
  let fenced = false;
  const assertCurrent = () => {
    if (fenced) throw new Error('Epoch submission requires reconciliation');
    hooks.assertCurrent();
    if (BigInt(request.compact.expires) <= BigInt(Math.floor(Date.now() / 1000)))
      throw new Error('Epoch preparation expired');
  };
  // Rebuild bound viem actions so every send reaches the receipt-aware transport.
  const walletClient = createWalletClient({
    account: original.walletClient.account,
    chain: original.walletClient.chain,
    transport: custom(
      {
        request: async args => {
          const writes = [
            'eth_sendTransaction',
            'eth_sendRawTransaction',
            'wallet_sendTransaction',
            'wallet_sendCalls',
            'eth_signTypedData_v4',
            'personal_sign'
          ];
          const mutation = writes.includes(args.method);
          if (mutation) assertCurrent();
          let result: unknown;
          try {
            result = await original.walletClient.request(args);
          } catch (error) {
            if (mutation && !isUserWalletRejection(error) && !isBatchingUnsupported(error)) fenced = true;
            throw error;
          }
          if (
            mutation &&
            ['eth_sendTransaction', 'eth_sendRawTransaction', 'wallet_sendTransaction', 'wallet_sendCalls'].includes(
              args.method
            )
          ) {
            try {
              const id =
                typeof result === 'string'
                  ? result
                  : typeof result === 'object' && result !== null
                    ? Reflect.get(result, 'id')
                    : undefined;
              if (typeof id !== 'string' || id.length === 0 || id.length > 2048)
                throw new Error('Missing Epoch submission identity');
              await hooks.onSubmitted(args.method === 'wallet_sendCalls' ? 'batch' : 'transaction', id);
              assertCurrent();
            } catch (error) {
              fenced = true;
              throw error;
            }
          }
          return result;
        }
      },
      { retryCount: 0 }
    )
  });
  const config = { ...original, walletClient };
  await hooks.beforeExecute({
    requestJson: JSON.stringify(request),
    claimHash,
    resourceLockRequired: quote.resourceLockRequired,
    collateralType,
    executionTransactions: transactions
  });
  assertCurrent();
  if (quote.resourceLockRequired) {
    let depositResult;
    if (collateralType === CollateralType.Miden) {
      const createNote = params.createMidenP2IDENote;
      if (!createNote) throw new Error('Miden collateral requires the createMidenP2IDENote callback');
      const mandate = request.compact.mandate;
      const faucetId = params.midenFaucetId ?? mandate.midenFaucetId;
      const sourceAccount = params.midenSourceAccount ?? mandate.midenSourceAccount;
      validateMidenCollateralInputs({ faucetId, sourceAccount, amount: request.compact.amount });
      if (!faucetId || !sourceAccount) throw new Error('Missing Miden collateral identity');
      const midenConfig = await getMidenCollateralConfig(config);
      const bindingMandate = {
        ...mandate,
        midenSourceAccount: mandate.midenSourceAccount ?? sourceAccount,
        midenFaucetId: mandate.midenFaucetId ?? faucetId,
        midenNoteType: MIDEN_COLLATERAL_NOTE_TYPE
      };
      const felts = encodeMidenMandateBindingToFelts(bindingMandate, witnessTypeString);
      assertCurrent();
      const note = await createNote(
        faucetId,
        request.compact.amount,
        midenConfig.recipientAccountId,
        computeMidenRecallBlocks(midenConfig.minReclaimBlocks, midenConfig.recallBufferBlocks),
        felts
      );
      if (!note.success || !note.noteId) throw new Error('Failed to create P2IDE note');
      request.compact.mandate = { ...bindingMandate, midenNoteId: note.noteId };
      await new Promise(resolve => setTimeout(resolve, 12000));
    } else {
      depositResult = await depositToCompact(config, compactData, claimHash, witnessTypeString, typehash, tokenType);
    }
    const retainedRequest = recoveryCompactRequest.parse(request);
    await hooks.beforeAllocation(JSON.stringify(retainedRequest));
    assertCurrent();
    const result = await sdk.submitAllocation(retainedRequest);
    if (result.nonce !== request.compact.nonce) throw new Error('Epoch allocation nonce mismatch');
    await hooks.onAllocated?.(result.submittedIntentData);
    assertCurrent();
    return { ...result, intentRequestData: request, depositResult, gaslessUsed: false };
  }
  const account = walletClient.account?.address;
  if (!account) throw new Error('Epoch execution account missing');
  const receipts: TransactionReceipt[] = [];
  const reportStatus = (
    transactionIndex: number,
    currentChainId: number,
    update: Pick<TransactionExecutionStatus, 'phase' | 'attempt' | 'remainingMs' | 'error' | 'transactionHash'>
  ) =>
    params.onExecutionStatus?.({
      transactionIndex,
      totalTransactions: transactions.length,
      chainId: currentChainId,
      ...update
    });
  for (const group of groupContiguousByChain(transactions)) {
    const chain: Chain | undefined = SUPPORTED_CHAINS.find(candidate => candidate.id === group.chainId);
    const firstIndex = group.indices[0];
    if (firstIndex === undefined) throw new Error('Empty Epoch execution group');
    if (!chain) throw new Error(`Unsupported Epoch chain ${group.chainId}`);
    if (walletClient.chain?.id !== chain.id) {
      reportStatus(firstIndex, chain.id, { phase: 'switching-chain' });
      await walletClient.switchChain({ id: chain.id });
    }
    const publicClient = createPublicClient({ chain, transport: http(chain.rpcUrls.default.http[0] ?? '') });
    const strategy = await resolveWalletBatchStrategy({ walletClient, chainId: chain.id, user: account, publicClient });
    if (strategy.mode !== 'sequential-tx' && group.items.length > 1) {
      for (const index of group.indices) {
        reportStatus(index, chain.id, { phase: 'starting' });
        reportStatus(index, chain.id, { phase: 'batching' });
      }
      reportStatus(firstIndex, chain.id, { phase: 'sending' });
      try {
        const batch = await executeWalletBatch({
          walletClient,
          chainId: chain.id,
          account,
          forceAtomic: strategy.mode === 'atomic',
          calls: group.items.map(tx => ({ to: tx.target, data: tx.callData, value: BigInt(tx.value) }))
        });
        const legs = mapBundleReceiptsToLegs(batch, group.items.length);
        legs.forEach((receipt, index) => {
          const transactionIndex = group.indices[index];
          if (transactionIndex === undefined) throw new Error('Missing Epoch execution index');
          reportStatus(transactionIndex, chain.id, { phase: 'sent', transactionHash: receipt.transactionHash });
        });
        receipts.push(...legs);
        continue;
      } catch (error) {
        if (fenced || isUserWalletRejection(error)) throw error;
      }
    }
    for (const [leg, transaction] of group.items.entries()) {
      const index = group.indices[leg];
      if (index === undefined) throw new Error('Missing Epoch execution index');
      const tx = {
        to: transaction.target,
        data: transaction.callData,
        value: BigInt(transaction.value),
        account,
        chain
      };
      reportStatus(index, chain.id, { phase: 'starting' });
      await waitUntilTransactionSimulates(chain, tx, account, {
        onStatus: update => reportStatus(index, chain.id, update)
      });
      reportStatus(index, chain.id, { phase: 'sending' });
      assertCurrent();
      const receipt = await walletClient.sendTransactionSync({ ...tx, timeout: TRANSACTION_RECEIPT_TIMEOUT_MS });
      receipts.push(receipt);
      reportStatus(index, chain.id, { phase: 'sent', transactionHash: receipt.transactionHash });
    }
  }
  const mandate = request.compact.mandate;
  const fill = {
    nonce: request.compact.nonce,
    external: true,
    routing: params.routingAndLiquidityOptions,
    user: params.sponsorAddress,
    tokenInAddress: mandate.tokenIn,
    tokenInAmount: params.quoteResult?.tokenIn ?? request.compact.amount,
    tokenOutAddress: mandate.tokenOut,
    tokenOutAmount: params.quoteResult?.tokenOut,
    minTokenOut: mandate.minTokenOut,
    transactionHashes: receipts.map(receipt => receipt.transactionHash),
    chainIds: [chainId, Number(mandate.destinationChainId)],
    originChainId: chainId,
    destinationChainId: Number(mandate.destinationChainId)
  };
  try {
    params.onIntentFilled?.(fill);
  } catch {
    /* Analytics cannot change confirmed execution. */
  }
  void apiFetch(config, '/reportFill', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(fill)
  }).catch(() => {});
  return {
    transactions: transactions.map(tx => ({ to: tx.target, data: tx.callData, value: tx.value })),
    receipts,
    nonce: request.compact.nonce
  };
}
