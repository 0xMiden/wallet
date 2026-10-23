import { ITransaction, ITransactionStatus, Transaction } from 'lib/miden/db/types';
import * as Repo from 'lib/miden/repo';
import { queueOutgoingTransaction } from 'lib/miden/spending-limits/queue';
import type { SpendingLimitAuthorization } from 'lib/miden/spending-limits/types';

import {
  ApprovedGcClaimOperation,
  GcClaimContext,
  GcClaimOperation,
  GcClaimPhase,
  PreparedGcClaim,
  RecoveredGcClaimOperation,
  assertGcClaimIdentity,
  gcClaimAccount,
  gcClaimBindingKey,
  gcClaimHistoryTransactionId,
  gcClaimPhase,
  gcClaimTransactionId,
  gcClaimU32,
  gcClaimWord,
  normalizeGcClaimContext
} from './gc-claim-operation';
import type { GcClaimHistoryPage } from './gc-claim-reconcile';

const MAX_ATTEMPTS = 32;
const MAX_SCOPE_ROWS = 128;

export interface QueuedGcClaim {
  transactionId: string;
  created: boolean;
  phase: GcClaimPhase;
}

export interface StoredGcClaim {
  transaction: ITransaction;
  phase: GcClaimPhase;
}

function validateRow(row: ITransaction, identity: GcClaimContext): GcClaimOperation {
  const operation = row.gcClaim;
  if (!operation) throw new Error('GC claim transaction identity collision');
  assertGcClaimIdentity(operation, identity);
  const id = operation.recoveredHistory
    ? gcClaimHistoryTransactionId(operation)
    : gcClaimTransactionId(operation.scope, operation.attempt ?? 0);
  if (row.id !== id || gcClaimAccount(row.accountId) !== identity.accountId)
    throw new Error('GC claim transaction identity collision');
  return operation;
}

/** Database-only: safe inside the spending-limit queue's existing write lock. */
async function scopeRows(identity: GcClaimContext, week?: number): Promise<ITransaction[]> {
  const rows = await Repo.transactions
    .where('accountId')
    .equals(identity.accountId)
    .filter(
      row =>
        row.gcClaim?.scope?.genesisCommitment === identity.genesisCommitment &&
        row.gcClaim.scope.issuerId === identity.issuerId &&
        gcClaimBindingKey(row.gcClaim.scope) === gcClaimBindingKey(identity) &&
        (week === undefined || row.gcClaim.scope.approvedWeek === week)
    )
    .limit(MAX_SCOPE_ROWS + 1)
    .toArray();
  if (rows.length > MAX_SCOPE_ROWS) throw new Error('GC recovery inventory exceeds the bounded read limit');
  for (const row of rows) validateRow(row, identity);
  if (week !== undefined) {
    const known = new Set<string>();
    let previous: ITransaction | undefined;
    // Contiguous primary-key reads detect scope collisions and never follow unbounded links.
    for (let attempt = 0; attempt <= MAX_ATTEMPTS; attempt++) {
      const id = gcClaimTransactionId({ ...identity, approvedWeek: week }, attempt);
      const row = await Repo.transactions.get(id);
      if (!row) break;
      if (attempt === MAX_ATTEMPTS) throw new Error('GC claim attempt limit reached');
      const operation = validateRow(row, identity);
      if (
        operation.recoveredHistory ||
        (operation.attempt ?? 0) !== attempt ||
        (previous && operation.previousRequestNoteId !== previous.gcClaim?.requestNoteId)
      ) {
        throw new Error('GC claim attempt history is not contiguous');
      }
      known.add(id);
      previous = row;
    }
    if (rows.some(row => row.gcClaim?.recoveredHistory !== true && !known.has(row.id))) {
      throw new Error('GC claim attempt history is incomplete');
    }
  }
  return rows;
}

