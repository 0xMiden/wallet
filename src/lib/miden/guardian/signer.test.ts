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

  it('exposes the configured public key, commitment, and falcon scheme', () => {
    expect(signer.publicKey).toBe(publicKey);
    expect(signer.commitment).toBe(commitment);
    expect(signer.scheme).toBe('falcon');
  });

  it('signAccountIdWithTimestamp hashes and delegates to signWord with commitment stripped of 0x', async () => {
    mockFromAccountIdWithTimestamp.mockReturnValueOnce({ toHex: () => '0xdigest1' });

    const sig = await signer.signAccountIdWithTimestamp(accountId, timestamp);

    expect(mockFromAccountIdWithTimestamp).toHaveBeenCalledWith(accountId, timestamp);
    // signWordFn sees the commitment *without* leading 0x — this is what the guardian expects.
    expect(signWordFn).toHaveBeenCalledWith('dead', '0xdigest1');
    expect(sig).toBe('0xsig');
  });

  it('signRequest hashes the payload via AuthDigest.fromRequest and signs the digest', async () => {
    mockFromRequest.mockReturnValueOnce({ toHex: () => '0xdigest2' });
    const payload = { toBytes: () => new Uint8Array() } as never;

    const sig = await signer.signRequest(accountId, timestamp, payload);

    expect(mockFromRequest).toHaveBeenCalledWith(accountId, timestamp, payload);
    expect(signWordFn).toHaveBeenCalledWith('dead', '0xdigest2');
    expect(sig).toBe('0xsig');
  });

  it('signCommitment forwards the hex through signWord, adding the 0x prefix when missing', async () => {
    await signer.signCommitment('cafecafe');

    expect(signWordFn).toHaveBeenCalledWith('dead', '0xcafecafe');
  });

  it('signCommitment preserves an existing 0x prefix instead of double-prefixing', async () => {
    await signer.signCommitment('0xcafecafe');

    expect(signWordFn).toHaveBeenCalledWith('dead', '0xcafecafe');
  });
});
