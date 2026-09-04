import {
  FungibleAsset,
  Note,
  NoteFile,
  TransactionRequest,
  TransactionResult,
  TransactionSummary
} from '@miden-sdk/miden-sdk/lazy';

import { splitExecutedOutputNotes } from 'lib/miden/activity/fee-notes';
import { getBech32AddressFromAccountId } from 'lib/miden/sdk/helpers';
import { b64ToU8 } from 'lib/shared/helpers';

export interface AssetAmount {
  faucetId: string;
  amount: bigint;
}

export interface TxAssetView {
  /** Bech32 account address; only known on the verified (executed) path. */
  account?: string;
  /** Assets leaving the account (created output notes / removed vault assets). */
  outgoing: AssetAmount[];
  /** Assets entering the account (consumed notes / added vault assets). */
  incoming: AssetAmount[];
  inputNotesConsumed: number;
  /** User-created notes only. The kernel's fee note is reported in `fee`, not counted here. */
  outputNotesCreated: number;
  /**
   * The network fee this transaction pays, when it is knowable from what was decoded.
   *
   * Kept OUT of `outgoing` ON BOTH PATHS, which is what makes the two comparable: the
   * executed path never adds the fee note to the total, and the summary path subtracts it
   * back out of the account delta (see `withoutFee`). Without that symmetry the same request
   * rendered a transfer-plus-fee row for one account kind and a transfer-only row for
   * another, through one renderer under one "verified" label.
   *
   * It is a real cost and belongs on the sheet — labelled as a fee, beside the transfer,
   * never inside it. Rendered by `TransactionAssetView` and by `formatAssetViewRows`.
   */
  fee?: AssetAmount;
  storageChanged: boolean;
}

function toAmounts(assets: FungibleAsset[]): AssetAmount[] {
  // Token metadata is cached under the BECH32 faucet address (see
  // fetchTokenMetadata's `Address.fromBech32` and how balances/claimable-notes
  // populate it via getBech32AddressFromAccountId). Using AccountId.toString()
  // (hex) here misses that cache, so getTokenMetadata falls back to Miden's
  // metadata and mislabels non-Miden assets (e.g. 0.05 BTC → "-5 Miden").
  return assets.map(a => ({ faucetId: getBech32AddressFromAccountId(a.faucetId()), amount: a.amount() }));
}

function noteAssets(note: { assets(): { fungibleAssets(): any[] } | undefined } | undefined): AssetAmount[] {
  const na = note?.assets();
  return na ? toAmounts(na.fungibleAssets()) : [];
}

/**
 * Assets of a carried `importNotes` entry, parsing a serialized NoteFile OR a
 * bare Note (the dApp chooses which, mirroring importNoteBytes). Handling only
 * one format would throw for the other and blank the declared incoming assets.
 */
function importedNoteAssets(b64: string): AssetAmount[] {
  const bytes = b64ToU8(b64);
  try {
    const nf = NoteFile.deserialize(bytes);
    return noteAssets(nf.note() ?? nf.noteDetails());
  } catch {
    // Not a NoteFile — try a bare Note below.
  }
  try {
    return noteAssets(Note.deserialize(bytes));
  } catch {
    return [];
  }
}

/**
 * The summary path's incoming/outgoing with the fee taken back out of the account delta.
 *
 * Only the SUMMARY path needs this. Its totals come from the account DELTA — a NET vault
 * change with the fee already withdrawn inside it — while the executed path builds its
 * totals from note flows and never included the fee at all. Reporting the fee separately
 * while leaving it folded into the delta would show it twice.
 *
 * Done on the SIGNED net, not on the removed side alone, because the fee faucet can land on
 * either side of the delta. An account that consumes a 10-native note and pays a 2 fee nets
 * +8 RECEIVED; subtracting only from removals leaves that as `incoming: 8` while the
 * executed path calls the same transaction `incoming: 10, fee: 2`. Adding the fee back to
 * the signed value and re-deciding the direction makes the two agree: -2 + 2 = 0 for a plain
 * send, +8 + 2 = +10 for that consume. A component that nets to zero is dropped rather than
 * emitted at 0, so a fee-only transaction reads as moving nothing rather than sending 0.
 */
function reconcileFee(
  added: AssetAmount[],
  removed: AssetAmount[],
  fee: AssetAmount | undefined
): { incoming: AssetAmount[]; outgoing: AssetAmount[] } {
  if (!fee) return { incoming: added, outgoing: removed };
  const signed = new Map<string, bigint>();
  for (const a of added) signed.set(a.faucetId, (signed.get(a.faucetId) ?? 0n) + a.amount);
  for (const a of removed) signed.set(a.faucetId, (signed.get(a.faucetId) ?? 0n) - a.amount);
  signed.set(fee.faucetId, (signed.get(fee.faucetId) ?? 0n) + fee.amount);

  const incoming: AssetAmount[] = [];
  const outgoing: AssetAmount[] = [];
  for (const [faucetId, amount] of signed) {
    if (amount > 0n) incoming.push({ faucetId, amount });
    else if (amount < 0n) outgoing.push({ faucetId, amount: -amount });
  }
  return { incoming, outgoing };
}

