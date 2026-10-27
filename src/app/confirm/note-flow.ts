import {
  NoteScript,
  NoteType,
  StoragePatchOperation,
  TransactionResult,
  TransactionSummary,
  type ExecutedTransaction,
  type Note,
  type OutputNote
} from '@miden-sdk/miden-sdk/lazy';

import { splitExecutedOutputNotes } from 'lib/miden/activity/fee-notes';
import { getBech32AddressFromAccountId } from 'lib/miden/sdk/helpers';
import { toNft, type NftAsset } from 'lib/miden/sdk/nft-asset';
import { b64ToU8 } from 'lib/shared/helpers';

import type { AssetAmount } from './decode';

export type NoteKind = 'fee' | 'p2id' | 'p2ide' | 'pswap' | 'custom' | 'unknown';
export type NoteVisibility = 'public' | 'private' | 'unknown';

export interface NoteDetail {
  id?: string;
  kind: NoteKind;
  visibility: NoteVisibility;
  sender?: string;
  assets?: AssetAmount[];
  nfts?: NftAsset[];
  scriptRoot?: string;
}

export interface NoteFlow {
  inputCount: number;
  inputs: NoteDetail[];
  outputs: NoteDetail[];
  storageChanges?: StorageChange[];
}

export interface StorageChange {
  slotName: string;
  kind: 'value' | 'map';
  operation: 'create' | 'update' | 'remove' | 'unknown';
  entryCount?: number;
}

function attempt<T>(read: () => T): T | undefined {
  try {
    return read();
  } catch {
    return undefined;
  }
}

function kindOf(note: Note | undefined): { kind: NoteKind; scriptRoot?: string } {
  const scriptRoot = attempt(() => note?.script().root().toHex());
  if (!scriptRoot) return { kind: 'unknown' };
  const known = attempt(() => ({
    p2id: NoteScript.p2id().root().toHex(),
    p2ide: NoteScript.p2ide().root().toHex(),
    pswap: NoteScript.pswap().root().toHex()
  }));
  if (!known) return { kind: 'unknown', scriptRoot };
  const kind = Object.entries(known).find(([, root]) => root === scriptRoot)?.[0] as NoteKind | undefined;
  return { kind: kind ?? 'custom', scriptRoot };
}

function describe(id: string | undefined, full: Note | undefined, content: Note | OutputNote | undefined): NoteDetail {
  const metadata = content && attempt(() => content.metadata());
  const noteType = metadata && attempt(() => metadata.noteType());
  const visibility = noteType === NoteType.Public ? 'public' : noteType === NoteType.Private ? 'private' : 'unknown';
  const sender = metadata && attempt(() => getBech32AddressFromAccountId(metadata.sender()));
  const noteAssets = attempt(() => content?.assets() ?? full?.assets());
  const assets = attempt(() =>
    noteAssets?.fungibleAssets().map(asset => ({
      faucetId: getBech32AddressFromAccountId(asset.faucetId()),
      amount: asset.amount()
    }))
  );
  const nfts = attempt(() => noteAssets?.nonFungibleAssets().map(toNft));
  return { id, ...kindOf(full), visibility, sender, assets, nfts };
}

function storageOperation(operation: StoragePatchOperation): StorageChange['operation'] {
  switch (operation) {
    case StoragePatchOperation.Create:
      return 'create';
    case StoragePatchOperation.Update:
      return 'update';
    case StoragePatchOperation.Remove:
      return 'remove';
    default:
      return 'unknown';
  }
}

function storageChangesOf(transaction: TransactionSummary | ExecutedTransaction): StorageChange[] | undefined {
  const patch = attempt(() =>
    'accountDelta' in transaction ? transaction.accountDelta().storage() : transaction.accountPatch().storage()
  );
  if (!patch) return undefined;
  if (attempt(() => patch.isEmpty()) === true) return [];
  const values = attempt(() => patch.valueSlots());
  const maps = attempt(() => patch.mapSlots());
  if (!values || !maps) return undefined;
  return attempt(() => [
    ...values.map(slot => ({
      slotName: slot.slotName,
      kind: 'value' as const,
      operation: storageOperation(slot.operation)
    })),
    ...maps.map(slot => ({
      slotName: slot.slotName,
      kind: 'map' as const,
      operation: storageOperation(slot.operation),
      entryCount: attempt(() => slot.entries().length)
    }))
  ]);
}

export function noteFlowFromTransaction(transaction: TransactionSummary | ExecutedTransaction): NoteFlow {
  const inputNotes = transaction.inputNotes();
  const inputs = inputNotes.notes().map(input => {
    const id = attempt(() => input.id().toString());
    const full = attempt(() => input.note());
    return describe(id, full, full);
  });
  const { feeNote, userNotes } = splitExecutedOutputNotes(transaction);
  const toDetail = (output: OutputNote): NoteDetail =>
    describe(
      attempt(() => output.id().toString()),
      attempt(() => output.intoFull()),
      output
    );
  return {
    inputCount: inputNotes.numNotes(),
    inputs,
    storageChanges: storageChangesOf(transaction),
    outputs: [...userNotes.map(toDetail), ...(feeNote ? [{ ...toDetail(feeNote), kind: 'fee' as const }] : [])]
  };
}

export function noteFlowFromSimulatedBytes(result: {
  summaryBytes?: string;
  executedBytes?: string;
}): NoteFlow | undefined {
  if (result.summaryBytes) return noteFlowFromTransaction(TransactionSummary.deserialize(b64ToU8(result.summaryBytes)));
  if (result.executedBytes) {
    return noteFlowFromTransaction(TransactionResult.deserialize(b64ToU8(result.executedBytes)).executedTransaction());
  }
  return undefined;
}