function preferred(rows: ITransaction[]): ITransaction | undefined {
  const rank: Record<GcClaimPhase, number> = {
    delivered: 5,
    'awaiting-receipt': 4,
    pending: 3,
    reclaimed: 2,
    retryable: 1
  };
  return [...rows].sort(
    (left, right) =>
      rank[gcClaimPhase(right)] - rank[gcClaimPhase(left)] ||
      (right.gcClaim?.attempt ?? -1) - (left.gcClaim?.attempt ?? -1) ||
      left.initiatedAt - right.initiatedAt
  )[0];
}

function result(row: ITransaction, created = false): QueuedGcClaim {
  return { transactionId: row.id, created, phase: gcClaimPhase(row) };
}

async function prepare(context: GcClaimContext, prepared: PreparedGcClaim) {
  const input = {
    ...prepared,
    scope: {
      ...prepared.scope,
      ...(prepared.scope.distribution === undefined ? {} : { distribution: { ...prepared.scope.distribution } })
    },
    requestBytes: new Uint8Array(prepared.requestBytes)
  };
  const identity = await normalizeGcClaimContext(context);
  const operation: ApprovedGcClaimOperation = {
    version: input.scope.distribution?.protocolVersion ?? 1,
    scope: {
      ...(input.scope.distribution === undefined ? {} : { distribution: { ...input.scope.distribution } }),
      genesisCommitment: gcClaimWord(input.scope.genesisCommitment),
      accountId: gcClaimAccount(input.scope.accountId),
      issuerId: gcClaimAccount(input.scope.issuerId),
      approvedWeek: gcClaimU32(input.scope.approvedWeek)
    },
    issuerCodeCommitment: gcClaimWord(input.issuerCodeCommitment),
    nativeAssetId: gcClaimAccount(input.nativeAssetId),
    requestNoteId: gcClaimWord(input.requestNoteId),
    receiptRecipientCommitment: gcClaimWord(input.receiptRecipientCommitment),
    nativeBudget: input.nativeBudget,
    outgoingNativeAmount: input.outgoingNativeAmount,
    approvalExpiresAt: gcClaimU32(input.approvalExpiresAt),
    reclaimHeight: gcClaimU32(input.reclaimHeight)
  };
  assertGcClaimIdentity(operation, identity);
  if (
    typeof operation.nativeBudget !== 'bigint' ||
    operation.nativeBudget <= 0n ||
    typeof operation.outgoingNativeAmount !== 'bigint' ||
    operation.outgoingNativeAmount < operation.nativeBudget ||
    operation.reclaimHeight === 0 ||
    input.requestBytes.length === 0
  )
    throw new Error('Invalid funded GC claim');
  return { identity, operation, requestBytes: input.requestBytes };
}

async function insertApproved(
  identity: GcClaimContext,
  operation: ApprovedGcClaimOperation,
  bytes: Uint8Array,
  authorization: SpendingLimitAuthorization | undefined,
  admit: () => Promise<void>
): Promise<QueuedGcClaim> {
  const now = Math.floor(Date.now() / 1000);
  if (operation.approvalExpiresAt <= now) throw new Error('GC claim approval expired');
  const spends = [{ faucetId: operation.nativeAssetId, amount: operation.outgoingNativeAmount }];
  const transaction = new Transaction(identity.accountId, bytes, undefined, false, identity.issuerId, spends);
  transaction.id = gcClaimTransactionId(operation.scope, operation.attempt ?? 0);
  const row = { ...transaction, gcClaim: operation };
  // Price resolution remains outside the write lock. Admission, spend stamp, bytes and metadata
  // share the queue's one write transaction; an admission failure rolls back the entire insert.
  await queueOutgoingTransaction(row, spends, authorization, now, async () => {
    if (operation.approvalExpiresAt <= Math.floor(Date.now() / 1000)) throw new Error('GC claim approval expired');
    await admit();
  });
  return result(row, true);
}

