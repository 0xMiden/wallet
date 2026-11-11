// Native MerkleStore iteration order is random; no other request bytes may change.
const STORE_NODE_BYTES = 96;

/** @param {Uint8Array} serialized */
export function canonicalRequestBytes(serialized) {
  if (!(serialized instanceof Uint8Array) || serialized.length > 1_048_576) throw new Error('Invalid serialized request size');
  const bytes = Buffer.from(serialized);
  const stores = [];
  for (let at = 0; at + 8 <= bytes.length; at++) {
    const count = bytes.readBigUInt64LE(at);
    if (count < 1n || count > 100_000n) continue;
    const end = at + 8 + Number(count) * STORE_NODE_BYTES;
    if (end > bytes.length) continue;
    let allEmpty = true;
    for (let node = at + 8; allEmpty && node < end; node += STORE_NODE_BYTES) {
      allEmpty = bytes.compare(bytes, node + 32, node + 64, node + 64, node + 96) === 0;
    }
    if (allEmpty) stores.push({ at, count: Number(count), end });
  }
  if (stores.length !== 1) throw new Error(`The request MerkleStore was not located exactly once (${stores.length})`);
  const store = stores[0];
  if (!store) throw new Error('Missing request MerkleStore');
  const nodes = [];
  for (let i = 0; i < store.count; i++) {
    nodes.push(bytes.subarray(store.at + 8 + i * STORE_NODE_BYTES, store.at + 8 + (i + 1) * STORE_NODE_BYTES));
  }
  return Buffer.concat([bytes.subarray(0, store.at + 8), ...nodes.sort(Buffer.compare), bytes.subarray(store.end)]);
}
