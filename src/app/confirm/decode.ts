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
 * `outgoing` with the fee taken back out of its own faucet's row.
 *
 * Only the SUMMARY path needs this. Its total comes from the account DELTA, which is a net
 * vault change with the fee already withdrawn inside it, so the fee arrives folded into the
 * native row; the executed path builds its total from the user notes and never included it.
 * Reporting the fee separately while leaving it folded in would show it twice.
 *
 * The filter does two jobs. A row the fee exactly accounts for is dropped rather than left
 * at zero, so a fee-only transaction reads as moving nothing rather than as sending 0 — and
 * because the delta is NET, an account that also received the native asset in the same
 * transaction can show a removal smaller than the fee; that row goes negative here and is
 * dropped for the same reason, since a negative amount would render as the user being paid.
 */
function withoutFee(outgoing: AssetAmount[], fee: AssetAmount | undefined): AssetAmount[] {
  if (!fee) return outgoing;
  return outgoing
    .map(a => (a.faucetId === fee.faucetId ? { ...a, amount: a.amount - fee.amount } : a))
    .filter(a => a.amount > 0n);
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
  return {
    account: getBech32AddressFromAccountId(delta.id()),
    outgoing: withoutFee(toAmounts(vault.removedFungibleAssets()), fee),
    incoming: toAmounts(vault.addedFungibleAssets()),
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