export async function queuePreparedGcClaim(
  context: GcClaimContext,
  prepared: PreparedGcClaim,
  authorization?: SpendingLimitAuthorization
): Promise<QueuedGcClaim> {
  const { identity, operation, requestBytes } = await prepare(context, prepared);
  const rows = await scopeRows(identity, operation.scope.approvedWeek);
  const existing = preferred(rows);
  if (existing) return result(existing);
  try {
    return await insertApproved(identity, { ...operation, attempt: 0 }, requestBytes, authorization, async () => {
      if ((await scopeRows(identity, operation.scope.approvedWeek)).length !== 0)
        throw new Error('GC claim already queued');
    });
  } catch (error) {
    const winner = preferred(await scopeRows(identity, operation.scope.approvedWeek));
    if (winner) return result(winner);
    throw error;
  }
}

function renewalParent(rows: ITransaction[], expectedRequestNoteId: string): ITransaction {
  const parent = rows.find(row => row.gcClaim?.requestNoteId === expectedRequestNoteId);
  if (!parent || rows.some(row => !['retryable', 'reclaimed'].includes(gcClaimPhase(row)))) {
    throw new Error('GC requests must be proven never committed or reclaimed before a fresh approval');
  }
  const latest = rows
    .filter(row => row.gcClaim?.recoveredHistory !== true)
    .sort((left, right) => (right.gcClaim?.attempt ?? 0) - (left.gcClaim?.attempt ?? 0))[0];
  if (latest && latest.id !== parent.id) throw new Error('GC renewal approval names a stale request');
  return parent;
}

function renewalWinner(rows: ITransaction[], expected: string): ITransaction | undefined {
  const latest = rows
    .filter(row => row.gcClaim?.recoveredHistory !== true)
    .sort((left, right) => (right.gcClaim?.attempt ?? 0) - (left.gcClaim?.attempt ?? 0))[0];
  return latest?.gcClaim?.previousRequestNoteId === expected ? latest : undefined;
}

export async function queueRenewedGcClaim(
  context: GcClaimContext,
  prepared: PreparedGcClaim,
  expectedRequestNoteId: string,
  authorization?: SpendingLimitAuthorization
): Promise<QueuedGcClaim> {
  const expected = gcClaimWord(expectedRequestNoteId);
  const { identity, operation, requestBytes } = await prepare(context, prepared);
  if (operation.requestNoteId === expected) throw new Error('A renewed GC claim needs a fresh request preimage');
  const rows = await scopeRows(identity, operation.scope.approvedWeek);
  const winner = renewalWinner(rows, expected);
  if (winner) return result(winner);
  const parent = renewalParent(rows, expected);
  const attempt = parent.gcClaim?.recoveredHistory ? 0 : (parent.gcClaim?.attempt ?? 0) + 1;
  if (attempt >= MAX_ATTEMPTS) throw new Error('GC claim attempt limit reached');
  try {
    return await insertApproved(
      identity,
      { ...operation, attempt, previousRequestNoteId: expected },
      requestBytes,
      authorization,
      async () => {
        const current = await scopeRows(identity, operation.scope.approvedWeek);
        if (renewalParent(current, expected).id !== parent.id) throw new Error('GC renewal parent changed');
      }
    );
  } catch (error) {
    const concurrent = renewalWinner(await scopeRows(identity, operation.scope.approvedWeek), expected);
    if (concurrent) return result(concurrent);
    throw error;
  }
}

/** Backend inventory: callers must reconcile every same-week request, including duplicate historical notes. */
export async function listGcClaimOperations(context: GcClaimContext, approvedWeek?: number): Promise<StoredGcClaim[]> {
  const identity = await normalizeGcClaimContext(context);
  const week = approvedWeek === undefined ? undefined : gcClaimU32(approvedWeek);
  return (await scopeRows(identity, week)).map(transaction => ({ transaction, phase: gcClaimPhase(transaction) }));
}

