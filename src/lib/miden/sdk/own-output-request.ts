import { NoteArray, TransactionRequest, TransactionRequestBuilder } from '@miden-sdk/miden-sdk/lazy';

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

/** Compare all fields, allowing only the default MerkleStore's unordered-map serialization. */
function sameOwnOutputRequest(original: Uint8Array, rebuilt: Uint8Array, hasSalt: boolean): boolean {
  if (sameBytes(original, rebuilt)) return true;
  if (original.length !== rebuilt.length) return false;

  // SDK 0.17.3: eight empty fields precede the store, then u64 count and (key, left, right) words.
  // Eight empty fields follow it; the optional salt adds one Word. Validate this layout at runtime.
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
  const tailBytes = EMPTY_REQUEST_SUFFIX.length + (hasSalt ? WORD_BYTES : 0);
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

/** Adds wallet-resolved auth only when the complete request can be preserved. */
export function enrichOwnOutputRequest(
  request: TransactionRequest,
  feeAwareBuilder: TransactionRequestBuilder,
  transported: Uint8Array
): TransactionRequest {
  if (request.authArg() !== undefined || feeAwareBuilder.build().authArg() === undefined) return request;

  let plainBuilder = new TransactionRequestBuilder().withOwnOutputNotes(
    new NoteArray(request.expectedOutputOwnNotes())
  );
  const salt = request.feeConversionSalt();
  if (salt !== undefined) plainBuilder = plainBuilder.withFeeConversionSalt(salt);
  const roundTrip = plainBuilder.build().serialize();
  // Compare transport bytes: SDK deserialization can silently discard an unrecognized suffix.
  if (!sameOwnOutputRequest(transported, roundTrip, salt !== undefined)) {
    throw new Error('Custom requests without authentication currently support only own output notes.');
  }
  return feeAwareBuilder.withOwnOutputNotes(new NoteArray(request.expectedOutputOwnNotes())).build();
}
