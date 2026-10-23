import type { TxAssetView } from 'app/confirm/decode';
import { ITransaction, ITransactionStatus, Transaction } from 'lib/miden/db/types';
import * as Repo from 'lib/miden/repo';
import { accountRefToSdk, canonicalWalletAccountId } from 'lib/miden/sdk/helpers';
import { queueOutgoingTransaction } from 'lib/miden/spending-limits/queue';
import { isProvable } from 'lib/miden/transaction/verdict-rules';

import {
  GcClaimContext,
  GcClaimIssuanceEvidence,
  gcClaimAssetId,
  gcClaimBindingKey,
  gcClaimWord,
  normalizeGcClaimContext
} from './gc-claim-operation';

/** Completed, unknown and even locally Failed consumes retain their receipt until a node verdict proves death. */
function retryable(row: ITransaction): boolean {
  const evidence = row.submitEvidence ?? [];
  return (
    row.restoredFromBackup !== true &&
    row.status === ITransactionStatus.Failed &&
    row.neverCommittedAt !== undefined &&
    evidence.some(item => isProvable(item) && item.verdict === 'never-committed') &&
    evidence.every(
      item =>
        item.candidateKept !== true &&
        item.landingSeenAtBlock === undefined &&
        (item.preSubmitEnd === true || (isProvable(item) && item.verdict === 'never-committed'))
    )
  );
}
async function receiptRows(context: GcClaimContext, receiptId: string): Promise<ITransaction[]> {
  return Repo.transactions
    .filter(
      row =>
        canonicalWalletAccountId(row.accountId) === canonicalWalletAccountId(context.accountId) &&
        (row.noteId === receiptId ||
          [row.noteIds, row.inputNoteIds, row.heldNoteIds].some(ids => ids?.includes(receiptId)))
    )
    .toArray();
}
export async function gcReceiptPending(context: GcClaimContext, receiptId: string): Promise<boolean> {
  return (await receiptRows(context, gcClaimWord(receiptId))).some(row => !retryable(row));
}
class ReceiptAlreadyQueued extends Error {}

/** Same atomic outgoing admission and note holds as custom transactions; no separate executor. */
export async function queueGcReceipt(
  context: GcClaimContext,
  receiptId: string,
  requestBytes: Uint8Array,
  fee: bigint,
  expiresAt: number
): Promise<void> {
  const identity = await normalizeGcClaimContext(context);
  const noteId = gcClaimWord(receiptId);
  if (fee < 0n || !requestBytes.length) throw new Error('GC receipt request unavailable');
  const spends = [{ faucetId: identity.nativeAssetId, amount: fee }];
  const row = new Transaction(identity.accountId, new Uint8Array(requestBytes), [noteId], false, undefined, spends);
  row.heldNoteIds = [noteId];
  const queued = { ...row, noteIds: [noteId], badgeNetwork: identity.network };
  try {
    await queueOutgoingTransaction(queued, spends, undefined, Math.floor(Date.now() / 1000), async () => {
      if (!Number.isFinite(expiresAt) || expiresAt <= Date.now() / 1000) throw new Error('GC receipt approval expired');
      if (await gcReceiptPending(identity, noteId)) throw new ReceiptAlreadyQueued();
    });
  } catch (error) {
    if (!(error instanceof ReceiptAlreadyQueued)) throw error;
  }
  await (await import('lib/miden/note-quarantine')).releaseNoteIds([noteId]);
}

/** The approval permits exactly one 10 GC receipt plus its authenticated native refund and a native fee. */
export function verifyGcReceiptEffects(
  context: GcClaimContext,
  view: TxAssetView | null | undefined,
  refund: bigint
): bigint {
  if (
    !view ||
    !view.account ||
    accountRefToSdk(view.account).toString() !== context.accountId ||
    view.storageChanged ||
    view.inputNotesConsumed !== 1 ||
    view.outputNotesCreated !== 0 ||
    view.outgoing.length > 0 ||
    refund < 0n ||
    !view.fee ||
    accountRefToSdk(view.fee.faucetId).toString() !== context.nativeAssetId ||
    view.fee.amount < 0n
  )
    throw new Error('GC receipt dry run effects unavailable');
  let gc = 0n;
  let native = 0n;
  for (const asset of view.incoming) {
    const faucet = accountRefToSdk(asset.faucetId).toString();
    if (asset.amount < 0n) throw new Error('GC receipt invalid incoming asset');
    if (faucet === gcClaimAssetId(context)) gc += asset.amount;
    else if (faucet === context.nativeAssetId) native += asset.amount;
    else throw new Error('GC receipt moved another asset');
  }
  if (gc !== 10_000_000n || native !== refund) throw new Error('GC receipt differs from authenticated issuance');
  return view.fee.amount;
}

