import * as Repo from 'lib/miden/repo';

import {
  GcClaimContext,
  GcClaimEvidence,
  assertGcClaimIdentity,
  gcClaimAccount,
  gcClaimHistoryTransactionId,
  gcClaimTransactionId,
  gcClaimU32,
  gcClaimWord,
  normalizeGcClaimContext
} from './gc-claim-operation';

function normalizeEvidence(input: GcClaimEvidence): GcClaimEvidence {
  const anchor = {
    genesisCommitment: gcClaimWord(input.genesisCommitment),
    blockNumber: gcClaimU32(input.blockNumber),
    blockCommitment: gcClaimWord(input.blockCommitment),
    accountId: gcClaimAccount(input.accountId)
  };
  switch (input.kind) {
    case 'issued':
      if (
        input.gcAmount !== 10_000_000n ||
        typeof input.nativeRefund !== 'bigint' ||
        input.nativeRefund < 0n ||
        typeof input.issuerFee !== 'bigint' ||
        input.issuerFee < 0n
      )
        throw new Error('Invalid GC issuance amounts');
      return {
        ...anchor,
        kind: 'issued',
        ...(input.transactionId === undefined ? {} : { transactionId: gcClaimWord(input.transactionId) }),
        requestNoteId: gcClaimWord(input.requestNoteId),
        requestNullifier: gcClaimWord(input.requestNullifier),
        issuerId: gcClaimAccount(input.issuerId),
        receiptNoteId: gcClaimWord(input.receiptNoteId),
        receiptRecipientCommitment: gcClaimWord(input.receiptRecipientCommitment),
        gcAmount: input.gcAmount,
        nativeRefund: input.nativeRefund,
        issuerFee: input.issuerFee
      };
    case 'delivered':
      return {
        ...anchor,
        kind: 'delivered',
        transactionId: gcClaimWord(input.transactionId),
        receiptNoteId: gcClaimWord(input.receiptNoteId),
        receiptNullifier: gcClaimWord(input.receiptNullifier)
      };
    case 'reclaimed':
      return {
        ...anchor,
        kind: 'reclaimed',
        transactionId: gcClaimWord(input.transactionId),
        requestNoteId: gcClaimWord(input.requestNoteId),
        requestNullifier: gcClaimWord(input.requestNullifier),
        referenceBlock: gcClaimU32(input.referenceBlock)
      };
    default:
      throw new Error('Unsupported GC claim evidence');
  }
}

function sameEvidence(left: GcClaimEvidence, right: GcClaimEvidence): boolean {
  const serialize = (value: GcClaimEvidence) =>
    JSON.stringify(value, (_key, entry) => (typeof entry === 'bigint' ? entry.toString() : entry));
  if (left.kind === 'issued' && right.kind === 'issued') {
    if (
      left.transactionId !== undefined &&
      right.transactionId !== undefined &&
      left.transactionId !== right.transactionId
    )
      return false;
    return serialize({ ...left, transactionId: undefined }) === serialize({ ...right, transactionId: undefined });
  }
  return serialize(left) === serialize(right);
}

/**
 * Backend-only admission of ALREADY VERIFIED chain facts. This function checks linkage and stores
 * evidence atomically; it does not verify cryptographic proofs or trust frontend assertions.
 */
export async function recordGcClaimEvidence(
  context: GcClaimContext,
  transactionId: string,
  input: GcClaimEvidence
): Promise<void> {
  const snapshot = { ...input };
  const identity = await normalizeGcClaimContext(context);
  const evidence = normalizeEvidence(snapshot);
  if (evidence.genesisCommitment !== identity.genesisCommitment || evidence.accountId !== identity.accountId) {
    throw new Error('GC evidence does not match the active backend identity');
  }
  await Repo.db.transaction('rw', Repo.transactions, async () => {
    const row = await Repo.transactions.get(transactionId);
    const operation = row?.gcClaim;
    if (row === undefined || operation === undefined || row.restoredFromBackup === true) {
      throw new Error('GC claim operation unavailable');
    }
    assertGcClaimIdentity(operation, identity);
    if (
      (operation.recoveredHistory
        ? gcClaimHistoryTransactionId(operation)
        : gcClaimTransactionId(operation.scope, operation.attempt ?? 0)) !== transactionId
    )
      throw new Error('GC claim transaction identity collision');
    switch (evidence.kind) {
      case 'issued':
        if (
          operation.reclaim !== undefined ||
          evidence.requestNoteId !== operation.requestNoteId ||
          evidence.issuerId !== operation.scope.issuerId ||
          evidence.receiptRecipientCommitment !== operation.receiptRecipientCommitment ||
          evidence.nativeRefund + evidence.issuerFee !== operation.nativeBudget ||
          (operation.issuance !== undefined && !sameEvidence(operation.issuance, evidence))
        )
          throw new Error('GC issuance evidence conflicts with its operation');
        operation.issuance = {
          ...evidence,
          ...(evidence.transactionId !== undefined || operation.issuance?.transactionId !== undefined
            ? { transactionId: evidence.transactionId ?? operation.issuance?.transactionId }
            : {})
        };
        break;
      case 'delivered':
        if (
          operation.issuance === undefined ||
          operation.reclaim !== undefined ||
          evidence.receiptNoteId !== operation.issuance.receiptNoteId ||
          evidence.blockNumber < operation.issuance.blockNumber ||
          (operation.delivery !== undefined && !sameEvidence(operation.delivery, evidence))
        )
          throw new Error('GC delivery evidence is not linked to an issued receipt');
        operation.delivery = evidence;
        break;
      case 'reclaimed':
        if (
          operation.issuance !== undefined ||
          operation.delivery !== undefined ||
          evidence.requestNoteId !== operation.requestNoteId ||
          evidence.referenceBlock < operation.reclaimHeight ||
          evidence.referenceBlock >= evidence.blockNumber ||
          (operation.reclaim !== undefined && !sameEvidence(operation.reclaim, evidence))
        )
          throw new Error('GC reclaim evidence conflicts with its operation or cutoff');
        operation.reclaim = evidence;
        break;
    }
    await Repo.transactions.update(transactionId, { gcClaim: operation });
  });
}
