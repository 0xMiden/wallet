import {
  AccountStorageRequirements,
  BlockHeader,
  FetchedNote,
  FungibleAsset,
  NetworkAccountTarget,
  Note,
  NoteId,
  NoteScript,
  NoteTag,
  NoteType,
  RpcClient,
  Word
} from '@miden-sdk/miden-sdk/lazy';

import { ITransactionStatus } from 'lib/miden/db/types';
import * as Repo from 'lib/miden/repo';
import { accountRefToSdk } from 'lib/miden/sdk/helpers';
import { isProvable } from 'lib/miden/transaction/verdict-rules';
import { getRpcEndpoint } from 'lib/miden-chain/constants';
import { getEffectiveNetworkName } from 'lib/miden-chain/effective-endpoints';
import { withRpcTimeout } from 'lib/miden-chain/rpc-timeout';

import { buildFundedGcClaimRequest } from './funded-claim-request';
import {
  GcClaimContext,
  GcClaimEvidence,
  GcClaimIssuanceEvidence,
  GcClaimOperation,
  PreparedGcClaim,
  assertGcClaimIdentity,
  gcClaimAccount,
  gcClaimHistoryTransactionId,
  gcClaimPhase,
  gcClaimTransactionId,
  gcClaimU32,
  gcClaimWord,
  normalizeGcClaimContext
} from './gc-claim-operation';

const PAGE_BLOCKS = 128;
const MAX_CANDIDATES = 64;
const NETWORK_SLOT = 'bread::gc::network';

export interface GcClaimRecoveryConfig {
  claimScriptRoot: string;
  deploymentBlock: number;
}

export interface GcClaimReconciliation {
  state: 'pending' | 'reclaimable' | 'issued' | 'delivered' | 'reclaimed';
  evidence: GcClaimEvidence[];
  requestNoteBytes?: Uint8Array;
  receiptNoteBytes?: Uint8Array;
}

export interface GcClaimHistoryCursor {
  nextBlock: number;
  tipBlock: number;
  tipCommitment: string;
}

export interface GcClaimHistoryPage {
  requests: {
    material: Omit<PreparedGcClaim, 'requestBytes' | 'outgoingNativeAmount'>;
    noteBytes: Uint8Array;
    inclusionBlock: number;
  }[];
  unrecognizedRequestIds: string[];
  complete: boolean;
  cursor: GcClaimHistoryCursor;
}

interface ReadSession {
  rpc: RpcClient;
  identity: GcClaimContext;
  config: GcClaimRecoveryConfig;
  tip: number;
  header(block: number): Promise<BlockHeader>;
}

/** One independently scoped RPC reader per pass. Timeout abandons the read, never frees an in-flight client. */
async function readSession<T>(
  context: GcClaimContext,
  config: GcClaimRecoveryConfig,
  run: (session: ReadSession) => Promise<T>
): Promise<T> {
  const configured = {
    claimScriptRoot: gcClaimWord(config.claimScriptRoot),
    deploymentBlock: gcClaimU32(config.deploymentBlock)
  };
  if (configured.deploymentBlock < 1 || getEffectiveNetworkName() !== 'testnet')
    throw new Error('GC recovery deployment unavailable');
  const identity = await normalizeGcClaimContext(context);
  if (identity.issuerId === identity.nativeAssetId) throw new Error('Invalid GC/native identity');
  return withRpcTimeout(
    async () => {
      const rpc = new RpcClient(getRpcEndpoint());
      try {
        const genesis = await rpc.getBlockHeaderByNumber(0);
        if (gcClaimWord(genesis.commitment().toHex()) !== identity.genesisCommitment)
          throw new Error('GC recovery genesis mismatch');
        const tipHeader = await rpc.getBlockHeaderByNumber();
        const tip = gcClaimU32(tipHeader.blockNum());
        if (tip < configured.deploymentBlock) throw new Error('GC deployment not yet visible');
        const tipCommitment = gcClaimWord(tipHeader.commitment().toHex());
        const proof = await rpc.getAccountProof(
          accountRefToSdk(identity.issuerId),
          new AccountStorageRequirements(),
          tip
        );
        if (
          proof.blockNum() !== tip ||
          gcClaimAccount(proof.accountId().toString()) !== identity.issuerId ||
          proof.accountHeader()?.codeCommitment().toHex() !== identity.issuerCodeCommitment ||
          proof.getStorageSlotValue(NETWORK_SLOT)?.toHex() !== identity.genesisCommitment
        )
          throw new Error('GC recovery issuer deployment mismatch');
        const headers = new Map<number, BlockHeader>([
          [tip, tipHeader],
          [0, genesis]
        ]);
        const session: ReadSession = {
          rpc,
          identity,
          config: configured,
          tip,
          header: async block => {
            gcClaimU32(block);
            if (block > tip) throw new Error('GC recovery snapshot advanced');
            const cached = headers.get(block);
            if (cached) return cached;
            const header = await rpc.getBlockHeaderByNumber(block);
            if (header.blockNum() !== block) throw new Error('GC recovery block mismatch');
            headers.set(block, header);
            return header;
          }
        };
        const result = await run(session);
        // A reset/retarget during a pass invalidates its observations rather than releasing a retry.
        if (
          gcClaimWord((await rpc.getBlockHeaderByNumber(tip)).commitment().toHex()) !== tipCommitment ||
          gcClaimWord((await rpc.getBlockHeaderByNumber(0)).commitment().toHex()) !== identity.genesisCommitment
        )
          throw new Error('GC recovery chain changed during read');
        return result;
      } finally {
        rpc.free();
      }
    },
    'GC claim recovery',
    { retries: 0 }
  );
}

