import { privateKeyToAccount } from 'viem/accounts';
import { recoverAuthorizationAddress } from 'viem/utils';

import { buildVaultEvmWalletClient } from './evm-account';

const PRIVATE_KEY = '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80';
const signer = privateKeyToAccount(PRIVATE_KEY);
const mockSignEvm = jest.fn();

jest.mock('lib/store', () => ({
  useWalletStore: {
    getState: () => ({
      signEvm: (...args: unknown[]) => mockSignEvm(...args)
    })
  }
}));

describe('buildVaultEvmWalletClient', () => {
  beforeEach(() => {
    mockSignEvm.mockReset();
    mockSignEvm.mockImplementation(async (_accountPublicKey, operation) => {
      if (operation.op !== 'typed-data') throw new Error(`Unexpected operation: ${operation.op}`);
      return signer.sign({ hash: operation.digest });
    });
  });

  it('exposes a local signer that produces valid EIP-7702 authorizations through the vault', async () => {
    const client = buildVaultEvmWalletClient('miden-account', signer.address);
    const authorization = await client.signAuthorization({
      account: client.account!,
      chainId: 11155111,
      nonce: 0,
      contractAddress: '0x63c0c19a282a1B52b07dD5a65b58948A07DAE32B'
    });

    expect(client.account?.type).toBe('local');
    expect(await recoverAuthorizationAddress({ authorization })).toBe(signer.address);
    expect(mockSignEvm).toHaveBeenCalledWith('miden-account', {
      op: 'typed-data',
      digest: expect.stringMatching(/^0x[0-9a-f]{64}$/)
    });
  });
});
