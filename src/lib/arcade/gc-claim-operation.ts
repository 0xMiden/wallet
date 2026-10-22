import { ITransaction, ITransactionStatus } from 'lib/miden/db/types';
import { accountRefToSdk } from 'lib/miden/sdk/helpers';
import { isProvable } from 'lib/miden/transaction/verdict-rules';
import { ensureSdkWasmReady } from 'lib/miden-chain/constants';

/** Backend-resolved chain/configuration identity. Never accept this from an intercom caller. */
export interface GcClaimContext {
  network: 'testnet';
  genesisCommitment: string;
  accountId: string;
  issuerId: string;
  issuerCodeCommitment: string;
  nativeAssetId: string;
}

export interface GcClaimScope {
  genesisCommitment: string;
  accountId: string;
  issuerId: string;
  approvedWeek: number;
}

/** Constructed and dry-run by the backend after approval; this is not a frontend request DTO. */
export interface PreparedGcClaim {
  scope: GcClaimScope;
  issuerCodeCommitment: string;
  nativeAssetId: string;
  requestNoteId: string;
  receiptRecipientCommitment: string;
  nativeBudget: bigint;
  /** Full native outflow from the approved dry-run, including its request fee. */
  outgoingNativeAmount: bigint;
  approvalExpiresAt: number;
  reclaimHeight: number;
  requestBytes: Uint8Array;
}

/** References to facts already authenticated by the backend's node/proof reader. */
export interface GcClaimChainAnchor {
  genesisCommitment: string;
  blockNumber: number;
  blockCommitment: string;
  transactionId: string;
}

export interface GcClaimIssuanceEvidence extends Omit<GcClaimChainAnchor, 'transactionId'> {
  kind: 'issued';
  /** Public RPC proves the request spend and receipt inclusion, but may not expose issuer transaction IDs. */
  transactionId?: string;
  requestNoteId: string;
  requestNullifier: string;
  issuerId: string;
  accountId: string;
  receiptNoteId: string;
  receiptRecipientCommitment: string;
  gcAmount: bigint;
  nativeRefund: bigint;
  issuerFee: bigint;
}

export interface GcClaimDeliveryEvidence extends GcClaimChainAnchor {
  kind: 'delivered';
  receiptNoteId: string;
  receiptNullifier: string;
  accountId: string;
}

export interface GcClaimReclaimEvidence extends GcClaimChainAnchor {
  kind: 'reclaimed';
  requestNoteId: string;
  requestNullifier: string;
  accountId: string;
  /** Authenticated consuming transaction's reference height, not the wall clock. */
  referenceBlock: number;
}

export type GcClaimEvidence = GcClaimIssuanceEvidence | GcClaimDeliveryEvidence | GcClaimReclaimEvidence;

/** Stored on the ordinary execute row together with requestBytes in its first atomic insert. */
interface GcClaimOperationBase extends Omit<PreparedGcClaim, 'requestBytes' | 'outgoingNativeAmount'> {
  version: 1;
  attempt?: number;
  previousRequestNoteId?: string;
  historyInclusionBlock?: number;
  issuance?: GcClaimIssuanceEvidence;
  delivery?: GcClaimDeliveryEvidence;
  reclaim?: GcClaimReclaimEvidence;
}

export interface ApprovedGcClaimOperation extends GcClaimOperationBase {
  recoveredHistory?: false;
  outgoingNativeAmount: bigint;
}

/** A verified historical request is tracking evidence, never an executable approved outgoing row. */
export interface RecoveredGcClaimOperation extends GcClaimOperationBase {
  recoveredHistory: true;
  outgoingNativeAmount?: never;
}

export type GcClaimOperation = ApprovedGcClaimOperation | RecoveredGcClaimOperation;

export type GcClaimPhase = 'pending' | 'awaiting-receipt' | 'delivered' | 'reclaimed' | 'retryable';

/** A local transaction's completion/failure alone never proves GC delivery or safe resubmission. */
export function gcClaimPhase(transaction: ITransaction): GcClaimPhase {
  const operation = transaction.gcClaim;
  if (operation === undefined || transaction.restoredFromBackup === true) return 'pending';
  if (operation.delivery !== undefined && operation.issuance !== undefined) return 'delivered';
  if (operation.issuance !== undefined) return 'awaiting-receipt';
  if (operation.reclaim !== undefined) return 'reclaimed';
  if (operation.historyInclusionBlock !== undefined) return 'pending';
  const evidence = transaction.submitEvidence ?? [];
  // Use the existing node reconciler's verdict, never status/error text or an expired local timer.
  if (
    transaction.status === ITransactionStatus.Failed &&
    transaction.neverCommittedAt !== undefined &&
    evidence.some(entry => isProvable(entry) && entry.verdict === 'never-committed') &&
    evidence.every(
      entry =>
        entry.candidateKept !== true &&
        entry.landingSeenAtBlock === undefined &&
        (entry.preSubmitEnd === true || (isProvable(entry) && entry.verdict === 'never-committed'))
    )
  ) {
    return 'retryable';
  }
  return 'pending';
}

export function gcClaimWord(value: string): string {
  if (typeof value !== 'string' || !/^0x[0-9a-f]{64}$/i.test(value)) throw new Error('Invalid GC claim commitment');
  return value.toLowerCase();
}

/** Strict SDK parsing; unlike display identity helpers, no unparsed-text fallback is allowed. */
export function gcClaimAccount(value: string): string {
  return accountRefToSdk(value).toString();
}

export function gcClaimU32(value: number): number {
  if (!Number.isSafeInteger(value) || value < 0 || value > 0xffff_ffff) throw new Error('Invalid GC claim integer');
  return value;
}

export async function normalizeGcClaimContext(context: GcClaimContext): Promise<GcClaimContext> {
  const snapshot = { ...context };
  if (snapshot.network !== 'testnet') throw new Error('GC claims are Testnet only');
  await ensureSdkWasmReady();
  return {
    network: snapshot.network,
    genesisCommitment: gcClaimWord(snapshot.genesisCommitment),
    accountId: gcClaimAccount(snapshot.accountId),
    issuerId: gcClaimAccount(snapshot.issuerId),
    issuerCodeCommitment: gcClaimWord(snapshot.issuerCodeCommitment),
    nativeAssetId: gcClaimAccount(snapshot.nativeAssetId)
  };
}

/** The primary key is the canonical scope, so concurrent realms contend on the same IndexedDB key. */
export function gcClaimTransactionId(scope: GcClaimScope, attempt = 0): string {
  const base = `gc-claim:${JSON.stringify([scope.genesisCommitment, scope.accountId, scope.issuerId, scope.approvedWeek])}`;
  return attempt === 0 ? base : `${base}:attempt:${gcClaimU32(attempt)}`;
}

export function gcClaimHistoryTransactionId(operation: GcClaimOperation): string {
  return `gc-history:${operation.scope.genesisCommitment}:${operation.requestNoteId}`;
}

export function assertGcClaimIdentity(operation: GcClaimOperation, identity: GcClaimContext): void {
  if (
    operation.version !== 1 ||
    operation.scope.genesisCommitment !== identity.genesisCommitment ||
    operation.scope.accountId !== identity.accountId ||
    operation.scope.issuerId !== identity.issuerId ||
    operation.issuerCodeCommitment !== identity.issuerCodeCommitment ||
    operation.nativeAssetId !== identity.nativeAssetId
  ) {
    throw new Error('GC claim does not match the active backend identity');
  }
}
