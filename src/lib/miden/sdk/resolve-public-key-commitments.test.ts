import { resolvePublicKeyCommitments } from './resolve-public-key-commitments';

const SIGNER_SLOT = 'openzeppelin::multisig::signer_public_keys';

describe('resolvePublicKeyCommitments', () => {
  it('returns the standard interface commitments without touching storage when the interface yields a key', () => {
    const interfaceCommitment = { tag: 'from-interface' };
    const getMapItem = jest.fn();
    const account = {
      getPublicKeyCommitments: () => [interfaceCommitment],
      storage: () => ({ getMapItem })
    };

    const result = resolvePublicKeyCommitments(account as never);

    expect(result).toEqual([interfaceCommitment]);
    expect(getMapItem).not.toHaveBeenCalled();
  });

  it('falls back to the guardian hot signer commitment (signer map index 0) when the interface is empty', () => {
    const hotSigner = { toHex: () => '0xabc123' };
    const getMapItem = jest.fn(() => hotSigner);
    const account = {
      getPublicKeyCommitments: () => [],
      storage: () => ({ getMapItem })
    };

    const result = resolvePublicKeyCommitments(account as never);

    expect(result).toEqual([hotSigner]);
    expect(getMapItem).toHaveBeenCalledWith(SIGNER_SLOT, expect.anything());
  });

  it('returns [] when the interface is empty and the guardian signer map has no entry', () => {
    const account = {
      getPublicKeyCommitments: () => [],
      storage: () => ({ getMapItem: () => undefined })
    };

    expect(resolvePublicKeyCommitments(account as never)).toEqual([]);
  });

  it('accepts a signer commitment whose hex is not 0x-prefixed', () => {
    const hotSigner = { toHex: () => 'abc123' };
    const account = {
      getPublicKeyCommitments: () => [],
      storage: () => ({ getMapItem: () => hotSigner })
    };

    expect(resolvePublicKeyCommitments(account as never)).toEqual([hotSigner]);
  });

  it('treats an all-zero signer word as absent and returns []', () => {
    const zeroWord = { toHex: () => `0x${'0'.repeat(64)}` };
    const account = {
      getPublicKeyCommitments: () => [],
      storage: () => ({ getMapItem: () => zeroWord })
    };

    expect(resolvePublicKeyCommitments(account as never)).toEqual([]);
  });
});
