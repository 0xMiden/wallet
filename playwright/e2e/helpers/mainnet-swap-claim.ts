import {
  AccountId, Felt, FeltArray, FungibleAsset, Note, NoteArray, NoteAssets, NoteAttachment,
  NoteAttachmentScheme, NoteMetadata, NoteRecipient, NoteScript, NoteStorage, NoteTag, NoteType,
  TransactionRequestBuilder, Word
} from '@miden-sdk/miden-sdk';
import { inspectTestMainnetSwapRequest, type TestMainnetSwapScope } from '../../../src/lib/miden/sdk/test-send-request';

export interface MainnetSwapPaybackScope extends TestMainnetSwapScope {
  noteId: string;
  orderId: string;
}

export function inspectMainnetSwapPayback(
  original: Note,
  payback: Note,
  scope: MainnetSwapPaybackScope
): bigint {
  if (original.id().toString() !== scope.noteId) throw new Error('Original PSWAP identity changed');
  const request = new TransactionRequestBuilder().withOwnOutputNotes(new NoteArray([original])).withExpirationDelta(600).build();
  const inspected = inspectTestMainnetSwapRequest(scope, Uint8Array.from(request.serialize()));
  if (inspected.orderId !== scope.orderId) throw new Error('Original protocol order changed');
  const actor = AccountId.fromHex(scope.accountId);
  const assets = payback.assets().fungibleAssets();
  if (assets.length !== 1 || payback.assets().assets().length !== 1 ||
      assets[0]?.faucetId().toString() !== scope.requestedFaucetId ||
      assets[0].amount() < BigInt(scope.requestedAmount) ||
      payback.metadata().sender().toString() === scope.accountId)
    throw new Error('Payback asset, minimum or maker differs from the original scope');
  const amount = assets[0].amount();
  const serial = original.recipient().serialNum().toU64s();
  const expected = Note.withAttachments(
    new NoteAssets([new FungibleAsset(AccountId.fromHex(scope.requestedFaucetId), amount)]),
    new NoteMetadata(payback.metadata().sender(), NoteType.Public, NoteTag.withAccountTarget(actor)),
    new NoteRecipient(new Word(new BigUint64Array([(serial[0] + 1n) % 0xffffffff00000001n, serial[1], serial[2], serial[3]])),
      NoteScript.p2id(), new NoteStorage(new FeltArray([actor.suffix(), actor.prefix(), new Felt(0n), new Felt(0n)]))),
    [NoteAttachment.fromWord(new NoteAttachmentScheme(3), new Word(new BigUint64Array([amount, serial[1], 1n, 0n])))]
  );
  if (expected.id().toString() !== payback.id().toString())
    throw new Error('Payback differs from the exact original full-fill protocol note');
  return amount;
}
