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
import type { MainnetSwapCheckpoint } from './mainnet-swap-checkpoint';
import { SWAP_LOSS_CAP, SWAP_TX_FEE_MULTIPLE } from './mainnet-swap-plan';

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
  originalNoteId: string;
  orderId: string;
  serialZeroOrderId: string;
  noteId: string;
  amount: bigint;
  originalCreatedAtBlock: number;
  createdAtBlock: number;
  claimedAtBlock?: number;
}

export interface MainnetSwapBalances { offer: bigint; request: bigint; native: bigint; }

export function authorizeMainnetSwapRecoveryReturn(
  state: MainnetSwapCheckpoint,
  evidence: MainnetSwapPaybackEvidence,
  balances: MainnetSwapBalances,
  runId: string,
  authorizedAt: string
): MainnetSwapCheckpoint {
  const original = state.forwardRequestAuthority;
  if (state.phase !== 'forward-authorized' || !original || state.recoveryReturnAuthorizedAt !== undefined ||
    state.reverseRequestAuthority !== undefined || state.reverseOrderId !== undefined || state.returnAmount !== undefined || state.returnBaseline !== undefined)
    throw new Error('Recovery return already prepared or issued; never renew its authority');
  if (!/^\d{1,25}$/.test(runId) || runId === state.sourceRunId || !Number.isFinite(Date.parse(authorizedAt)) || Date.parse(authorizedAt) < Date.parse(state.updatedAt))
    throw new Error('Invalid first recovery grant identity or time');
  if (evidence.originalNoteId !== original.noteId ||
    ![evidence.orderId, evidence.serialZeroOrderId].includes(original.orderId) ||
    state.forwardOrderId !== original.orderId || evidence.claimedAtBlock === undefined ||
    ![evidence.originalCreatedAtBlock, evidence.createdAtBlock, evidence.claimedAtBlock].every(height => Number.isSafeInteger(height) && height > 0) ||
    evidence.createdAtBlock < evidence.originalCreatedAtBlock || evidence.claimedAtBlock < evidence.createdAtBlock ||
    evidence.amount < BigInt(original.minimumReceive))
    throw new Error('Original recovery proceeds or protocol identity are not proved');
  if (state.offer.hex !== state.native.hex || state.request.hex === state.native.hex || state.offer.balance !== state.native.balance ||
    state.offer.usdMicros !== state.native.usdMicros || state.offer.decimals !== state.native.decimals ||
    balances.offer !== balances.native || balances.request - BigInt(state.request.balance) !== evidence.amount ||
    (state.forwardRefunded !== undefined && state.forwardRefunded !== '0') ||
    (state.forwardReceived !== undefined && state.forwardReceived !== evidence.amount.toString()))
    throw new Error('Original recovery vault balances contain unrelated proceeds or debits');
  const costs = BigInt(state.native.balance) - balances.native - BigInt(state.principal);
  if (costs < 0n || costs < BigInt(state.paidFees) || costs > BigInt(state.feeBudget) ||
    BigInt(state.feeBudget) - costs < 2n * SWAP_TX_FEE_MULTIPLE * BigInt(state.baseFee))
    throw new Error('Original recovery cost or remaining native fee reserve is unsafe');
  const unit = 10n ** BigInt(state.native.decimals);
  const price = BigInt(state.native.usdMicros);
  const loss = BigInt(state.principal) - BigInt(state.reverseMinimum);
  const projected = ((loss > 0n ? loss : 0n) * price + unit - 1n) / unit + (BigInt(state.feeBudget) * price + unit - 1n) / unit;
  if (projected > SWAP_LOSS_CAP || BigInt(state.reverseMinimum) * price / unit < 1_000_000n)
    throw new Error('Original recovery price envelope exceeds the loss budget or wallet minimum');
  return {
    ...state, phase: 'reverse-authorized', authorizationRunId: runId, recoveredRunId: runId,
    recoveryReturnAuthorizedAt: authorizedAt, updatedAt: authorizedAt,
    forwardOrderId: evidence.orderId, forwardRequestAuthority: { ...original, orderId: evidence.orderId },
    forwardReceived: evidence.amount.toString(), forwardRefunded: '0', paidFees: costs.toString(),
    returnAmount: evidence.amount.toString(),
    returnBaseline: { offer: balances.offer.toString(), request: balances.request.toString(), native: balances.native.toString() }
  };
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
  const [serialZero, protocolOrder] = originalNote.recipient().serialNum().toU64s();
  if (serialZero === undefined || protocolOrder === undefined || ![serialZero.toString(), protocolOrder.toString()].includes(scope.orderId))
    throw new Error('Original recorded protocol identity is not committed by its exact note');
  const exactScope = { ...scope, orderId: protocolOrder.toString() };
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
    note => note.note?.recipient().serialNum().toU64s()[1]?.toString() === exactScope.orderId
  );
  if (candidates.length > 1) throw new Error('Multiple paybacks for the original full-fill order');
  const candidate = candidates[0];
  if (!candidate?.note) return undefined;
  const candidateNote = candidate.note;
  if (candidateNote.id().toString() !== candidate.noteId.toString())
    throw new Error('Public payback body differs from its committed identity');
  const amount = inspectMainnetSwapPayback(originalNote, candidateNote, exactScope);
  if (candidate.inclusionProof.location().blockNum() !== consumedHeight)
    throw new Error('Payback does not share the original consumption block');
  const noteId = candidate.noteId.toString();
  await verifyMainnetMidenNoteInclusion(rpcUrl, noteId, consumedHeight, candidate.metadata.sender().toString());
  const claimedAtBlock = await withRpcTimeout(
    () => rpc.getNullifierCommitHeight(candidateNote.nullifier(), consumedHeight),
    'exact payback consumption',
    { retries: 0 }
  );
  const serialZeroOrderId = originalNote.recipient().serialNum().toU64s()[0]?.toString();
  if (serialZeroOrderId === undefined) throw new Error('Missing original serial identity');
  return {
    originalNoteId: scope.noteId,
    orderId: exactScope.orderId,
    serialZeroOrderId,
    noteId,
    amount,
    originalCreatedAtBlock: originalHeight,
    createdAtBlock: consumedHeight,
    ...(claimedAtBlock === undefined ? {} : { claimedAtBlock })
  };
}
