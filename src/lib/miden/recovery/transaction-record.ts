import { z } from 'zod';

import { earnWithdrawExecutionIdentity, validateEarnWithdrawPreparedExecution } from 'lib/epoch/earn-withdraw-policy';

import {
  recoveryOneClick,
  recoveryPreparedExecution,
  recoveryEpochExecution,
  recoveryUsdcxSource
} from './provider-record';
import { toSerializable } from './serialization';
import { ITransaction, ITransactionStatus } from '../db/types';

const text = z.string().min(1).max(2048);
const time = z.number().int().nonnegative().safe();
const amount = z.bigint().nonnegative();
const words = z.array(text).max(256);
const asset = z.object({ faucetId: text, amount });
const evidence = z.object({
  attemptId: text,
  capturedAt: time,
  source: z.enum(['stage', 'pin', 'kill', 'out-of-band', 'end', 'error-text']),
  transactionId: text.optional(),
  initialCommitment: text.optional(),
  finalCommitment: text.optional(),
  initialNonce: text.optional(),
  outputNoteIds: words.optional(),
  nullifiers: words.optional(),
  refBlock: time.optional(),
  refBlockCommitment: text.optional(),
  expirationBlock: time.optional(),
  guardianProposalNonce: time.optional(),
  candidateKept: z.literal(true).optional(),
  initialSeenAtBlock: time.optional(),
  otherNetworkSince: time.optional(),
  landingSeenAtBlock: time.optional(),
  landingSeenBy: z.union([z.literal(1), z.literal(2), z.literal(3)]).optional(),
  verdict: z.enum(['never-committed', 'unresolvable']).optional(),
  neverCommittedBy: z.enum(['expired', 'superseded', 'spent_elsewhere']).optional(),
  endedBy: z.enum(['kill', 'out-of-band']).optional(),
  endedAt: time.optional(),
  preSubmitEnd: z.literal(true).optional(),
  raisedFlag: z.literal(true).optional(),
  fromExecute: z.literal(true).optional()
});
const receipt = z.object({
  epochExecution: recoveryEpochExecution.optional(),
  sourceSubmission: z.enum(['not-started', 'attempted', 'known']).optional(),
  provider: z.enum(['epoch', 'agglayer', 'usdcx', 'near-intents']).optional(),
  destinationAddress: text.optional(),
  destinationNetwork: time.optional(),
  sourceFaucetId: text.optional(),
  claimStatus: z.enum(['not-applicable', 'pending', 'ready', 'claiming', 'claimed', 'failed']).optional(),
  depositReady: z.boolean().optional(),
  claimTxHash: text.optional(),
  agglayerExitTxHash: text.optional(),
  agglayerExitTxHashUnavailable: z.literal(true).optional(),
  agglayerExitUnfiled: z.literal(true).optional(),
  agglayerDepositCnt: time.optional(),
  evmTxHash: text.optional(),
  recallBlocks: time.optional(),
  reclaimHeight: time.optional(),
  reclaimNoteId: text.optional(),
  submitClaimed: z.boolean().optional(),
  intentNonce: text.optional(),
  outputAmount: text.optional(),
  outputSymbol: text.optional(),
  fillTxHash: text.optional(),
  fillChainId: time.optional(),
  epochStatus: z.enum(['pending', 'confirmed', 'failed']).optional(),
  epochAllocatorUrl: text.optional(),
  sourceAddress: text.optional(),
  sourceAmount: text.optional(),
  sourceSymbol: text.optional(),
  sourceChainId: time.optional(),
  midenNoteId: text.optional(),
  phase: text.optional(),
  usdcxRemoteRecipient: text.optional(),
  usdcxMidenDomain: time.optional(),
  readyAt: time.optional(),
  evmRecipient: text.optional(),
  evmOwner: text.optional(),
  marketUid: text.optional(),
  destinationFaucetId: text.optional(),
  protocol: text.optional(),
  chainId: time.optional(),
  withdrawIntentNonce: text.optional(),
  reviewedMinimumReceivedAtomic: text.optional(),
  underlyingAddress: text.optional(),
  sourceDecimals: z.number().int().min(0).max(38).optional(),
  submissionAttemptId: text.optional(),
  attemptStartedAt: time.optional(),
  submissionState: z.enum(['preparing', 'prepared', 'accepted']).optional(),
  preparedExecution: recoveryPreparedExecution.optional(),
  requestedFaucetId: text.optional(),
  requestedAmount: amount.optional(),
  previousGuardianEndpoint: text.optional(),
  newGuardianEndpoint: text.optional(),
  switchProposalId: text.optional(),
  switchProposalNonce: time.optional(),
  switchDeltaPushed: z.boolean().optional(),
  registerFailed: z.boolean().optional(),
  endpointPersistFailed: z.boolean().optional(),
  switchedDirectly: z.boolean().optional(),
  commitUnconfirmed: z.boolean().optional(),
  localStateNotSaved: z.boolean().optional(),
  localStateUnrecoverable: z.boolean().optional(),
  agglayerDelivery: z
    .object({ originToken: text, faucetId: text.optional(), scale: time.optional() })
    .strict()
    .optional(),
  usdcxSource: recoveryUsdcxSource.optional(),
  agglayerRoute: z
    .object({
      chainId: time,
      contractAddress: text,
      midenBridgeId: text,
      indexerUrl: text,
      rollupId: time,
      evmNetworkId: time,
      nativeEthFaucetId: text.optional(),
      nativeEthScale: time.optional()
    })
    .optional(),
  cctp: z
    .object({
      sourceDomain: time,
      message: z.string().max(100000).optional(),
      attestation: z.string().max(100000).optional(),
      executeTxHash: text.optional(),
      executeSavedAt: time.optional(),
      executeSubmission: z.enum(['not-started', 'attempted', 'known']).optional(),
      stalledExecuteTxHash: text.optional(),
      revertedExecuteTxHash: text.optional(),
      revertedAt: time.optional(),
      forwarded: z.boolean().optional(),
      forwardFee: text.optional(),
      forwardState: text.optional()
    })
    .optional(),
  usdcxBurn: z
    .object({
      noteId: text,
      destinationDomain: time,
      destinationUsdc: text.optional(),
      payoutFeeAllowance: text.optional(),
      phase: z.enum(['pending', 'consuming', 'confirmed', 'discarded']),
      destinationBalanceBefore: z.object({ balance: text, blockNumber: text }).optional(),
      destinationBalanceConfirmed: z.object({ balance: text, blockNumber: text }).optional(),
      payout: z.object({ transactionHash: text, blockNumber: text, value: text }).optional(),
      payoutScannedBlock: text.optional(),
      confirmedAt: time.optional(),
      attemptCount: time.optional(),
      lastAttemptBlockNum: time.optional()
    })
    .optional(),
  bridgeIn: z
    .object({
      provider: z.enum(['epoch', 'agglayer', 'usdcx', 'near-intents']),
      sourceAmount: text.optional(),
      sourceSymbol: text.optional(),
      sourceToken: text.optional(),
      intentNonce: text.optional(),
      intentOwner: text.optional(),
      earnWithdrawAttemptId: text.optional(),
      epochAllocatorUrl: text.optional(),
      evmTxHash: text.optional(),
      midenNoteId: text.optional(),
      earnWithdrawTxId: text.optional(),
      bridgeReceiveTxId: text.optional()
    })
    .strict()
    .optional(),
  swapOrderTxId: text.optional(),
  swapSettleKind: z.enum(['settle', 'reclaim']).optional(),
  swapSettlePartial: z.boolean().optional(),
  oneClick: recoveryOneClick.optional()
});
const schema = z.object({
  id: text,
  accountId: text,
  type: z.enum([
    'send',
    'consume',
    'execute',
    'bridged-send',
    'bridged-receive',
    'earn-deposit',
    'earn-withdraw',
    'switch-guardian',
    'replace-hot-key',
    'swap',
    'update-procedure-threshold'
  ]),
  status: z.nativeEnum(ITransactionStatus),
  initiatedAt: time,
  displayIcon: z.enum(['SEND', 'RECEIVE', 'SWAP', 'FAILED', 'MINT', 'DEFAULT']),
  amount: amount.optional(),
  secondaryAccountId: text.optional(),
  faucetId: z.string().max(2048).optional(),
  noteId: text.optional(),
  noteIds: words.optional(),
  noteType: z.enum(['public', 'private']).optional(),
  assetTotals: z.array(asset).max(256).optional(),
  spentAssetTotals: z.array(asset).max(256).optional(),
  spentUsd: amount.optional(),
  spendingLimitAuthorizationId: text.optional(),
  transactionId: text.optional(),
  feeAmount: amount.optional(),
  feeFaucetId: text.optional(),
  requestBytes: z.instanceof(Uint8Array).optional(),
  inputNoteIds: words.optional(),
  outputNoteIds: words.optional(),
  heldNoteIds: words.optional(),
  completedAt: time.optional(),
  mayHaveSubmitted: z.boolean().optional(),
  attemptId: text.optional(),
  neverCommittedAt: time.optional(),
  submitEvidence: z.array(evidence).max(256).optional(),
  noteDelivery: z.enum(['pending', 'relayed', 'confirmed', 'undelivered']).optional(),
  relayNoteIds: words.optional(),
  restoredFromBackup: z.boolean().optional(),
  restoredFromJournal: z.literal(true).optional(),
  extraInputs: receipt.optional()
});

