/**
 * WalletSigner wires the signWord callback to the Guardian signature flow.
 * We stub AuthDigest so the tests don't depend on the WASM hashing primitives.
 */

import { WalletSigner } from './signer';

const mockFromAccountIdWithTimestamp = jest.fn();
const mockFromRequest = jest.fn();

jest.mock('./digest', () => ({
  AuthDigest: {
    fromAccountIdWithTimestamp: (...args: unknown[]) => mockFromAccountIdWithTimestamp(...args),
    fromRequest: (...args: unknown[]) => mockFromRequest(...args)
  }
}));

describe('WalletSigner', () => {
  const publicKey = '0xabc';
  const commitment = '0xdead';
  const accountId = '0x1234';
  const timestamp = 1_700_000_000;

  let signWordFn: jest.Mock;
  let signer: WalletSigner;

  beforeEach(() => {
    jest.clearAllMocks();
    signWordFn = jest.fn(async () => '0xsig');
    signer = new WalletSigner(publicKey, commitment, signWordFn);
  });

  it('exposes the configured public key, commitment, and ecdsa scheme', () => {
    expect(signer.publicKey).toBe(publicKey);
    expect(signer.commitment).toBe(commitment);
    expect(signer.scheme).toBe('ecdsa');
  });

  it('signAccountIdWithTimestamp hashes and delegates to signWord with publicKey stripped of 0x', async () => {
    mockFromAccountIdWithTimestamp.mockReturnValueOnce({ toHex: () => '0xdigest1' });

    const sig = await signer.signAccountIdWithTimestamp(accountId, timestamp);

    expect(mockFromAccountIdWithTimestamp).toHaveBeenCalledWith(accountId, timestamp);
    // signWordFn sees the hot publicKey *without* leading 0x — Vault.signWord
    // looks the hot ciphertext up by hotPublicKey in storage, not commitment.
    expect(signWordFn).toHaveBeenCalledWith('abc', '0xdigest1');
    expect(sig).toBe('0xsig');
  });

  it('signRequest hashes the payload via AuthDigest.fromRequest and signs the digest', async () => {
    mockFromRequest.mockReturnValueOnce({ toHex: () => '0xdigest2' });
    const payload = { toBytes: () => new Uint8Array() } as never;

    const sig = await signer.signRequest(accountId, timestamp, payload);

    expect(mockFromRequest).toHaveBeenCalledWith(accountId, timestamp, payload);
    expect(signWordFn).toHaveBeenCalledWith('abc', '0xdigest2');
    expect(sig).toBe('0xsig');
  });

  it('signCommitment forwards the hex through signWord, adding the 0x prefix when missing', async () => {
    await signer.signCommitment('cafecafe');

    expect(signWordFn).toHaveBeenCalledWith('abc', '0xcafecafe');
  });

  it('signCommitment preserves an existing 0x prefix instead of double-prefixing', async () => {
    await signer.signCommitment('0xcafecafe');

    expect(signWordFn).toHaveBeenCalledWith('abc', '0xcafecafe');
  });

  it('passes the publicKey verbatim to signWord when it has no 0x prefix', async () => {
    const noPrefixSigner = new WalletSigner('beef', commitment, signWordFn);
    mockFromAccountIdWithTimestamp.mockReturnValueOnce({ toHex: () => '0xdigest3' });

    await noPrefixSigner.signAccountIdWithTimestamp(accountId, timestamp);

    expect(signWordFn).toHaveBeenCalledWith('beef', '0xdigest3');
  });
});
