import {
  AccountId,
  Endpoint,
  Felt,
  FeltArray,
  FungibleAsset,
  Note,
  NoteId,
  NoteArray,
  NoteAssets,
  NoteAttachment,
  NoteAttachmentScheme,
  NoteMetadata,
  NoteRecipient,
  NoteScript,
  NoteStorage,
  NoteTag,
  NoteType,
  RpcClient,
  TransactionRequestBuilder,
  Word
} from '@miden-sdk/miden-sdk';
import { inspectTestMainnetSwapRequest, type TestMainnetSwapScope } from '../../../src/lib/miden/sdk/test-send-request';
import { withRpcTimeout } from '../../../src/lib/miden-chain/rpc-timeout';
import { verifyMainnetMidenNoteInclusion } from './mainnet-miden-read';

export interface MainnetSwapPaybackScope extends TestMainnetSwapScope {
  noteId: string;
  orderId: string;
}

export function inspectMainnetSwapPayback(original: Note, payback: Note, scope: MainnetSwapPaybackScope): bigint {
  if (original.id().toString() !== scope.noteId) throw new Error('Original PSWAP identity changed');
  const request = new TransactionRequestBuilder()
    .withOwnOutputNotes(new NoteArray([original]))
    .withExpirationDelta(600)
    .build();
  const inspected = inspectTestMainnetSwapRequest(scope, Uint8Array.from(request.serialize()));
  if (inspected.orderId !== scope.orderId) throw new Error('Original protocol order changed');
  const actor = AccountId.fromHex(scope.accountId);
  const assets = payback.assets().fungibleAssets();
  if (
    assets.length !== 1 ||
    payback.assets().assets().length !== 1 ||
    assets[0]?.faucetId().toString() !== scope.requestedFaucetId ||
    assets[0].amount() < BigInt(scope.requestedAmount) ||
    payback.metadata().sender().toString() === scope.accountId
  )
    throw new Error('Payback asset, minimum or maker differs from the original scope');
  const amount = assets[0].amount();
  const [entropy, orderId, salt, depthEntropy] = original.recipient().serialNum().toU64s();
  if (entropy === undefined || orderId === undefined || salt === undefined || depthEntropy === undefined)
    throw new Error('Incomplete original PSWAP serial');
  const expected = Note.withAttachments(
    new NoteAssets([new FungibleAsset(AccountId.fromHex(scope.requestedFaucetId), amount)]),
    new NoteMetadata(payback.metadata().sender(), NoteType.Public, NoteTag.withAccountTarget(actor)),
    new NoteRecipient(
      new Word(new BigUint64Array([(entropy + 1n) % 0xffffffff00000001n, orderId, salt, depthEntropy])),
      NoteScript.p2id(),
      new NoteStorage(new FeltArray([actor.suffix(), actor.prefix(), new Felt(0n), new Felt(0n)]))
    ),
    [NoteAttachment.fromWord(new NoteAttachmentScheme(3), new Word(new BigUint64Array([amount, orderId, 1n, 0n])))]
  );
  if (expected.id().toString() !== payback.id().toString())
    throw new Error('Payback differs from the exact original full-fill protocol note');
  return amount;
}

export interface MainnetSwapPaybackEvidence {
  noteId: string;
  amount: bigint;
  originalCreatedAtBlock: number;
  createdAtBlock: number;
  claimedAtBlock?: number;
}

export async function readMainnetSwapPayback(
  rpcUrl: string,
  scope: MainnetSwapPaybackScope
): Promise<MainnetSwapPaybackEvidence | undefined> {
  const url = new URL(rpcUrl);
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash)
    throw new Error('Invalid public swap evidence RPC');
  const rpc = new RpcClient(new Endpoint(rpcUrl));
  const originals = await withRpcTimeout(() => rpc.getNotesById([NoteId.fromHex(scope.noteId)]), 'original PSWAP', {
    retries: 0
  });
  const original = originals[0];
  if (
    originals.length !== 1 ||
    !original?.note ||
    original.noteId.toString() !== scope.noteId ||
    original.metadata.sender().toString() !== scope.accountId
  )
    throw new Error('Missing exact original public PSWAP');
  const originalNote = original.note;
  const originalHeight = original.inclusionProof.location().blockNum();
  await verifyMainnetMidenNoteInclusion(rpcUrl, scope.noteId, originalHeight, scope.accountId);
  const consumedHeight = await withRpcTimeout(
    () => rpc.getNullifierCommitHeight(originalNote.nullifier(), originalHeight),
    'original PSWAP consumption',
    { retries: 0 }
  );
  if (consumedHeight === undefined) return undefined;
  if (!Number.isSafeInteger(consumedHeight) || consumedHeight < originalHeight)
    throw new Error('Invalid original PSWAP consumption block');
  const notes = await withRpcTimeout(
    () =>
      rpc.syncNotes(consumedHeight, consumedHeight, [NoteTag.withAccountTarget(AccountId.fromHex(scope.accountId))]),
    'exact maker-block payback candidates',
    { retries: 0 }
  );
  const ids = notes.notes().map(note => note.noteId().toString());
  if (notes.blockTo() !== consumedHeight || ids.length > 64 || new Set(ids).size !== ids.length)
    throw new Error('Ambiguous or oversized maker-block note evidence');
  if (!ids.length) return undefined;
  const fetched = await withRpcTimeout(
    () => rpc.getNotesById(ids.map(id => NoteId.fromHex(id))),
    'maker-block public notes',
    { retries: 0 }
  );
  if (
    fetched.length !== ids.length ||
    new Set(fetched.map(note => note.noteId.toString())).size !== ids.length ||
    fetched.some(note => !ids.includes(note.noteId.toString()))
  )
    throw new Error('Maker-block public note identities changed');
  const candidates = fetched.filter(
    note => note.note?.recipient().serialNum().toU64s()[1]?.toString() === scope.orderId
  );
  if (candidates.length > 1) throw new Error('Multiple paybacks for the original full-fill order');
  const candidate = candidates[0];
  if (!candidate?.note) return undefined;
  const candidateNote = candidate.note;
  if (candidateNote.id().toString() !== candidate.noteId.toString())
    throw new Error('Public payback body differs from its committed identity');
  const amount = inspectMainnetSwapPayback(originalNote, candidateNote, scope);
  if (candidate.inclusionProof.location().blockNum() !== consumedHeight)
    throw new Error('Payback does not share the original consumption block');
  const noteId = candidate.noteId.toString();
  await verifyMainnetMidenNoteInclusion(rpcUrl, noteId, consumedHeight, candidate.metadata.sender().toString());
  const claimedAtBlock = await withRpcTimeout(
    () => rpc.getNullifierCommitHeight(candidateNote.nullifier(), consumedHeight),
    'exact payback consumption',
    { retries: 0 }
  );
  return {
    noteId,
    amount,
    originalCreatedAtBlock: originalHeight,
    createdAtBlock: consumedHeight,
    ...(claimedAtBlock === undefined ? {} : { claimedAtBlock })
  };
}
