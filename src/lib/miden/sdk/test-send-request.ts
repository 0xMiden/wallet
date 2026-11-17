import {
  AccountId,
  AdviceMap,
  Felt,
  FeltArray,
  FungibleAsset,
  Note,
  NoteAndArgs,
  NoteAndArgsArray,
  NoteArray,
  NoteAssets,
  NoteAttachment,
  NoteMetadata,
  NoteRecipient,
  NoteScript,
  NoteStorage,
  NoteTag,
  NoteType,
  TransactionRequest,
  TransactionRequestBuilder,
  Word
} from '@miden-sdk/miden-sdk/lazy';

import { testRequestSha256 } from './test-request-sha256';
import { canonicalRequestBytes } from '../../../../scripts/canonical-request-bytes.mjs';

export interface TestMainnetSendScope {
  accountId: string;
  recipientId: string;
  faucetId: string;
  amount: string;
}

export function withTestGuardianAuthentication(
  builder: TransactionRequestBuilder,
  request: TransactionRequest
): TransactionRequestBuilder {
  const auth = request.authArg();
  const advice = request.adviceMap();
  const preimage = auth ? advice.get(auth) : undefined;
  const blocks = request.blockNumbers();
  if (
    !preimage ||
    preimage.length === 0 ||
    preimage.length % 4 !== 0 ||
    request.feeConversionSalt() ||
    blocks.length > 8 ||
    blocks.some(block => !Number.isSafeInteger(block) || block < 0)
  )
    throw new Error('Invalid final Guardian authentication metadata');
  return builder.withAuthArgs(new FeltArray(preimage)).withBlockNumbers(blocks).extendAdviceMap(advice);
}

