import { Note, TransactionRequest, TransactionSummary } from '@miden-sdk/miden-sdk/lazy';

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

function toAmounts(assets: Array<{ faucetId(): { toString(): string }; amount(): bigint }>): AssetAmount[] {
  return assets.map(a => ({ faucetId: a.faucetId().toString(), amount: a.amount() }));
}

function noteAssets(note: { assets(): { fungibleAssets(): any[] } | undefined } | undefined): AssetAmount[] {
  const na = note?.assets();
  return na ? toAmounts(na.fungibleAssets()) : [];
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
  const consumed = importNotes.map(b64 => Note.deserialize(b64ToU8(b64)));

  return {
    account: undefined,
    outgoing: outputNotes.flatMap(n => noteAssets(n)),
    incoming: consumed.flatMap(n => noteAssets(n)),
    inputNotesConsumed: consumed.length,
    outputNotesCreated: outputNotes.length,
    storageChanged: false
  };
}
