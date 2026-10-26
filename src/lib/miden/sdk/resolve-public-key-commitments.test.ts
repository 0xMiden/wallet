import { resolvePublicKeyCommitments } from './resolve-public-key-commitments';

const mockGetSignerCommitments = jest.fn();
jest.mock('@openzeppelin/miden-multisig-client', () => ({
  AccountInspector: {
    getSignerPublicKeyCommitments: (...a: unknown[]) => mockGetSignerCommitments(...a)
  }
}));

// `Word.fromHex` is what the fallback returns, so identify the result by the hex
// it was built from rather than by object identity.
jest.mock('@miden-sdk/miden-sdk/lazy', () => ({
  Word: { fromHex: (hex: string) => ({ hex }) }
}));

describe('resolvePublicKeyCommitments', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('returns the standard interface commitments without inspecting the account when the interface yields a key', () => {
    const interfaceCommitment = { tag: 'from-interface' };
    const account = { getPublicKeyCommitments: () => [interfaceCommitment] };

    const result = resolvePublicKeyCommitments(account as never);

    expect(result).toEqual([interfaceCommitment]);
    expect(mockGetSignerCommitments).not.toHaveBeenCalled();
  });

  it('falls back to the guardian hot signer commitment (signer index 0) when the interface is empty', () => {
    mockGetSignerCommitments.mockReturnValue(['0xabc123', '0xdef456']);
    const account = { getPublicKeyCommitments: () => [] };

    expect(resolvePublicKeyCommitments(account as never)).toEqual([{ hex: '0xabc123' }]);
  });

  it('returns [] when the interface is empty and the account reports no signers', () => {
    mockGetSignerCommitments.mockReturnValue([]);
    const account = { getPublicKeyCommitments: () => [] };

    expect(resolvePublicKeyCommitments(account as never)).toEqual([]);
  });

  it('returns [] when the account is not a guarded multisig', () => {
    mockGetSignerCommitments.mockImplementation(() => {
      throw new Error('not a guarded-multisig account');
    });
    const account = { getPublicKeyCommitments: () => [] };

    expect(resolvePublicKeyCommitments(account as never)).toEqual([]);
  });

  it('accepts a signer commitment whose hex is not 0x-prefixed', () => {
    mockGetSignerCommitments.mockReturnValue(['abc123']);
    const account = { getPublicKeyCommitments: () => [] };

    expect(resolvePublicKeyCommitments(account as never)).toEqual([{ hex: '0xabc123' }]);
  });

  it('treats an all-zero signer word as absent and returns []', () => {
    mockGetSignerCommitments.mockReturnValue([`0x${'0'.repeat(64)}`]);
    const account = { getPublicKeyCommitments: () => [] };

    expect(resolvePublicKeyCommitments(account as never)).toEqual([]);
  });
});