export function inspectTestMainnetSendRequest(
  scope: TestMainnetSendScope,
  bytes: Uint8Array,
  guardian = false
): string {
  if (
    ![scope.accountId, scope.recipientId, scope.faucetId].every(id => /^0x[0-9a-f]{30}$/.test(id)) ||
    scope.accountId === scope.recipientId ||
    !/^[1-9]\d{0,18}$/.test(scope.amount) ||
    !(bytes instanceof Uint8Array) ||
    bytes.length < 1 ||
    bytes.length > 1_048_576
  )
    throw new Error('Invalid native send request scope');
  const request = TransactionRequest.deserialize(bytes);
  const notes = request.expectedOutputOwnNotes();
  const note = notes[0];
  if (notes.length !== 1 || !note) throw new Error('Native send must contain exactly one authorized output');
  const template = Note.createP2IDNote(
    AccountId.fromHex(scope.accountId),
    AccountId.fromHex(scope.recipientId),
    new NoteAssets([new FungibleAsset(AccountId.fromHex(scope.faucetId), BigInt(scope.amount))]),
    NoteType.Public,
    new NoteAttachment()
  );
  // The SDK chose the live serial; every other field must match the exact authorized route.
  const expectedRecipient = new NoteRecipient(
    note.recipient().serialNum(),
    template.script(),
    template.recipient().storage()
  );
  // Guardian SDK P2ID notes have no attachments; standalone SDK sends carry one empty attachment.
  const expectedNote = guardian
    ? new Note(template.assets(), template.metadata(), expectedRecipient)
    : Note.withAttachments(template.assets(), template.metadata(), expectedRecipient, template.attachments());
  let builder = new TransactionRequestBuilder().withOwnOutputNotes(new NoteArray([expectedNote]));
  // Guardian rebasing keeps the note and binds expiration in auth args, not a tip-relative request delta.
  builder = guardian ? withTestGuardianAuthentication(builder, request) : builder.withExpirationDelta(600);
  const expected = builder.build();
  const actualBytes = canonicalRequestBytes(bytes);
  const expectedBytes = canonicalRequestBytes(Uint8Array.from(expected.serialize()));
  if (
    actualBytes.length !== expectedBytes.length ||
    actualBytes.some((value, index) => value !== expectedBytes[index])
  ) {
    const equal = (left: Uint8Array, right: Uint8Array) =>
      left.length === right.length && left.every((value, index) => value === right[index]);
    const differences: string[] = [];
    // NoteArray transfers WASM ownership; inspect a fresh getter copy, not the consumed builder input.
    const expectedOutput = expected.expectedOutputOwnNotes()[0];
    if (!equal(note.serialize(), expectedOutput.serialize())) differences.push('note');
    if (note.recipient().digest().toHex() !== expectedOutput.recipient().digest().toHex())
      differences.push('recipient');
    if (note.metadata().sender().toString() !== expectedOutput.metadata().sender().toString())
      differences.push('sender');
    if (note.metadata().noteType() !== expectedOutput.metadata().noteType()) differences.push('visibility');
    if (note.metadata().tag().asU32() !== expectedOutput.metadata().tag().asU32()) differences.push('tag');
    if (note.attachments().length !== expectedOutput.attachments().length) differences.push('attachments');
    if (request.authArg()?.toHex() !== expected.authArg()?.toHex()) differences.push('auth');
    if (request.scriptArg()?.toHex() !== expected.scriptArg()?.toHex()) differences.push('script');
    if (JSON.stringify(request.blockNumbers()) !== JSON.stringify(expected.blockNumbers())) differences.push('blocks');
    if (request.expectedFutureNotes().length !== expected.expectedFutureNotes().length) differences.push('future');
    if (!equal(actualBytes, canonicalRequestBytes(Uint8Array.from(request.serialize())))) differences.push('roundtrip');
    if (guardian) {
      // Mainnet fee policy publicly caps proofs at 20 blocks; test exact equality, never accept this candidate.
      const feeBound = withTestGuardianAuthentication(
        new TransactionRequestBuilder()
          .withOwnOutputNotes(new NoteArray(expected.expectedOutputOwnNotes()))
          .withExpirationDelta(20),
        request
      ).build();
      if (equal(actualBytes, canonicalRequestBytes(Uint8Array.from(feeBound.serialize()))))
        differences.push('fee-policy-expiration');
    }
    try {
      // Locate the advice-map boundary by changing only a fixed public diagnostic entry in a copy.
      const adviceStart = (original: TransactionRequest, originalBytes: Uint8Array) => {
        const marker = new AdviceMap();
        marker.insert(Word.fromHex(`0x${'11'.repeat(32)}`), new FeltArray([new Felt(1n)]));
        const changed = canonicalRequestBytes(Uint8Array.from(original.extendAdviceMap(marker).serialize()));
        const at = originalBytes.findIndex((value, index) => value !== changed[index]);
        if (at < 0) throw new Error('Diagnostic request layout unavailable');
        return at;
      };
      // SDK usize collections use vint64; MerkleStore alone retains its fixed u64 node count.
      const countSize = (bytes: Uint8Array, at: number) => {
        if (at < 0 || at >= bytes.length) throw new Error('Diagnostic request layout unavailable');
        let size = 1;
        while (size <= 8 && ((bytes[at] >> (size - 1)) & 1) === 0) size++;
        if (at + size > bytes.length) throw new Error('Diagnostic request layout unavailable');
        return size;
      };
      const count = (bytes: Uint8Array, at: number) => {
        const size = countSize(bytes, at);
        let raw = 0n;
        for (let index = size - 1; index >= (size === 9 ? 1 : 0); index--)
          raw = (raw << 8n) | BigInt(bytes[at + index]);
        const value = Number(size === 9 ? raw : raw >> BigInt(size));
        if (!Number.isSafeInteger(value) || value > bytes.length)
          throw new Error('Diagnostic request layout unavailable');
        return value;
      };
      const check128 = new Uint8Array(129);
      check128.set([2, 2]);
      if (count(Uint8Array.of(1), 0) !== 0 || count(Uint8Array.of(3), 0) !== 1 || count(check128, 0) !== 128)
        throw new Error('Diagnostic request layout unavailable');
      const storeEnd = (bytes: Uint8Array, at: number) => {
        if (at + 8 > bytes.length) throw new Error('Diagnostic request layout unavailable');
        const nodes = Number(new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getBigUint64(at, true));
        if (!Number.isSafeInteger(nodes) || nodes > bytes.length / 96)
          throw new Error('Diagnostic request layout unavailable');
        return at + 8 + nodes * 96;
      };
      const adviceEnd = (bytes: Uint8Array, start: number) => {
        let at = start + countSize(bytes, start);
        for (let left = count(bytes, start); left > 0; left--) {
          at += 32;
          at += countSize(bytes, at) + count(bytes, at) * 8;
          if (at > bytes.length) throw new Error('Diagnostic request layout unavailable');
        }
        return at;
      };
      let a = adviceStart(request, actualBytes),
        e = adviceStart(expected, expectedBytes);
      if (!equal(actualBytes.subarray(0, a), expectedBytes.subarray(0, e))) differences.push('request-prefix');
      const section = (code: string, nextA: number, nextE: number) => {
        if (nextA > actualBytes.length || nextE > expectedBytes.length)
          throw new Error('Diagnostic request layout unavailable');
        if (!equal(actualBytes.subarray(a, nextA), expectedBytes.subarray(e, nextE))) differences.push(code);
        a = nextA;
        e = nextE;
      };
      section('advice', adviceEnd(actualBytes, a), adviceEnd(expectedBytes, e));
      section('merkle', storeEnd(actualBytes, a), storeEnd(expectedBytes, e));
      if (count(actualBytes, a) || count(expectedBytes, e)) {
        differences.push('foreign');
      } else {
        section('foreign', a + countSize(actualBytes, a), e + countSize(expectedBytes, e));
        section('expiration', a + 1 + (actualBytes[a] === 1 ? 2 : 0), e + 1 + (expectedBytes[e] === 1 ? 2 : 0));
        section('ignore-inputs', a + 1, e + 1);
        for (const code of ['script', 'auth', 'fee-salt'])
          section(code, a + 1 + (actualBytes[a] === 1 ? 32 : 0), e + 1 + (expectedBytes[e] === 1 ? 32 : 0));
        if (count(actualBytes, a) || count(expectedBytes, e)) differences.push('network-scripts');
        else {
          section('network-scripts', a + countSize(actualBytes, a), e + countSize(expectedBytes, e));
          if (actualBytes[a] || expectedBytes[e]) differences.push('account-upgrade');
          else section('account-upgrade', a + 1, e + 1);
          if (a !== actualBytes.length || e !== expectedBytes.length) differences.push('layout-unknown');
        }
      }
    } catch {
      differences.push('layout-unknown');
    }
    if (!differences.length) differences.push('other');
    throw new Error(
      `Actual native send bytes differ from the exact authorized request; NativeSendDifference:${differences.join(',')}`
    );
  }
  return note.id().toString();
}

