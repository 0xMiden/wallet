import {
  AccountId,
  AccountStorageRequirements,
  ForeignAccount,
  ForeignAccountArray,
  NetworkAccountTarget,
  type Note,
  NoteArray,
  TransactionRequest,
  TransactionRequestBuilder
} from '@miden-sdk/miden-sdk/lazy';

const WORD_BYTES = 32;
const MERKLE_ENTRY_BYTES = 3 * WORD_BYTES;
const EMPTY_TREE_NODES = 255;
const EMPTY_REQUEST_PREFIX = [1, 1, 1, 1, 0, 1, 1, 1];
const EMPTY_REQUEST_SUFFIX = [1, 0, 0, 0, 0, 0, 1, 0];

function sameBytes(left: Uint8Array, right: Uint8Array): boolean {
  return left.length === right.length && left.every((byte, index) => byte === right[index]);
}

function sortedMerkleEntries(bytes: Uint8Array, offset: number): string[] {
  return Array.from({ length: EMPTY_TREE_NODES }, (_, index) =>
    bytes.subarray(offset + index * MERKLE_ENTRY_BYTES, offset + (index + 1) * MERKLE_ENTRY_BYTES).join(',')
  ).sort();
}

// Built per call: a by-value argument consumes its handles in the browser build.
function withForeignAccounts(builder: TransactionRequestBuilder, ids: string[]): TransactionRequestBuilder {
  if (ids.length === 0) return builder;
  return builder.withForeignAccounts(
    new ForeignAccountArray(
      ids.map(id => ForeignAccount.public(AccountId.fromHex(id), new AccountStorageRequirements()))
    )
  );
}

/** Compare all fields, allowing only the default MerkleStore's unordered-map serialization. */
function sameOwnOutputRequest(
  original: Uint8Array,
  rebuilt: Uint8Array,
  hasSalt: boolean,
  foreignIds: string[]
): boolean {
  if (sameBytes(original, rebuilt)) return true;
  if (original.length !== rebuilt.length) return false;

  // SDK 0.17.3: eight empty fields precede the store, then u64 count and (key, left, right) words. The foreign
  // accounts and seven more fields follow it; the optional salt adds one Word. Validate this layout at runtime.
  const empty = new TransactionRequestBuilder().build().serialize();
  const countBytes = 8;
  const storeBytes = countBytes + EMPTY_TREE_NODES * MERKLE_ENTRY_BYTES;
  if (
    empty.length !== EMPTY_REQUEST_PREFIX.length + storeBytes + EMPTY_REQUEST_SUFFIX.length ||
    !sameBytes(empty.subarray(0, EMPTY_REQUEST_PREFIX.length), new Uint8Array(EMPTY_REQUEST_PREFIX)) ||
    !sameBytes(empty.subarray(-EMPTY_REQUEST_SUFFIX.length), new Uint8Array(EMPTY_REQUEST_SUFFIX)) ||
    new DataView(empty.buffer, empty.byteOffset).getBigUint64(EMPTY_REQUEST_PREFIX.length, true) !==
      BigInt(EMPTY_TREE_NODES)
  ) {
    return false;
  }
  const foreignBytes =
    foreignIds.length === 0
      ? 0
      : withForeignAccounts(new TransactionRequestBuilder(), foreignIds).build().serialize().length - empty.length;
  const tailBytes = EMPTY_REQUEST_SUFFIX.length + (hasSalt ? WORD_BYTES : 0) + foreignBytes;
  const storeOffset = rebuilt.length - tailBytes - storeBytes;
  if (storeOffset < 0) return false;
  const entriesOffset = storeOffset + countBytes;
  const entriesEnd = entriesOffset + EMPTY_TREE_NODES * MERKLE_ENTRY_BYTES;
  if (
    !sameBytes(original.subarray(0, entriesOffset), rebuilt.subarray(0, entriesOffset)) ||
    !sameBytes(original.subarray(entriesEnd), rebuilt.subarray(entriesEnd)) ||
    !sameBytes(
      rebuilt.subarray(storeOffset, entriesOffset),
      empty.subarray(EMPTY_REQUEST_PREFIX.length, EMPTY_REQUEST_PREFIX.length + countBytes)
    )
  ) {
    return false;
  }
  const expected = sortedMerkleEntries(empty, EMPTY_REQUEST_PREFIX.length + countBytes);
  const before = sortedMerkleEntries(original, entriesOffset);
  const after = sortedMerkleEntries(rebuilt, entriesOffset);
  return expected.every((entry, index) => entry === before[index] && entry === after[index]);
}

/** The accounts the notes target through a `NetworkAccountTarget` attachment, as distinct hex ids. */
export function networkTargetIds(notes: Note[]): string[] {
  const ids = new Set<string>();
  for (const note of notes) {
    for (const attachment of note.attachments()) {
      try {
        ids.add(NetworkAccountTarget.fromAttachment(attachment).targetId().toString());
      } catch (error) {
        // Another attachment scheme fails to decode and targets nothing; a trap is not that.
        if (error instanceof WebAssembly.RuntimeError) throw error;
      }
    }
  }
  return [...ids];
}

/** Adds wallet-resolved auth only when the complete request can be preserved. */
export function enrichOwnOutputRequest(
  request: TransactionRequest,
  feeAwareBuilder: TransactionRequestBuilder,
  transported: Uint8Array
): TransactionRequest {
  if (request.authArg() !== undefined || feeAwareBuilder.build().authArg() === undefined) return request;

  // A note to a network account is priced by its target's `estimate_note_fee` through FPI, and the client never
  // loads a foreign account itself, so the dApp sends the target; those public accounts are the one field kept.
  const targets = networkTargetIds(request.expectedOutputOwnNotes());
  const candidates: string[][] = targets.length === 0 ? [[]] : [[], targets];
  for (const foreignIds of candidates) {
    let plainBuilder = withForeignAccounts(
      new TransactionRequestBuilder().withOwnOutputNotes(new NoteArray(request.expectedOutputOwnNotes())),
      foreignIds
    );
    const salt = request.feeConversionSalt();
    if (salt !== undefined) plainBuilder = plainBuilder.withFeeConversionSalt(salt);
    // Compare transport bytes: SDK deserialization can silently discard an unrecognized suffix.
    if (sameOwnOutputRequest(transported, plainBuilder.build().serialize(), salt !== undefined, foreignIds)) {
      return withForeignAccounts(
        feeAwareBuilder.withOwnOutputNotes(new NoteArray(request.expectedOutputOwnNotes())),
        foreignIds
      ).build();
    }
  }
  throw new Error('Custom requests without authentication currently support only own output notes.');
}
