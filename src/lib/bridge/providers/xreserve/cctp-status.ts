// Adapted from bridge-portal@cb52c470 src/bridge/providers/xreserve/cctp-status.ts (MIT).
import { isAddress, isHash, isHex, parseUnits, type Hex } from 'viem';

import { configKey } from 'lib/bridge/core/routes';
import { bridgeOperationOf, findAdmittedBridgeOperation } from 'lib/bridge/operation';
import type { IBridgedReceiveExtraInputs, ITransaction } from 'lib/miden/db/types';
import { updateBridgedReceivePhase } from 'lib/miden/transaction/complete';
import { fetchCctpMessages, type AttestedCctpMessage } from 'lib/usdcx/cctp';
import type { UsdcxExecutorSource } from 'lib/usdcx/constant';
import { usdcxExpectedRemoteTokenFor, usdcxRemoteRecipientFor } from 'lib/usdcx/deposit-target';
import { encodeExecutorHookData } from 'lib/usdcx/executor';
import { EvmTransactionRevertedError, readEvmReceiptOutcome } from 'lib/walletconnect/receipt';

import {
  assertCctpArcReceipt,
  assertCctpSourceMessage,
  matchesCctpSourceMessage,
  sourceMessageFromReceipt,
  type CctpReceipt
} from './cctp-message';
import { recordCctpSourceFacts } from './ownership';

/** Missing tagged provenance is proof-pending, never the legacy observation path or new consent. */
export function ownedCctpSourceProof(row: ITransaction, source: UsdcxExecutorSource): Hex | undefined {
  const operation = bridgeOperationOf(row);
  const leg = row.extraInputs?.cctp;
  const raw = leg?.sourceMessage;
  if (
    !operation ||
    row.restoredFromBackup ||
    row.recovered ||
    !isHex(raw) ||
    !source.tokenMessenger ||
    typeof leg?.messageTransmitter !== 'string' ||
    !isAddress(leg.messageTransmitter) ||
    /^0x0{40}$/i.test(leg.messageTransmitter) ||
    !operation.sourceAttempt?.hash ||
    operation.sourceAttempt.hash !== row.extraInputs?.evmTxHash
  )
    return undefined;
  const { review } = operation;
  const account = `0x${review.accounts.evmAddress.slice(2)}` satisfies `0x${string}`;
  try {
    assertCctpSourceMessage(
      raw,
      source,
      parseUnits(review.amount, 6),
      encodeExecutorHookData(source.target, usdcxRemoteRecipientFor(review.accounts.midenAccount), account)
    );
    return raw;
  } catch {
    return undefined;
  }
}

/** Bind a receipt or Iris observation to the source and leg read before the network await. */
export function cctpSourceStillCurrent(expected: ITransaction, row: ITransaction): boolean {
  const original = bridgeOperationOf(expected);
  const current = bridgeOperationOf(row);
  const hash = original?.sourceAttempt?.hash;
  const inputs: IBridgedReceiveExtraInputs | undefined = row.extraInputs;
  return (
    row.id === expected.id &&
    row.type === 'bridged-receive' &&
    !row.restoredFromBackup &&
    !row.recovered &&
    original !== undefined &&
    current?.operationId === original.operationId &&
    current.revision === original.revision &&
    hash !== undefined &&
    isHash(hash) &&
    current.sourceAttempt?.phase === 'known' &&
    current.sourceAttempt.hash === hash &&
    inputs?.evmTxHash === hash &&
    inputs.provider === 'usdcx' &&
    inputs.sourceChainId === expected.extraInputs?.sourceChainId &&
    configKey(inputs.usdcxSource) === configKey(expected.extraInputs?.usdcxSource) &&
    (inputs.phase === 'submitting' || inputs.phase === 'delivering') &&
    configKey(inputs.cctp) === configKey(expected.extraInputs?.cctp)
  );
}