export async function prepareGcReceipt(
  context: GcClaimContext,
  issuance: GcClaimIssuanceEvidence,
  bytes: Uint8Array
): Promise<{ requestBytes: Uint8Array; requestFee: bigint }> {
  const [
    { NoteFile, TransactionSummary, TransactionResult },
    { ensureSdkWasmReady },
    { buildConsumeTransactionRequest, feeAwareRequestBuilder, randomFeeSalt },
    { EXPIRATION_DELTA_BLOCKS },
    { simulateCustomTransaction },
    { runsWasmInThisRealm },
    { u8ToB64, b64ToU8 },
    { withWasmClientLock, assertWasmHoldCurrent, getMidenClient },
    { simulatedBytesToView }
  ] = await Promise.all([
    import('@miden-sdk/miden-sdk/lazy'),
    import('lib/miden-chain/constants'),
    import('lib/miden/sdk/helpers'),
    import('lib/miden/helpers'),
    import('lib/miden/back/simulate-custom-tx'),
    import('lib/miden/back/miden-client-proxy'),
    import('lib/shared/helpers'),
    import('lib/miden/sdk/miden-client'),
    import('app/confirm/decode')
  ]);
  await ensureSdkWasmReady();
  if (!runsWasmInThisRealm()) throw new Error('GC receipt simulation is unavailable in this client realm');
  const requestBytes = await withWasmClientLock(
    async hold => {
      const note = NoteFile.deserialize(bytes).note();
      if (
        !note ||
        note.id().toString() !== issuance.receiptNoteId ||
        note.recipient().digest().toHex() !== issuance.receiptRecipientCommitment ||
        issuance.accountId !== context.accountId ||
        issuance.genesisCommitment !== context.genesisCommitment ||
        issuance.issuerId !== context.issuerId ||
        (context.distribution !== undefined &&
          note.metadata().sender().toString() !== context.distribution.distributorId) ||
        gcClaimBindingKey(issuance) !== gcClaimBindingKey(context) ||
        issuance.gcAmount !== 10_000_000n
      )
        throw new Error('GC receipt identity changed');
      const { client } = await getMidenClient();
      assertWasmHoldCurrent(hold, 'GC receipt after resolving client');
      const builder = await feeAwareRequestBuilder(client, context.accountId, randomFeeSalt());
      assertWasmHoldCurrent(hold, 'GC receipt after resolving authentication');
      const request = buildConsumeTransactionRequest([note], EXPIRATION_DELTA_BLOCKS, builder).serialize();
      assertWasmHoldCurrent(hold, 'GC receipt after building consume');
      return request;
    },
    { label: 'gc-receipt-build' }
  );
  // Preparation imports/quarantines and dry-runs locally; it never queues or signs a transaction.
  const result = await simulateCustomTransaction({
    address: context.accountId,
    transactionRequest: u8ToB64(requestBytes),
    importNotes: [u8ToB64(bytes)],
    capturePreparedRequest: true
  });
  if (result.error || !result.preparedRequestBytes) {
    throw new Error('GC receipt dry run unavailable');
  }
  return withWasmClientLock(
    async hold => {
      const inputs = result.summaryBytes
        ? TransactionSummary.deserialize(b64ToU8(result.summaryBytes)).inputNotes()
        : result.executedBytes
          ? TransactionResult.deserialize(b64ToU8(result.executedBytes)).executedTransaction().inputNotes()
          : undefined;
      if (!inputs || inputs.numNotes() !== 1 || inputs.getNote(0).id().toString() !== issuance.receiptNoteId)
        throw new Error('GC receipt consumed a different note');
      const receiptView = simulatedBytesToView(result);
      const fee = verifyGcReceiptEffects(context, receiptView, issuance.nativeRefund);
      assertWasmHoldCurrent(hold, 'GC receipt after dry-run verification');
      return { requestBytes: b64ToU8(result.preparedRequestBytes!), requestFee: fee };
    },
    { label: 'gc-receipt-dry-run', watchdogMs: 30_000 }
  );
}
