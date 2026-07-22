import { FungibleAsset, Note, NoteFile, TransactionRequest, TransactionSummary } from '@miden-sdk/miden-sdk/lazy';

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
  outputNotesCreated: number;
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

/** Ground-truth view from an executed TransactionSummary (authoritative). */
export function summaryToView(ts: TransactionSummary): TxAssetView {
  const delta = ts.accountDelta();
  const vault = delta.vault();
  return {
    account: getBech32AddressFromAccountId(delta.id()),
    outgoing: toAmounts(vault.removedFungibleAssets()),
    incoming: toAmounts(vault.addedFungibleAssets()),
    inputNotesConsumed: ts.inputNotes().numNotes(),
    outputNotesCreated: ts.outputNotes().numNotes(),
    storageChanged: !delta.storage().isEmpty()
  };
}

export function summaryBytesToView(summaryB64: string): TxAssetView {
  return summaryToView(TransactionSummary.deserialize(b64ToU8(summaryB64)));
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