export interface TestMainnetSwapScope {
  kind: 'swap';
  accountId: string;
  faucetId: string;
  amount: string;
  requestedFaucetId: string;
  requestedAmount: string;
}

export function inspectTestMainnetSwapRequest(
  scope: TestMainnetSwapScope,
  bytes: Uint8Array,
  guardian = false
): { noteId: string; orderId: string } {
  if (
    scope.kind !== 'swap' ||
    ![scope.accountId, scope.faucetId, scope.requestedFaucetId].every(id => /^0x[0-9a-f]{30}$/.test(id)) ||
    scope.faucetId === scope.requestedFaucetId ||
    ![scope.amount, scope.requestedAmount].every(value => /^[1-9]\d{0,18}$/.test(value)) ||
    !(bytes instanceof Uint8Array) ||
    bytes.length < 1 ||
    bytes.length > 1_048_576
  )
    throw new Error('Invalid PSWAP request scope');
  const request = TransactionRequest.deserialize(bytes);
  const notes = request.expectedOutputOwnNotes();
  const note = notes[0];
  if (notes.length !== 1 || !note) throw new Error('PSWAP must contain exactly one authorized output');
  const creator = AccountId.fromHex(scope.accountId);
  const offered = new FungibleAsset(AccountId.fromHex(scope.faucetId), BigInt(scope.amount));
  const requested = new FungibleAsset(AccountId.fromHex(scope.requestedFaucetId), BigInt(scope.requestedAmount));
  const script = NoteScript.pswap();
  const root = script.root().serialize();
  const useCase = BigInt(new DataView(root.buffer, root.byteOffset, root.byteLength).getUint16(0) >>> 2);
  const tag =
    (1n << 30n) |
    (useCase << 16n) |
    ((offered.faucetId().prefix().asInt() >> 56n) << 8n) |
    (requested.faucetId().prefix().asInt() >> 56n);
  // Canonical PSWAP layout/tag from the installed standards; only its live serial is preserved.
  const storage = new NoteStorage(
    new FeltArray([
      requested.faucetId().suffix(),
      requested.faucetId().prefix(),
      new Felt(requested.amount()),
      new Felt(0n),
      new Felt(1n),
      creator.suffix(),
      creator.prefix()
    ])
  );
  const expectedNote = new Note(
    new NoteAssets([offered]),
    new NoteMetadata(creator, NoteType.Public, new NoteTag(Number(tag))),
    new NoteRecipient(note.recipient().serialNum(), script, storage)
  );
  let builder = new TransactionRequestBuilder().withOwnOutputNotes(new NoteArray([expectedNote]));
  builder = guardian ? withTestGuardianAuthentication(builder, request) : builder.withExpirationDelta(600);
  const expected = builder.build();
  const actualBytes = canonicalRequestBytes(bytes);
  const expectedBytes = canonicalRequestBytes(Uint8Array.from(expected.serialize()));
  if (actualBytes.length !== expectedBytes.length || actualBytes.some((value, index) => value !== expectedBytes[index]))
    throw new Error('Actual PSWAP bytes differ from the exact reviewed request');
  const orderId = note.recipient().serialNum().toU64s()[1];
  if (orderId === undefined) throw new Error('Missing actual PSWAP order serial');
  return { noteId: note.id().toString(), orderId: orderId.toString() };
}