export type RecoveryTransactionRow = z.infer<typeof schema>;

export function projectRecoveryTransaction(row: ITransaction, requestBytes?: Uint8Array): RecoveryTransactionRow {
  const projected = schema.parse({ ...row, requestBytes: requestBytes ?? row.requestBytes });
  validateProviderIdentity(projected);
  return projected;
}

function validateProviderIdentity(row: RecoveryTransactionRow): void {
  const inputs = row.extraInputs;
  if (inputs?.preparedExecution) {
    const identity = earnWithdrawExecutionIdentity(row);
    if (
      !identity ||
      !validateEarnWithdrawPreparedExecution(inputs.preparedExecution, identity) ||
      inputs.withdrawIntentNonce !== inputs.preparedExecution.delivery.nonce
    )
      throw new Error('Invalid recovery withdrawal identity');
  }
  if (inputs?.oneClick && inputs.oneClick.accountId !== row.accountId)
    throw new Error('Invalid recovery quote account');
}

export function validateRecoveryReceipt(value: unknown): RecoveryTransactionRow {
  const row = validateRecoveryTransaction(value);
  const provider = row.extraInputs?.provider;
  if (
    row.type !== 'earn-withdraw' &&
    row.type !== 'earn-deposit' &&
    !row.extraInputs?.oneClick &&
    !(['bridged-receive', 'bridged-send', 'earn-deposit'].includes(row.type) && provider)
  )
    throw new Error('Invalid recovery receipt type');
  return row;
}

function ordered(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(ordered);
  if (typeof value !== 'object' || value === null) return value;
  return Object.fromEntries(
    Object.keys(value)
      .sort()
      .map(key => [key, ordered(Reflect.get(value, key))])
  );
}

export function sameRecoveryProviderInputs(
  left: RecoveryTransactionRow['extraInputs'],
  right: RecoveryTransactionRow['extraInputs']
): boolean {
  const stable = (inputs: RecoveryTransactionRow['extraInputs']) =>
    inputs?.oneClick ? { ...inputs, oneClick: { ...inputs.oneClick, updatedAt: undefined } } : inputs;
  return sameRecoveryFields(stable(left), stable(right));
}

export function sameRecoveryFields(left: unknown, right: unknown): boolean {
  return JSON.stringify(ordered(toSerializable(left))) === JSON.stringify(ordered(toSerializable(right)));
}

export function validateRecoveryTransaction(value: unknown): RecoveryTransactionRow {
  const parsed = schema.parse(value);
  validateProviderIdentity(parsed);
  if (JSON.stringify(ordered(toSerializable(value))) !== JSON.stringify(ordered(toSerializable(parsed))))
    throw new Error('Invalid recovery transaction fields');
  return parsed;
}
