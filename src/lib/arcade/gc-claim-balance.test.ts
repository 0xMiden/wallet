import type { GcClaimContext } from './gc-claim-operation';
import { readVerifiedGcBalances } from './gc-claim-service';

const word = (value: string) => `0x${value.repeat(64)}`;
const context: GcClaimContext = {
  network: 'testnet',
  genesisCommitment: word('1'),
  accountId: 'account',
  issuerId: 'issuer',
  issuerCodeCommitment: word('2'),
  nativeAssetId: 'native'
};
let chainCommitment: string;
let activeNetwork: string;
const mockFree = jest.fn();
const mockGetProof = jest.fn();
const mockGetAccount = jest.fn();
jest.mock('lib/miden/back/miden-client-proxy', () => ({
  midenClientProxy: { getAccount: (id: string) => mockGetAccount(id) }
}));
jest.mock('lib/miden/sdk/miden-client', () => ({
  withWasmClientLock: async (fn: (hold: object) => Promise<unknown>) => fn({}),
  assertWasmHoldCurrent: jest.fn()
}));
jest.mock('lib/miden-chain/constants', () => ({
  ensureSdkWasmReady: async () => undefined,
  getRpcEndpoint: () => ({ url: 'rpc-testnet' })
}));
jest.mock('lib/miden-chain/effective-endpoints', () => ({
  getEffectiveNetworkName: () => activeNetwork,
  getEffectiveRpcUrl: () => 'rpc-testnet'
}));
jest.mock('@miden-sdk/miden-sdk/lazy', () => ({
  AccountId: { fromHex: (id: string) => ({ toString: () => id }) },
  RpcClient: jest.fn(() => ({
    getBlockHeaderByNumber: async (block?: number) => ({
      commitment: () => ({ toHex: () => word('1') }),
      blockNum: () => block ?? 100
    }),
    getAccountProof: (...args: unknown[]) => mockGetProof(...args),
    free: mockFree
  }))
}));
beforeEach(() => {
  jest.clearAllMocks();
  activeNetwork = 'testnet';
  chainCommitment = word('3');
  mockGetAccount.mockResolvedValue({
    id: () => ({ toString: () => 'account' }),
    to_commitment: () => ({ toHex: () => word('3') }),
    vault: () => ({
      fungibleAssets: () => [
        { faucetId: () => ({ toString: () => 'issuer' }), amount: () => 60_000_000n },
        { faucetId: () => ({ toString: () => 'native' }), amount: () => 100n }
      ]
    })
  });
  mockGetProof.mockImplementation(async () => ({
    blockNum: () => 100,
    accountId: () => ({ toString: () => 'account' }),
    accountCommitment: () => ({ toHex: () => chainCommitment })
  }));
});
it('accepts a local vault only when its full commitment matches a fresh pinned-chain account proof', async () => {
  await expect(readVerifiedGcBalances(context)).resolves.toEqual({ gc: 60_000_000n, native: 100n });
  expect(mockGetProof).toHaveBeenCalledWith(expect.anything(), undefined, 100);
  expect(mockFree).toHaveBeenCalledTimes(1);
});
it('withholds a stale pre-receipt vault until ordinary background sync catches up', async () => {
  chainCommitment = word('4');
  await expect(readVerifiedGcBalances(context)).rejects.toThrow('balance');
  expect(mockFree).toHaveBeenCalledTimes(1);
});
it('rejects context changes while the account proof is in flight', async () => {
  mockGetProof.mockImplementationOnce(async () => {
    activeNetwork = 'mainnet';
    return {
      blockNum: () => 100,
      accountId: () => ({ toString: () => 'account' }),
      accountCommitment: () => ({ toHex: () => word('3') })
    };
  });
  await expect(readVerifiedGcBalances(context)).rejects.toThrow('network');
});

it('counts only the canonical faucet under v2 while retaining the experimental vault asset', async () => {
  const canonical: GcClaimContext = {
    ...context,
    distribution: {
      protocolVersion: 2,
      distributorId: context.issuerId,
      distributorCodeCommitment: context.issuerCodeCommitment,
      gcFaucetId: 'canonical',
      weeklyClaimsSlot: 'bread::gc::distributor::weekly_claims'
    }
  };
  await expect(readVerifiedGcBalances(canonical)).resolves.toEqual({ gc: 0n, native: 100n });
});