function wordFrom(values: readonly bigint[]): Word {
  if (values.length !== 4) throw new Error('Invalid GC claim word');
  return new Word(new BigUint64Array(values));
}

async function publicNote(session: ReadSession, fetched: FetchedNote): Promise<{ note: Note; block: number }> {
  const note = fetched.note;
  if (note === undefined || fetched.noteType !== NoteType.Public || note.metadata().noteType() !== NoteType.Public) {
    throw new Error('GC public note body unavailable');
  }
  const block = gcClaimU32(fetched.inclusionProof.location().blockNum());
  const index = gcClaimU32(fetched.inclusionProof.location().blockNoteTreeIndex());
  const header = await session.header(block);
  if (
    block < session.config.deploymentBlock ||
    note.id().toString() !== fetched.noteId.toString() ||
    !fetched.inclusionProof.notePath().verify(BigInt(index), note.commitment(), header.noteRoot())
  )
    throw new Error('GC note inclusion proof mismatch');
  return { note, block };
}

function decodeRequest(session: ReadSession, note: Note): GcClaimHistoryPage['requests'][number]['material'] {
  const { identity } = session;
  const fields = note
    .recipient()
    .storage()
    .items()
    .map(item => item.asInt());
  const target = note.attachments();
  const sender = accountRefToSdk(identity.accountId);
  const assets = note.assets().fungibleAssets();
  if (
    note.script().root().toHex() !== session.config.claimScriptRoot ||
    fields.length !== 36 ||
    gcClaimAccount(note.metadata().sender().toString()) !== identity.accountId ||
    note.metadata().tag().asU32() !== NoteTag.withAccountTarget(accountRefToSdk(identity.issuerId)).asU32() ||
    !note.isNetworkNote() ||
    target.length !== 1 ||
    gcClaimAccount(NetworkAccountTarget.fromAttachment(target[0]!).targetId().toString()) !== identity.issuerId ||
    wordFrom(fields.slice(0, 4)).toHex() !== NoteScript.p2id().root().toHex() ||
    wordFrom(fields.slice(24, 28)).toHex() !== identity.issuerCodeCommitment ||
    wordFrom(fields.slice(32, 36)).toHex() !== identity.genesisCommitment ||
    fields[20] !== sender.suffix().asInt() ||
    fields[21] !== sender.prefix().asInt() ||
    fields[29] !== 1n ||
    [17, 18, 19, 30, 31].some(index => fields[index] !== 0n) ||
    note.assets().nonFungibleAssets().length !== 0 ||
    assets.length !== 1 ||
    gcClaimAccount(assets[0]!.faucetId().toString()) !== identity.nativeAssetId ||
    assets[0]!.amount() <= 0n
  )
    throw new Error('GC request does not match the approved funded ABI');
  const allocation = FungibleAsset.fromVaultEntry(wordFrom(fields.slice(8, 12)), wordFrom(fields.slice(12, 16)));
  if (gcClaimAccount(allocation.faucetId().toString()) !== identity.issuerId || allocation.amount() !== 10_000_000n) {
    throw new Error('Invalid GC request allocation');
  }
  const approvedWeek = gcClaimU32(Number(fields[22]));
  const approvalExpiresAt = gcClaimU32(Number(fields[23]));
  const reclaimHeight = gcClaimU32(Number(fields[28]));
  if (reclaimHeight === 0) throw new Error('GC request is not reclaimable');
  gcClaimU32(Number(fields[16]));
  const canonical = buildFundedGcClaimRequest({
    issuerId: identity.issuerId,
    nativeAssetId: identity.nativeAssetId,
    issuerCodeCommitment: identity.issuerCodeCommitment,
    genesisCommitment: identity.genesisCommitment,
    accountId: identity.accountId,
    approvedWeek,
    approvalExpiresAt,
    reclaimHeight,
    receiptTag: Number(fields[16]),
    nativeBudget: assets[0]!.amount(),
    serial: Array.from(note.recipient().serialNum().toU64s()),
    claimScriptBytes: note.script().serialize(),
    claimScriptRoot: session.config.claimScriptRoot
  });
  const bytes = note.serialize();
  if (canonical.noteBytes.length !== bytes.length || canonical.noteBytes.some((byte, index) => byte !== bytes[index])) {
    throw new Error('GC request is not the canonical approved preimage');
  }
  return {
    scope: {
      genesisCommitment: identity.genesisCommitment,
      accountId: identity.accountId,
      issuerId: identity.issuerId,
      approvedWeek
    },
    issuerCodeCommitment: identity.issuerCodeCommitment,
    nativeAssetId: identity.nativeAssetId,
    requestNoteId: gcClaimWord(note.id().toString()),
    receiptRecipientCommitment: gcClaimWord(canonical.receiptRecipientCommitment),
    nativeBudget: assets[0]!.amount(),
    approvalExpiresAt,
    reclaimHeight
  };
}