/** Ground-truth view from an executed TransactionSummary (authoritative). */
export function summaryToView(ts: TransactionSummary): TxAssetView {
  const delta = ts.accountDelta();
  const vault = delta.vault();
  // `fee::pay_fee` runs INSIDE the auth procedure, before the summary is built, so the
  // kernel's fee note is among the summary's output notes exactly as it is among an
  // executed transaction's. Counting it claimed a note the user did not create.
  const { feeNote, userNotes } = splitExecutedOutputNotes(ts);
  const fee = (feeNote ? noteAssets(feeNote) : [])[0];
  const { incoming, outgoing } = reconcileFee(
    toAmounts(vault.addedFungibleAssets()),
    toAmounts(vault.removedFungibleAssets()),
    fee
  );
  return {
    account: getBech32AddressFromAccountId(delta.id()),
    outgoing,
    incoming,
    inputNotesConsumed: ts.inputNotes().numNotes(),
    outputNotesCreated: userNotes.length,
    fee,
    storageChanged: !delta.storage().isEmpty()
  };
}

export function summaryBytesToView(summaryB64: string): TxAssetView {
  return summaryToView(TransactionSummary.deserialize(b64ToU8(summaryB64)));
}

/**
 * Ground-truth view from a locally EXECUTED transaction (authoritative), used
 * when the account was already fully authorized so execution produced no
 * TransactionSummary — every ordinary single-sig account on web-sdk 0.16, where
 * `executeForSummary` rejects with `TRANSACTION_ALREADY_AUTHORIZED` (see
 * `lib/miden/back/simulate-custom-tx.ts`).
 *
 * Assets come from the notes the execution actually consumed and created, not
 * from the account delta: 0.16's `ExecutedTransaction.accountPatch()` is
 * ABSOLUTE (final balances, `AccountVaultPatch.updatedFungibleAssets()`), so it
 * cannot be read as an incoming/outgoing delta without the pre-state. Note flows
 * are the same quantities the summary view reports for the transactions this
 * screen previews, and unlike `declaredRequestToView` they are what execution
 * really produced rather than what the request declared.
 */
export function executedBytesToView(executedB64: string): TxAssetView {
  const executed = TransactionResult.deserialize(b64ToU8(executedB64)).executedTransaction();
  const inputNotes = executed.inputNotes();
  // The kernel's fee note is an output note. Totalling it into `outgoing` showed the user
  // an asset they never chose to send, and counting it in `outputNotesCreated` claimed a
  // note they did not create -- both invisible on a zero-fee chain, where no fee note exists.
  const { feeNote, userNotes } = splitExecutedOutputNotes(executed);
  return {
    account: getBech32AddressFromAccountId(executed.accountId()),
    outgoing: userNotes.flatMap(note => noteAssets(note)),
    incoming: inputNotes.notes().flatMap(note => noteAssets(note.note())),
    inputNotesConsumed: inputNotes.numNotes(),
    outputNotesCreated: userNotes.length,
    fee: (feeNote ? noteAssets(feeNote) : [])[0],
    storageChanged: !executed.accountPatch().storage().isEmpty()
  };
}

/**
 * Declared (unverified) view decoded statically from the TransactionRequest:
 * outgoing = its expected output notes' assets; incoming = the assets of the
 * notes it consumes (carried as `importNotes`). No execution, so `account` and
 * `storageChanged` are unknown/false. These values are dApp-declared — the UI
 * must label them as such.
 */
export function declaredRequestToView(requestB64: string, importNotes: string[] = []): TxAssetView {
  const request = TransactionRequest.deserialize(b64ToU8(requestB64));
  const outputNotes = request.expectedOutputOwnNotes();

  return {
    account: undefined,
    outgoing: outputNotes.flatMap(n => noteAssets(n)),
    incoming: importNotes.flatMap(b64 => importedNoteAssets(b64)),
    // Only counts the carried `importNotes`; it may undercount notes consumed
    // from the wallet's own store (referenced by inputNoteIds, not carried
    // here as full note bytes). This is the explicitly-unverified "declared"
    // view — the verified (simulated/executed) summary supersedes it.
    inputNotesConsumed: importNotes.length,
    outputNotesCreated: outputNotes.length,
    storageChanged: false
  };
}
