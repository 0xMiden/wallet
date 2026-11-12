import {
  AccountId, Note, NoteArray, NoteAssets, NoteAttachment, NoteFile, NoteType, TransactionRequest, TransactionRequestBuilder
} from '@miden-sdk/miden-sdk';

import { getSimpleWitnessHash } from '@epoch-protocol/epoch-commons-sdk';

import { canonicalRequestBytes } from '../../../scripts/canonical-request-bytes.mjs';
import { isRecord } from '../../../src/lib/update/guards';
import { epochReadOnlyProvider } from './mainnet-epoch-provider';
import { parseMainnetEpochCheckpoint, type MainnetEpochCheckpoint } from './mainnet-epoch-checkpoint';

export interface EpochCollateralReview {
  currentBlock: number;
  reclaimHeight: number;
  bindingHash: string;
}

export function inspectEpochForwardQuote(
  state: MainnetEpochCheckpoint, payload: unknown, currentBlock: number, observedNonce: string
): { bindingHash: string; mandateReclaimHeight: number } {
  parseMainnetEpochCheckpoint(state);
  if (!Number.isSafeInteger(currentBlock) || currentBlock <= 0 || observedNonce !== state.forwardNonce ||
      !isRecord(payload) || payload.chainId !== String(state.virtualChainId) || payload.isRegisteredOnchain !== false ||
      payload.sponsorSignature !== '0x' || !isRecord(payload.compact) || !isRecord(payload.compact.mandate))
    throw new Error('Epoch forward quote or latest SDK nonce is outside its authorization');
  const compact = payload.compact;
  const mandate = payload.compact.mandate;
  if (typeof compact.sponsor !== 'string' || compact.sponsor.toLowerCase() !== state.evm.account.toLowerCase() ||
      compact.nonce !== state.forwardNonce || compact.amount !== state.principal || compact.token !== `0x${'0'.repeat(40)}` ||
      typeof mandate.minTokenOut !== 'string' || !/^[1-9]\d{0,77}$/.test(mandate.minTokenOut) ||
      BigInt(mandate.minTokenOut) >= (1n << 256n) || BigInt(mandate.minTokenOut) < BigInt(state.forwardMinimum) ||
      typeof mandate.midenReclaimHeight !== 'string' || !/^[1-9]\d{0,9}$/.test(mandate.midenReclaimHeight))
    throw new Error('Epoch forward compact weakens its actor, amount, nonce or output floor');
  const reclaimHeight = Number(mandate.midenReclaimHeight);
  if (reclaimHeight <= currentBlock || reclaimHeight > currentBlock + state.recallBlocks || reclaimHeight > 0xffff_ffff)
    throw new Error('Epoch forward mandate reclaim estimate is stale or outside its window');
  const { sdk } = epochReadOnlyProvider(state.allocatorUrl, state.virtualChainId, state.evm.account);
  const task = sdk.getTaskData({
    taskType: sdk.TaskType.GetTokenOut,
    intentData: { isNative: false, depositTokenAddress: `0x${'0'.repeat(40)}`, tokenInAmount: state.principal,
      outputTokenAddress: state.evm.token, minTokenOut: mandate.minTokenOut, destinationChainId: String(state.evm.chainId),
      protocolHashIdentifier: `0x${'0'.repeat(64)}`, recipient: state.evm.account },
    extraDataTypestring: `uint256 midenReclaimHeight,${sdk.MIDEN_TO_EVM_EXTRA_TYPESTRING}`,
    extraData: { midenSourceAccount: state.accountHex, midenFaucetId: state.native.hex,
      midenNoteType: 'P2IDE', midenNoteId: '', midenReclaimHeight: String(reclaimHeight) }
  });
  if (payload.witnessTypeString !== task.taskTypeString ||
      Object.keys(mandate).sort().join(',') !== Object.keys(task.intentData).sort().join(','))
    throw new Error('Epoch forward mandate has undeclared fields or a different witness shape');
  for (const [key, expected] of Object.entries(task.intentData)) {
    const actual = mandate[key];
    if (typeof actual !== 'string' || typeof expected !== 'string' ||
        (['tokenIn', 'tokenOut', 'recipient'].includes(key) ? actual.toLowerCase() !== expected.toLowerCase() : actual !== expected))
      throw new Error('Epoch forward mandate does not bind the authorized route, actors and amounts');
  }
  return { bindingHash: getSimpleWitnessHash(task.intentData, task.taskTypeString), mandateReclaimHeight: reclaimHeight };
}

export function inspectEpochRefundNote(
  _state: MainnetEpochCheckpoint, _bytes: Uint8Array, _currentBlock: number
): bigint {
  throw new Error('Epoch collateral refund inspection is not implemented');
}

export function inspectEpochReturnNote(
  state: MainnetEpochCheckpoint, expectedNoteId: string, bytes: Uint8Array
): bigint {
  parseMainnetEpochCheckpoint(state);
  if (!/^0x[0-9a-f]{64}$/i.test(expectedNoteId) || bytes.length < 1 || bytes.length > 1_048_576)
    throw new Error('Invalid Epoch return note identity or byte size');
  const note = NoteFile.deserialize(bytes).note();
  if (!note || note.id().toString() !== expectedNoteId.toLowerCase() ||
      note.metadata().sender().toString() === state.accountHex || note.assets().assets().length !== 1)
    throw new Error('Epoch return must be the exact provider-correlated non-self note');
  const assets = note.assets().fungibleAssets();
  const asset = assets[0];
  if (assets.length !== 1 || !asset || asset.faucetId().toString() !== state.native.hex ||
      asset.amount() < BigInt(state.reverseMinimum))
    throw new Error('Epoch return note asset or amount differs from its authorization');
  const amount = asset.amount();
  const expected = Note.createP2IDNote(note.metadata().sender(), AccountId.fromHex(state.accountHex),
    new NoteAssets([asset]), NoteType.Public, new NoteAttachment());
  const actualStorage = note.recipient().storage().items().map(value => value.asInt());
  const expectedStorage = expected.recipient().storage().items().map(value => value.asInt());
  if (note.script().root().toHex() !== expected.script().root().toHex() || actualStorage.length !== expectedStorage.length ||
      actualStorage.some((value, index) => value !== expectedStorage[index]))
    throw new Error('Epoch return is not the exact non-reclaimable P2ID to the authorized Guardian');
  return amount;
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