async function ownConsume(session: ReadSession, noteId: string, nullifier: string, height: number) {
  const [batch, single] = await Promise.all([
    Repo.transactions.where('noteIds').equals(noteId).toArray(),
    Repo.transactions.where('noteId').equals(noteId).toArray()
  ]);
  const rows = [...new Map([...batch, ...single].map(row => [row.id, row])).values()];
  const matches: { transactionId: string; referenceBlock: number }[] = [];
  for (const row of rows) {
    if (
      (row.type !== 'consume' && row.type !== 'execute') ||
      row.status !== ITransactionStatus.Completed ||
      row.restoredFromBackup === true ||
      gcClaimAccount(row.accountId) !== session.identity.accountId ||
      row.transactionId === undefined
    )
      continue;
    const entry = (row.submitEvidence ?? []).find(
      candidate =>
        isProvable(candidate) &&
        candidate.verdict === undefined &&
        candidate.transactionId === row.transactionId &&
        candidate.nullifiers.some(value => gcClaimWord(value) === nullifier) &&
        candidate.refBlock < height &&
        (candidate.expirationBlock === undefined || candidate.expirationBlock >= height) &&
        (candidate.landingSeenAtBlock === undefined || candidate.landingSeenAtBlock === height)
    );
    if (!entry || !isProvable(entry)) continue;
    if (
      gcClaimWord((await session.header(entry.refBlock)).commitment().toHex()) !== gcClaimWord(entry.refBlockCommitment)
    )
      continue;
    matches.push({ transactionId: gcClaimWord(row.transactionId), referenceBlock: entry.refBlock });
  }
  if (new Set(matches.map(match => match.transactionId)).size !== 1) return undefined;
  return matches[0];
}

/** A local reclaim without a final absence proof may still reach the chain. */
async function hasPendingReclaim(session: ReadSession, operation: GcClaimOperation): Promise<boolean> {
  const originalId =
    operation.recoveredHistory === true
      ? gcClaimHistoryTransactionId(operation)
      : gcClaimTransactionId(operation.scope, operation.attempt ?? 0);
  const rows = await Repo.transactions.where('noteIds').equals(operation.requestNoteId).limit(65).toArray();
  if (rows.length > 64) throw new Error('GC reclaim history exceeds the bounded read limit');
  return rows.some(
    row =>
      row.gcReclaimOf === originalId &&
      gcClaimAccount(row.accountId) === session.identity.accountId &&
      gcClaimPhase({
        ...row,
        gcClaim: {
          ...operation,
          historyInclusionBlock: undefined,
          issuance: undefined,
          delivery: undefined,
          reclaim: undefined
        }
      }) !== 'retryable'
  );
}

async function fetchCandidates(session: ReadSession, tagValue: number, from: number, to: number, sender: string) {
  const sync = await session.rpc.syncNotes(from, to, [new NoteTag(tagValue)]);
  if (sync.blockTo() !== to) throw new Error('Incomplete GC note history range');
  const ids = [
    ...new Set(
      sync
        .notes()
        .filter(note => note.tag() === tagValue && gcClaimAccount(note.sender().toString()) === sender)
        .map(note => gcClaimWord(note.noteId().toString()))
    )
  ];
  if (ids.length > MAX_CANDIDATES) throw new Error('GC note history page exceeds the bounded read limit');
  if (ids.length === 0) return [];
  const fetched = await session.rpc.getNotesById(ids.map(id => NoteId.fromHex(id)));
  if (
    fetched.length !== ids.length ||
    new Set(fetched.map(note => note.noteId.toString())).size !== ids.length ||
    fetched.some(note => !ids.includes(gcClaimWord(note.noteId.toString())))
  )
    throw new Error('Incomplete GC note bodies');
  return fetched;
}

