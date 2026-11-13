import { guardianAccountConfig, rebuildGuardianAccount } from './account-recipe';

const mockBuild = jest.fn();
jest.mock('@openzeppelin/miden-multisig-client', () => ({
  createMultisigAccount: (...args: unknown[]) => mockBuild(...args)
}));

const recipe = {
  hotCommitment: '0xhot',
  coldCommitment: '0xcold',
  guardianCommitment: '0xguardian',
  initSeed: new Uint8Array([1, 2, 3])
};

const builtAccount = (onRead: () => void = () => {}) => {
  const freed = { account: jest.fn(), id: jest.fn(), commitment: jest.fn() };
  const account = {
    id: () => {
      onRead();
      return { toString: () => '0xid', free: freed.id };
    },
    to_commitment: () => ({ toHex: () => '0xABCD', free: freed.commitment }),
    free: freed.account
  };
  return { account, freed };
};

describe('guardian account recipe', () => {
  beforeEach(() => jest.clearAllMocks());

  it('guardianAccountConfig is the creation config', () => {
    expect(guardianAccountConfig({ ...recipe, guardianPublicKey: 'g-pubkey' })).toEqual({
      threshold: 1,
      signerCommitments: ['0xhot', '0xcold'],
      guardianCommitment: '0xguardian',
      guardianPublicKey: 'g-pubkey',
      storageMode: 'private',
      signatureScheme: 'ecdsa',
      seed: new Uint8Array([1, 2, 3]),
      procedureThresholds: [
        { procedure: 'update_guardian', threshold: 2 },
        { procedure: 'update_procedure_threshold', threshold: 2 }
      ]
    });
  });

  it('rebuildGuardianAccount builds through createMultisigAccount on a client that stores nothing', async () => {
    mockBuild.mockResolvedValue({ account: builtAccount().account, seed: recipe.initSeed });

    await rebuildGuardianAccount(recipe);

    expect(mockBuild).toHaveBeenCalledTimes(1);
    const [client, config] = mockBuild.mock.calls[0] ?? [];
    expect(config).toEqual(guardianAccountConfig(recipe));
    expect(Object.keys(client)).toEqual(['accounts']);
    expect(Object.keys(client.accounts)).toEqual(['insert']);
    // An insert that read its account could keep it; this one never looks.
    const unreadable = new Proxy(
      {},
      {
        get: () => {
          throw new Error('the insert read the account');
        }
      }
    );
    await expect(client.accounts.insert({ account: unreadable, overwrite: false })).resolves.toBeUndefined();
  });

  it('returns the id and the unprefixed lower-case commitment and frees the account', async () => {
    const { account, freed } = builtAccount();
    mockBuild.mockResolvedValue({ account, seed: recipe.initSeed });

    await expect(rebuildGuardianAccount(recipe)).resolves.toEqual({ accountIdHex: '0xid', commitment: 'abcd' });
    expect(freed.account).toHaveBeenCalledTimes(1);
    expect(freed.id).toHaveBeenCalledTimes(1);
    expect(freed.commitment).toHaveBeenCalledTimes(1);
  });

  it('frees the account when reading it throws', async () => {
    const trap = new WebAssembly.RuntimeError('unreachable');
    const { account, freed } = builtAccount(() => {
      throw trap;
    });
    mockBuild.mockResolvedValue({ account, seed: recipe.initSeed });

    await expect(rebuildGuardianAccount(recipe)).rejects.toBe(trap);
    expect(freed.account).toHaveBeenCalledTimes(1);
  });
});
