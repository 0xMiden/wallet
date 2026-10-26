/** Canonical transfer format: two raw 32-byte secp256k1 scalars, hot first. */
export interface PrivateKeyPair {
  hotPrivateKey: string;
  evmPrivateKey: string;
}

const SCALAR_ORDER = BigInt('0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141');

function normalizeScalar(input: string): string | null {
  const hex = input.trim().replace(/^0x/i, '').toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(hex)) return null;
  const scalar = BigInt(`0x${hex}`);
  return scalar > BigInt(0) && scalar < SCALAR_ORDER ? hex : null;
}

/** Shared by camera, local image decoding, manual entry, and the vault. */
export function parsePrivateKeyPair(payload: string): PrivateKeyPair | null {
  const fields = payload.split(':');
  if (fields.length !== 2) return null;
  const hotPrivateKey = normalizeScalar(fields[0]!);
  const evmPrivateKey = normalizeScalar(fields[1]!);
  return hotPrivateKey && evmPrivateKey ? { hotPrivateKey, evmPrivateKey } : null;
}

export function encodePrivateKeyPair(pair: PrivateKeyPair): string {
  return `${pair.hotPrivateKey}:${pair.evmPrivateKey}`;
}
