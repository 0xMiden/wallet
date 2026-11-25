import { hkdf } from '@noble/hashes/hkdf';
import { sha256 } from '@noble/hashes/sha2';
import { bytesToHex, utf8ToBytes } from '@noble/hashes/utils';

// These values are frozen once released: the salt, the info layout, the counter rule and the output length. A change
// to any of them moves every user's deposit address, and funds sent to the old address need the old rule to move.
const RELAY_KEY_SALT = utf8ToBytes('Bread relay key');
const RELAY_KEY_INFO = utf8ToBytes('v1\0evm\0');
const SECP256K1_ORDER = 0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141n;

/**
 * The secp256k1 scalar (32 bytes, big-endian, 0 < k < n) of the relay key that `root` gives. `root` is the account's
 * stored 32-byte EVM private key, so an account keeps its relay key after its recovery phrase leaves the device. The
 * relay key's address is the account's deposit address. `expand` defaults to HKDF-SHA256 over `root`; only tests
 * replace it, to reach the retry.
 */
export function deriveRelayKeyScalar(
  root: Uint8Array,
  expand: (info: Uint8Array) => Uint8Array = info => hkdf(sha256, root, RELAY_KEY_SALT, info, 32)
): Uint8Array {
  for (let counter = 0; counter <= 255; counter++) {
    const info = new Uint8Array(RELAY_KEY_INFO.length + 1);
    info.set(RELAY_KEY_INFO);
    info[RELAY_KEY_INFO.length] = counter;
    const scalar = expand(info);
    const k = BigInt(`0x${bytesToHex(scalar)}`);
    if (k > 0n && k < SECP256K1_ORDER) return scalar;
  }
  throw new Error('No valid relay key');
}