/** A single display summary, not permission to ignore the other requests returned by the inventory. */
export async function readGcClaimOperation(
  context: GcClaimContext,
  approvedWeek: number
): Promise<StoredGcClaim | undefined> {
  const rows = await listGcClaimOperations(context, approvedWeek);
  const transaction = preferred(rows.map(row => row.transaction));
  return transaction && { transaction, phase: gcClaimPhase(transaction) };
}

/** Persist ALREADY VERIFIED scan results as tracking only; never fabricate original fees or executable approval. */
export async function restoreGcClaimHistoryPage(context: GcClaimContext, page: GcClaimHistoryPage): Promise<void> {
  const materials = page.requests.map(item => ({
    ...item.material,
    scope: {
      ...item.material.scope,
      ...(item.material.scope.distribution === undefined
        ? {}
        : { distribution: { ...item.material.scope.distribution } })
    },
    inclusionBlock: item.inclusionBlock
  }));
  const identity = await normalizeGcClaimContext(context);
  const operations: RecoveredGcClaimOperation[] = materials.map(material => {
    const operation: RecoveredGcClaimOperation = {
      version: material.scope.distribution?.protocolVersion ?? 1,
      recoveredHistory: true,
      scope: {
        ...(material.scope.distribution === undefined ? {} : { distribution: { ...material.scope.distribution } }),
        genesisCommitment: gcClaimWord(material.scope.genesisCommitment),
        accountId: gcClaimAccount(material.scope.accountId),
        issuerId: gcClaimAccount(material.scope.issuerId),
        approvedWeek: gcClaimU32(material.scope.approvedWeek)
      },
      issuerCodeCommitment: gcClaimWord(material.issuerCodeCommitment),
      nativeAssetId: gcClaimAccount(material.nativeAssetId),
      requestNoteId: gcClaimWord(material.requestNoteId),
      receiptRecipientCommitment: gcClaimWord(material.receiptRecipientCommitment),
      nativeBudget: material.nativeBudget,
      approvalExpiresAt: gcClaimU32(material.approvalExpiresAt),
      reclaimHeight: gcClaimU32(material.reclaimHeight),
      historyInclusionBlock: gcClaimU32(material.inclusionBlock)
    };
    assertGcClaimIdentity(operation, identity);
    if (typeof operation.nativeBudget !== 'bigint' || operation.nativeBudget <= 0n || operation.reclaimHeight === 0) {
      throw new Error('Invalid historical GC material');
    }
    return operation;
  });
  await Repo.db.transaction('rw', Repo.transactions, async () => {
    for (const operation of operations) {
      const rows = await scopeRows(identity, operation.scope.approvedWeek);
      const existing = rows.find(row => row.gcClaim?.requestNoteId === operation.requestNoteId);
      if (existing) {
        const previous = validateRow(existing, identity);
        if (
          previous.receiptRecipientCommitment !== operation.receiptRecipientCommitment ||
          previous.nativeBudget !== operation.nativeBudget ||
          previous.reclaimHeight !== operation.reclaimHeight ||
          previous.approvalExpiresAt !== operation.approvalExpiresAt
        ) {
          throw new Error('Historical GC request conflicts with its stored preimage');
        }
        if (
          previous.historyInclusionBlock !== undefined &&
          previous.historyInclusionBlock !== operation.historyInclusionBlock
        ) {
          throw new Error('Historical GC request inclusion conflicts with stored evidence');
        }
        if (previous.historyInclusionBlock === undefined) {
          await Repo.transactions.update(existing.id, {
            gcClaim: { ...previous, historyInclusionBlock: operation.historyInclusionBlock }
          });
        }
        continue;
      }
      await Repo.transactions.add({
        id: gcClaimHistoryTransactionId(operation),
        accountId: identity.accountId,
        type: 'execute',
        status: ITransactionStatus.Unconfirmed,
        recovered: true,
        initiatedAt: Math.floor(Date.now() / 1000),
        displayIcon: 'DEFAULT',
        gcClaim: operation
      });
    }
  });
}
