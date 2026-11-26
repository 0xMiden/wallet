import { bytesToHex, hexToBytes } from '@noble/hashes/utils';
import { privateKeyToAccount } from 'viem/accounts';

import { deriveRelayKeyScalar } from './derive';

// Hardhat account #0.
const EVM_ROOT = 'ac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80';
const SECP256K1_ORDER = 'fffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141';
// The pinned v1 scalar and address were computed with plain HKDF-SHA256 (RFC 5869). A failing value means every
// account's deposit address moved, so it is never fixed by updating the value.
const PINNED_SCALAR = '1772fe91fd5a0e606a5fed77763cffebdf7d0a44f86be481c60319286db10e6f';
const PINNED_ADDRESS = '0x69ee74A6F96658C72fb4Db3bDE950972cc865bfA';

describe('relay key derivation', () => {
  it('derives the pinned v1 scalar and address', () => {
    const scalar = bytesToHex(deriveRelayKeyScalar(hexToBytes(EVM_ROOT)));
    expect(scalar).toBe(PINNED_SCALAR);
    expect(privateKeyToAccount(`0x${scalar}`).address).toBe(PINNED_ADDRESS);
  });

  it('gives a key other than the root', () => {
    expect(bytesToHex(deriveRelayKeyScalar(hexToBytes(EVM_ROOT)))).not.toBe(EVM_ROOT);
  });

  it('is deterministic', () => {
    const first = deriveRelayKeyScalar(hexToBytes(EVM_ROOT));
    const second = deriveRelayKeyScalar(hexToBytes(EVM_ROOT));
    expect(bytesToHex(first)).toBe(bytesToHex(second));
  });

  it('retries past a value outside the curve order', () => {
    const expand = jest
      .fn<Uint8Array, [Uint8Array]>()
      .mockReturnValueOnce(hexToBytes(SECP256K1_ORDER))
      .mockReturnValueOnce(hexToBytes(PINNED_SCALAR));
    expect(bytesToHex(deriveRelayKeyScalar(hexToBytes(EVM_ROOT), expand))).toBe(PINNED_SCALAR);
    expect(expand).toHaveBeenCalledTimes(2);
    expect(expand.mock.calls[0]![0].at(-1)).toBe(0);
    expect(expand.mock.calls[1]![0].at(-1)).toBe(1);
  });

  it('throws when no counter gives a valid scalar', () => {
    const expand = jest.fn<Uint8Array, [Uint8Array]>().mockReturnValue(new Uint8Array(32));
    expect(() => deriveRelayKeyScalar(hexToBytes(EVM_ROOT), expand)).toThrow('No valid relay key');
    expect(expand).toHaveBeenCalledTimes(256);
  });
});