export async function reconcileGcClaim(
  context: GcClaimContext,
  operation: GcClaimOperation,
  config: GcClaimRecoveryConfig
): Promise<GcClaimReconciliation> {
  const expected = { ...operation, scope: { ...operation.scope } };
  return readSession(context, config, async session => {
    assertGcClaimIdentity(expected, session.identity);
    const requestedId = gcClaimWord(expected.requestNoteId);
    const fetched = await session.rpc.getNotesById([NoteId.fromHex(requestedId)]);
    if (fetched.length === 0) return { state: 'pending', evidence: [] };
    if (fetched.length !== 1 || fetched[0]!.noteId.toString() !== requestedId)
      throw new Error('GC request lookup mismatch');
    const request = await publicNote(session, fetched[0]!);
    const material = decodeRequest(session, request.note);
    if (
      material.scope.approvedWeek !== expected.scope.approvedWeek ||
      material.nativeBudget !== expected.nativeBudget ||
      material.approvalExpiresAt !== expected.approvalExpiresAt ||
      material.reclaimHeight !== expected.reclaimHeight ||
      material.receiptRecipientCommitment !== expected.receiptRecipientCommitment
    )
      throw new Error('GC request preimage does not match its durable operation');
    const requestNoteBytes = request.note.serialize();
    const requestNullifier = gcClaimWord(request.note.nullifier().toHex());
    const spent = await session.rpc.getNullifierCommitHeight(Word.fromHex(requestNullifier), request.block);
    if (spent === undefined) {
      return {
        state:
          session.tip >= material.reclaimHeight && !(await hasPendingReclaim(session, expected))
            ? 'reclaimable'
            : 'pending',
        evidence: [],
        requestNoteBytes
      };
    }
    gcClaimU32(spent);
    if (spent < request.block || spent > session.tip) throw new Error('GC request spend outside snapshot');
    const receiptTag = gcClaimU32(Number(request.note.recipient().storage().items()[16]!.asInt()));
    const candidates = await fetchCandidates(session, receiptTag, spent, spent, session.identity.issuerId);
    const receipts: { note: Note; refund: bigint }[] = [];
    for (const candidate of candidates) {
      const receipt = await publicNote(session, candidate);
      if (
        receipt.block !== spent ||
        gcClaimAccount(receipt.note.metadata().sender().toString()) !== session.identity.issuerId ||
        receipt.note.recipient().digest().toHex() !== expected.receiptRecipientCommitment
      )
        continue;
      const assets = receipt.note.assets().fungibleAssets();
      const gc = assets.filter(asset => gcClaimAccount(asset.faucetId().toString()) === session.identity.issuerId);
      const native = assets.filter(
        asset => gcClaimAccount(asset.faucetId().toString()) === session.identity.nativeAssetId
      );
      const refund = native[0]?.amount() ?? 0n;
      if (
        receipt.note.script().root().toHex() !== NoteScript.p2id().root().toHex() ||
        receipt.note.metadata().tag().asU32() !== receiptTag ||
        receipt.note.attachments().length !== 0 ||
        receipt.note.recipient().serialNum().toHex() !==
          wordFrom(
            request.note
              .recipient()
              .storage()
              .items()
              .slice(4, 8)
              .map(value => value.asInt())
          ).toHex() ||
        receipt.note.assets().nonFungibleAssets().length !== 0 ||
        gc.length !== 1 ||
        gc[0]!.amount() !== 10_000_000n ||
        native.length > 1 ||
        assets.length !== gc.length + native.length ||
        refund < 0n ||
        refund > expected.nativeBudget
      )
        throw new Error('Invalid GC/refund receipt');
      receipts.push({ note: receipt.note, refund });
    }
    if (receipts.length > 1) throw new Error('Ambiguous GC claim receipt');
    const anchor = {
      genesisCommitment: session.identity.genesisCommitment,
      blockNumber: spent,
      blockCommitment: gcClaimWord((await session.header(spent)).commitment().toHex()),
      accountId: session.identity.accountId
    };
    const receipt = receipts[0];
    if (!receipt) {
      const consume = await ownConsume(session, requestedId, requestNullifier, spent);
      if (consume && consume.referenceBlock >= expected.reclaimHeight)
        return {
          state: 'reclaimed',
          requestNoteBytes,
          evidence: [
            {
              ...anchor,
              kind: 'reclaimed',
              requestNoteId: requestedId,
              requestNullifier,
              transactionId: consume.transactionId,
              referenceBlock: consume.referenceBlock
            }
          ]
        };
      return { state: 'pending', evidence: [], requestNoteBytes };
    }
    const receiptId = gcClaimWord(receipt.note.id().toString());
    const issuance: GcClaimIssuanceEvidence = {
      ...anchor,
      kind: 'issued',
      requestNoteId: requestedId,
      requestNullifier,
      issuerId: session.identity.issuerId,
      receiptNoteId: receiptId,
      receiptRecipientCommitment: expected.receiptRecipientCommitment,
      gcAmount: 10_000_000n,
      nativeRefund: receipt.refund,
      issuerFee: expected.nativeBudget - receipt.refund
    };
    const receiptNullifier = gcClaimWord(receipt.note.nullifier().toHex());
    const received = await session.rpc.getNullifierCommitHeight(Word.fromHex(receiptNullifier), spent);
    const evidence: GcClaimEvidence[] = [issuance];
    const receiptNoteBytes = receipt.note.serialize();
    if (received !== undefined) {
      gcClaimU32(received);
      if (received < spent || received > session.tip) throw new Error('GC receipt spend outside snapshot');
      const consume = await ownConsume(session, receiptId, receiptNullifier, received);
      if (consume) {
        evidence.push({
          genesisCommitment: session.identity.genesisCommitment,
          blockNumber: received,
          blockCommitment: gcClaimWord((await session.header(received)).commitment().toHex()),
          kind: 'delivered',
          transactionId: consume.transactionId,
          accountId: session.identity.accountId,
          receiptNoteId: receiptId,
          receiptNullifier
        });
        return { state: 'delivered', evidence, requestNoteBytes, receiptNoteBytes };
      }
    }
    return { state: 'issued', evidence, requestNoteBytes, receiptNoteBytes };
  });
}

