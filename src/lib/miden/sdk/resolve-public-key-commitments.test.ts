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

const unsupportedAuth =
  "cannot derive public key commitments from account state: the account's auth procedure is not owned by exactly one standard auth component bundled with this SDK (auth components found: none)";

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

  it.each([new Error(unsupportedAuth), unsupportedAuth])(
    'resolves the Guardian hot signer when the SDK rejects the custom auth component: %s',
    error => {
      mockGetSignerCommitments.mockReturnValue(['0xabc123', '0xdef456']);
      const account = {
        getPublicKeyCommitments: () => {
          throw error;
        }
      };

      expect(resolvePublicKeyCommitments(account as never)).toEqual([{ hex: '0xabc123' }]);
    }
  );

  it('returns [] when neither the SDK nor Guardian can identify the auth component', () => {
    mockGetSignerCommitments.mockImplementation(() => {
      throw new Error('not a guarded-multisig account');
    });
    const account = {
      getPublicKeyCommitments: () => {
        throw unsupportedAuth;
      }
    };

    expect(resolvePublicKeyCommitments(account as never)).toEqual([]);
  });

  it.each([
    new WebAssembly.RuntimeError('unreachable'),
    new Error('recursive use of an object detected'),
    new Error(
      'cannot derive public key commitments from account state: the multisig auth component declares 3 approvers but its approver key storage holds 2 entries'
    )
  ])('propagates invalid WASM state and malformed account errors: %s', error => {
    const account = {
      getPublicKeyCommitments: () => {
        throw error;
      }
    };

    expect(() => resolvePublicKeyCommitments(account as never)).toThrow(error);
    expect(mockGetSignerCommitments).not.toHaveBeenCalled();
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