export async function recoverOwnedCctpSourceProof(row: ITransaction, source: UsdcxExecutorSource): Promise<void> {
  const operation = bridgeOperationOf(row);
  const inputs = row.extraInputs;
  const leg = inputs?.cctp;
  const hash = inputs?.evmTxHash;
  const transmitter = leg?.messageTransmitter;
  const review = operation?.review;
  const sourceChain = review?.route.recovery.config.supportedEvmChains[review.route.source.network];
  const sourceRoute = sourceChain?.bridges.usdcx;
  const deposit = sourceRoute?.deposit;
  const targetChain =
    deposit?.route === 'executor' ? review?.route.recovery.config.supportedEvmChains[deposit.executorChain] : undefined;
  const targetRoute = targetChain?.bridges.usdcx;
  if (
    !operation ||
    !review ||
    row.restoredFromBackup ||
    row.recovered ||
    inputs?.provider !== 'usdcx' ||
    (inputs.phase !== 'submitting' && inputs.phase !== 'delivering') ||
    inputs.usdcxSource?.route !== 'cctp-executor' ||
    inputs.sourceChainId !== source.chain.id ||
    !isHash(hash) ||
    operation.sourceAttempt?.phase !== 'known' ||
    operation.sourceAttempt.hash !== hash ||
    leg?.sourceMessage !== undefined ||
    leg?.sourceDomain !== source.domain ||
    typeof transmitter !== 'string' ||
    !isAddress(transmitter) ||
    /^0x0{40}$/i.test(transmitter) ||
    !source.tokenMessenger ||
    review.route.provider !== 'xreserve' ||
    review.route.mode !== 'receive' ||
    review.route.source.kind !== 'erc20' ||
    review.route.destination.kind !== 'miden' ||
    review.quote?.kind !== 'cctp' ||
    row.accountId !== review.accounts.midenAccount ||
    row.faucetId !== review.route.destination.faucetId ||
    row.amount !== parseUnits(review.amount, 6) ||
    inputs.sourceAddress.toLowerCase() !== review.accounts.evmAddress.toLowerCase() ||
    sourceChain?.chainId !== source.chain.id ||
    sourceRoute?.domain !== source.domain ||
    sourceRoute.tokens.USDC?.contractAddress.toLowerCase() !== source.usdc.toLowerCase() ||
    review.route.source.address.toLowerCase() !== source.usdc.toLowerCase() ||
    deposit?.route !== 'executor' ||
    deposit.tokenMessenger?.toLowerCase() !== source.tokenMessenger.toLowerCase() ||
    deposit.tokenMessengerWithFees.toLowerCase() !== source.tokenMessengerWithFees.toLowerCase() ||
    targetChain?.chainId !== source.target.chain.id ||
    targetRoute?.domain !== source.target.domain ||
    targetRoute.executor?.address.toLowerCase() !== source.target.executor.toLowerCase() ||
    targetRoute.executor.handler.toLowerCase() !== source.target.handler.toLowerCase() ||
    targetRoute.deposit?.route !== 'xreserve' ||
    targetRoute.deposit.xReserve.toLowerCase() !== source.target.xReserve.toLowerCase() ||
    targetRoute.tokens.USDC?.contractAddress.toLowerCase() !== source.target.usdc.toLowerCase()
  )
    return;
  const admitted = await findAdmittedBridgeOperation(operation);
  if (admitted?.id !== row.id || bridgeOperationOf(admitted)?.revision !== operation.revision) return;
  let sourceMessage: Hex | undefined;
  const outcome = await readEvmReceiptOutcome(hash, source.chain, receipt => {
    const message = sourceMessageFromReceipt(receipt, hash, transmitter);
    const account = `0x${review.accounts.evmAddress.slice(2)}` satisfies `0x${string}`;
    assertCctpSourceMessage(
      message,
      source,
      parseUnits(review.amount, 6),
      encodeExecutorHookData(source.target, usdcxRemoteRecipientFor(review.accounts.midenAccount), account)
    );
    sourceMessage = message;
  });
  if (outcome === 'success' && sourceMessage) {
    await recordCctpSourceFacts({ rowId: row.id, operation }, { messageTransmitter: transmitter, sourceMessage }, hash);
  } else if (outcome === 'reverted') {
    const cause = new EvmTransactionRevertedError(source.chain.name);
    await updateBridgedReceivePhase(
      row.id,
      'failed',
      { error: cause.message, failure: { step: 'reconciler_receipt', cause } },
      undefined,
      { canUpdate: current => cctpSourceStillCurrent(row, current) }
    );
  }
}

export async function fetchOwnedAttestedCctpMessage(
  row: ITransaction,
  source: UsdcxExecutorSource,
  original: Hex
): Promise<AttestedCctpMessage | undefined> {
  const hash = row.extraInputs?.evmTxHash;
  if (!isHash(hash)) return undefined;
  const candidates = (await fetchCctpMessages(source.domain, hash, { baseUrl: source.irisApi })).filter(
    entry =>
      entry.status === 'complete' &&
      entry.attestation !== 'PENDING' &&
      matchesCctpSourceMessage(original, entry.message)
  );
  if (candidates.length !== 1) return undefined;
  const candidate = candidates[0];
  if (!candidate || candidate.attestation === 'PENDING') return undefined;
  return { ...candidate, attestation: candidate.attestation };
}

export function assertOwnedCctpArcReceipt(
  row: ITransaction,
  source: UsdcxExecutorSource,
  original: Hex,
  hash: Hex,
  receipt: CctpReceipt
): void {
  const message = row.extraInputs?.cctp?.message;
  if (!isHex(message) || !row.faucetId || row.amount === undefined) throw new Error('Circle execution proof pending');
  assertCctpArcReceipt(receipt, hash, source, original, message, {
    amount: row.amount,
    recipient: usdcxRemoteRecipientFor(row.accountId),
    token: usdcxExpectedRemoteTokenFor(row.faucetId)
  });
}