export async function scanGcClaimHistoryPage(
  context: GcClaimContext,
  config: GcClaimRecoveryConfig,
  cursor?: GcClaimHistoryCursor
): Promise<GcClaimHistoryPage> {
  const continuation = cursor && { ...cursor };
  return readSession(context, config, async session => {
    let tipBlock = session.tip;
    if (continuation) {
      const previousTip = gcClaimU32(continuation.tipBlock);
      if (
        gcClaimWord((await session.header(previousTip)).commitment().toHex()) !==
        gcClaimWord(continuation.tipCommitment)
      ) {
        throw new Error('GC history snapshot changed');
      }
      if (continuation.nextBlock <= previousTip) tipBlock = previousTip;
      else if (continuation.nextBlock !== previousTip + 1) throw new Error('Invalid GC history continuation');
    }
    const tipCommitment = gcClaimWord((await session.header(tipBlock)).commitment().toHex());
    const from = continuation ? gcClaimU32(continuation.nextBlock) : session.config.deploymentBlock;
    if (from < session.config.deploymentBlock || from > tipBlock + 1) throw new Error('Invalid GC history cursor');
    const to = Math.min(tipBlock, from + PAGE_BLOCKS - 1);
    const requests: GcClaimHistoryPage['requests'] = [];
    const unrecognizedRequestIds: string[] = [];
    if (from <= to) {
      const candidates = await fetchCandidates(
        session,
        NoteTag.withAccountTarget(accountRefToSdk(session.identity.issuerId)).asU32(),
        from,
        to,
        session.identity.accountId
      );
      for (const candidate of candidates) {
        const fetched = await publicNote(session, candidate);
        if (fetched.block < from || fetched.block > to) throw new Error('GC history note outside requested page');
        if (fetched.note.script().root().toHex() !== session.config.claimScriptRoot) continue;
        try {
          requests.push({
            material: decodeRequest(session, fetched.note),
            noteBytes: fetched.note.serialize(),
            inclusionBlock: fetched.block
          });
        } catch (error) {
          if (error instanceof WebAssembly.RuntimeError) throw error;
          // An invalid public request is not an entitlement, but must not disappear from recovery diagnostics.
          unrecognizedRequestIds.push(gcClaimWord(fetched.note.id().toString()));
        }
      }
    }
    return {
      requests,
      unrecognizedRequestIds,
      complete: to >= tipBlock,
      cursor: { nextBlock: to + 1, tipBlock, tipCommitment }
    };
  });
}