export interface TestMainnetEpochScope {
  kind: 'epoch';
  accountId: string;
  faucetId: string;
  amount: string;
  noteId: string;
}

export async function inspectTestMainnetEpochRequest(
  scope: TestMainnetEpochScope,
  bytes: Uint8Array
): Promise<{ noteId: string }> {
  if (
    scope.kind !== 'epoch' ||
    ![scope.accountId, scope.faucetId].every(id => /^0x[0-9a-f]{30}$/.test(id)) ||
    !/^[1-9]\d{0,18}$/.test(scope.amount) ||
    !/^0x[0-9a-f]{64}$/.test(scope.noteId) ||
    !(bytes instanceof Uint8Array) ||
    bytes.length < 1 ||
    bytes.length > 1_048_576
  )
    throw new Error('Invalid final Epoch request scope');
  const request = TransactionRequest.deserialize(bytes);
  const notes = request.expectedOutputOwnNotes();
  const note = notes[0];
  if (
    notes.length !== 1 ||
    !note ||
    note.id().toString() !== scope.noteId ||
    note.metadata().sender().toString() !== scope.accountId
  )
    throw new Error('Final Epoch collateral differs from the entire reviewed note');
  const assets = note.assets().fungibleAssets();
  const asset = assets[0];
  if (
    note.assets().assets().length !== 1 ||
    assets.length !== 1 ||
    !asset ||
    asset.faucetId().toString() !== scope.faucetId ||
    asset.amount() !== BigInt(scope.amount)
  )
    throw new Error('Final Epoch asset or principal differs from its reviewed scope');
  const builder = new TransactionRequestBuilder().withOwnOutputNotes(new NoteArray([note]));
  const expected = withTestGuardianAuthentication(builder, request).build();
  const actualBytes = canonicalRequestBytes(bytes);
  const expectedBytes = canonicalRequestBytes(expected.serialize());
  if (actualBytes.length !== expectedBytes.length || actualBytes.some((value, index) => value !== expectedBytes[index]))
    throw new Error('Final Epoch request contains unreviewed execution fields');
  return { noteId: scope.noteId };
}

export async function inspectTestMainnetGuardianConsumeRequest(
  scope: { noteId: string; canonicalSha256: string },
  bytes: Uint8Array,
  note: Note
): Promise<string> {
  if (
    !/^0x[0-9a-f]{64}$/.test(scope.noteId) ||
    !/^[0-9a-f]{64}$/.test(scope.canonicalSha256) ||
    note.id().toString() !== scope.noteId ||
    !(bytes instanceof Uint8Array) ||
    bytes.length < 1 ||
    bytes.length > 1_048_576
  )
    throw new Error('Invalid final Guardian consume scope');
  const noteBytes = note.serialize();
  const builder = () =>
    new TransactionRequestBuilder().withInputNotes(
      new NoteAndArgsArray([new NoteAndArgs(Note.deserialize(noteBytes), null)])
    );
  if ((await testRequestSha256(canonicalRequestBytes(builder().build().serialize()))) !== scope.canonicalSha256)
    throw new Error('Guardian consume note differs from its original canonical reference');
  const request = TransactionRequest.deserialize(bytes);
  const expected = withTestGuardianAuthentication(builder(), request).build();
  const actualBytes = canonicalRequestBytes(bytes);
  const expectedBytes = canonicalRequestBytes(expected.serialize());
  if (actualBytes.length !== expectedBytes.length || actualBytes.some((value, index) => value !== expectedBytes[index]))
    throw new Error('Final Guardian consume contains unreviewed execution fields');
  return testRequestSha256(actualBytes);
}
