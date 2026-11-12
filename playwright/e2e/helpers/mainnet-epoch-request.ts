import {
  AccountId, Note, NoteArray, NoteAssets, NoteType, TransactionRequest, TransactionRequestBuilder
} from '@miden-sdk/miden-sdk';

import { canonicalRequestBytes } from '../../../scripts/canonical-request-bytes.mjs';
import { parseMainnetEpochCheckpoint, type MainnetEpochCheckpoint } from './mainnet-epoch-checkpoint';

export interface EpochCollateralReview {
  currentBlock: number;
  reclaimHeight: number;
  bindingHash: string;
}

export function inspectEpochForwardQuote(
  _state: MainnetEpochCheckpoint, _payload: unknown, _currentBlock: number
): { bindingHash: string; mandateReclaimHeight: number } {
  throw new Error('Epoch forward quote binding is not implemented');
}

export function inspectEpochCollateralRequest(
  state: MainnetEpochCheckpoint,
  bytes: Uint8Array,
  review: EpochCollateralReview
): { noteId: string; reclaimHeight: number } {
  parseMainnetEpochCheckpoint(state);
  if (!Number.isSafeInteger(review.currentBlock) || review.currentBlock < 0 ||
      !Number.isSafeInteger(review.reclaimHeight) || review.reclaimHeight > 0xffff_ffff ||
      review.reclaimHeight - review.currentBlock < state.minimumRecallBlocks ||
      review.reclaimHeight - review.currentBlock > state.recallBlocks ||
      !/^0x[0-9a-f]{64}$/.test(review.bindingHash) || bytes.length > 1_048_576) {
    throw new Error('Epoch collateral reclaim window or mandate binding is outside authorization');
  }
  const request = TransactionRequest.deserialize(bytes);
  const notes = request.expectedOutputOwnNotes();
  const note = notes[0];
  if (notes.length !== 1 || !note || note.metadata().sender().toString() !== state.accountHex ||
      note.metadata().noteType() !== NoteType.Public || note.assets().assets().length !== 1) {
    throw new Error('Epoch collateral must contain one public output from the authorized account');
  }
  const assets = note.assets().fungibleAssets();
  const asset = assets[0];
  if (assets.length !== 1 || !asset || asset.faucetId().toString() !== state.native.hex ||
      asset.amount() !== BigInt(state.principal)) {
    throw new Error('Epoch collateral asset or amount differs from its authorization');
  }
  const attachments = note.attachments();
  const attachment = attachments[0];
  if (attachments.length !== 1 || !attachment || !attachment.attachmentScheme().isNone()) {
    throw new Error('Epoch collateral must carry exactly its mandate-binding attachment');
  }
  const felts = attachment.toWords().flatMap(word => Array.from(word.toU64s()));
  const widths = [7, 7, 7, 7, 4];
  if (felts.length !== 8 || felts.slice(5).some(value => value !== 0n)) {
    throw new Error('Epoch mandate binding has unexpected length or nonzero padding');
  }
  let binding = '0x';
  for (const [index, width] of widths.entries()) {
    const value = felts[index];
    if (value === undefined || value < 0n || value >= (1n << BigInt(width * 8))) {
      throw new Error('Epoch mandate binding contains an out-of-range felt');
    }
    binding += value.toString(16).padStart(width * 2, '0');
  }
  if (binding !== review.bindingHash) throw new Error('Epoch collateral is not bound to the authorized mandate');

  const expectedNote = Note.createP2IDENote(
    AccountId.fromHex(state.accountHex), AccountId.fromHex(state.midenAllocator), new NoteAssets([asset]),
    review.reclaimHeight, null, NoteType.Public, attachment
  );
  const actualStorage = note.recipient().storage().items().map(value => value.asInt());
  const expectedStorage = expectedNote.recipient().storage().items().map(value => value.asInt());
  if (note.script().root().toHex() !== expectedNote.script().root().toHex() ||
      note.metadata().tag().asU32() !== expectedNote.metadata().tag().asU32() ||
      actualStorage.length !== expectedStorage.length || actualStorage.some((value, index) => value !== expectedStorage[index])) {
    throw new Error('Epoch collateral recipient, script or reclaim storage is not the canonical P2IDE request');
  }
  const noteId = note.id().toString();
  const blocks = request.blockNumbers();
  if (blocks.length > 8 || blocks.some(block => !Number.isSafeInteger(block) || block < 0 || block > review.currentBlock)) {
    throw new Error('Epoch collateral declares an invalid authentication block');
  }
  const auth = request.authArg();
  const salt = request.feeConversionSalt();
  if (auth && salt) throw new Error('Epoch collateral declares conflicting fee authentication');
  let builder = new TransactionRequestBuilder().withOwnOutputNotes(new NoteArray([note]));
  if (auth) builder = builder.withAuthArg(auth);
  if (salt) builder = builder.withFeeConversionSalt(salt);
  builder = builder.withBlockNumbers(blocks).extendAdviceMap(request.adviceMap());
  const expected = builder.build();
  if (!canonicalRequestBytes(bytes).equals(canonicalRequestBytes(expected.serialize()))) {
    throw new Error('Epoch transaction contains undeclared execution fields beyond its checked collateral note');
  }
  return { noteId, reclaimHeight: review.reclaimHeight };
}
