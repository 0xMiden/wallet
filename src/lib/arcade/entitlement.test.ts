import { readGcEntitlement } from './entitlement';
import type { CanonicalGcDistribution } from './gc-claim-operation';

const GENESIS = `0x${'01'.repeat(32)}`;
const CODE = `0x${'02'.repeat(32)}`;
const ISSUER = '0x74f7c9a851b3f3910de5ae13b02005';
const ACCOUNT = '0x3b07d521857ce8810cfef844d0a568';
const mockGetHeader = jest.fn();
const mockGetProof = jest.fn();
const mockFree = jest.fn();
const mockRequirements: bigint[][] = [];

jest.mock('@miden-sdk/miden-sdk/lazy', () => {
  class Word {
    constructor(readonly values: BigUint64Array) {}
    toHex() {
      return Array.from(this.values).join(',');
    }
  }
  class SlotAndKeys {
    constructor(
      readonly name: string,
      keys: Word[]
    ) {
      mockRequirements.push(...keys.map(key => Array.from(key.values)));
    }
  }
  return {
    RpcClient: jest.fn(() => ({
      getBlockHeaderByNumber: mockGetHeader,
      getAccountProof: mockGetProof,
      free: mockFree
    })),
    AccountStorageRequirements: { fromSlotAndKeysArray: (slots: SlotAndKeys[]) => slots },
    SlotAndKeys,
    Word
  };
});
jest.mock('lib/miden/sdk/helpers', () => ({
  accountRefToSdk: (id: string) => ({
    toString: () => id,
    suffix: () => ({ asInt: () => 2n }),
    prefix: () => ({ asInt: () => 3n })
  })
}));
jest.mock('lib/miden-chain/constants', () => ({
  ensureSdkWasmReady: async () => undefined,
  getRpcEndpoint: () => 'https://rpc.testnet.example'
}));
jest.mock('lib/miden-chain/effective-endpoints', () => ({ getEffectiveNetworkName: () => 'testnet' }));

const config = { genesisCommitment: GENESIS, issuerId: ISSUER, issuerCodeCommitment: CODE };
let timestamp: number;
let genesis: string;
let code: string;
let networkDomain: string;
let entry: bigint[] | undefined;
let tooMany: boolean;
let proofBlock: number;
let inventory: { faucet: string; amount: bigint }[] | undefined;

beforeEach(() => {
  jest.clearAllMocks();
  mockRequirements.length = 0;
  timestamp = Date.parse('2026-10-25T23:59:59Z') / 1000;
  genesis = GENESIS;
  code = CODE;
  networkDomain = GENESIS;
  entry = [0n, 0n, 0n, 0n];
  tooMany = false;
  proofBlock = 123;
  inventory = [{ faucet: '0x97924b9a77ed54917ff6d6364ae661', amount: 10_000_000n }];
  mockGetHeader.mockImplementation(async (block?: number) => ({
    commitment: () => ({ toHex: () => (block === 0 ? genesis : `0x${'03'.repeat(32)}`) }),
    blockNum: () => (block === 0 ? 0 : 123),
    timestamp: () => timestamp,
    verificationBaseFee: () => 7
  }));
  mockGetProof.mockImplementation(async (_account, _requirements, _block, vaultRequest) => {
    const storedEntry = entry;
    return {
      vaultFungibleAssets: () =>
        vaultRequest === undefined
          ? undefined
          : inventory?.map(asset => ({
              faucetId: () => ({ toString: () => asset.faucet }),
              amount: () => asset.amount
            })),
      accountId: () => ({ toString: () => ISSUER }),
      accountHeader: () => ({ codeCommitment: () => ({ toHex: () => code }) }),
      getStorageSlotValue: () => ({ toHex: () => networkDomain }),
      blockNum: () => proofBlock,
      hasStorageMapTooManyEntries: () => tooMany,
      getStorageMapEntries: () =>
        storedEntry === undefined
          ? []
          : [
              {
                key: () => ({ toHex: () => mockRequirements.at(-1)?.join(',') }),
                value: () => ({ toU64s: () => new BigUint64Array(storedEntry) })
              }
            ]
    };
  });
});

it('uses chain time and the authenticated account/week key, never the device calendar', async () => {
  const result = await readGcEntitlement(config, ACCOUNT);
  const expectedWeek = Math.floor((timestamp + 259200) / 604800);
  expect(result).toEqual({
    approvedWeek: expectedWeek,
    claimed: false,
    referenceBlock: 123,
    referenceTimestamp: timestamp,
    verificationBaseFee: 7,
    nextEligibleAt: '2026-10-26T00:00:00.000Z'
  });
  expect(mockRequirements).toEqual([[2n, 3n, BigInt(expectedWeek), 0n]]);
  expect(mockGetProof.mock.calls[0]?.[2]).toBe(123);
  expect(mockFree).toHaveBeenCalledTimes(1);
});

it('reads a new entitlement at Monday midnight even if the previous week delivered late', async () => {
  entry = [1n, 0n, 0n, 0n];
  const sunday = await readGcEntitlement(config, ACCOUNT);
  expect(sunday.claimed).toBe(true);
  timestamp += 1;
  entry = [0n, 0n, 0n, 0n];
  const monday = await readGcEntitlement(config, ACCOUNT);
  expect(monday.approvedWeek).toBe(sunday.approvedWeek + 1);
  expect(monday.claimed).toBe(false);
  expect(monday.nextEligibleAt).toBe('2026-11-02T00:00:00.000Z');
});

it.each(['genesis', 'code', 'network domain', 'missing key', 'too many entries', 'stale proof', 'malformed flag'])(
  'never grants eligibility from %s',
  async fault => {
    if (fault === 'genesis') genesis = CODE;
    if (fault === 'code') code = GENESIS;
    if (fault === 'network domain') networkDomain = CODE;
    if (fault === 'missing key') entry = undefined;
    if (fault === 'too many entries') tooMany = true;
    if (fault === 'stale proof') proofBlock = 122;
    if (fault === 'malformed flag') entry = [0n, 1n, 0n, 0n];
    await expect(readGcEntitlement(config, ACCOUNT)).rejects.toThrow();
    expect(mockFree).toHaveBeenCalledTimes(1);
  }
);

it('propagates an unavailable node without turning the balance or entitlement into zero', async () => {
  mockGetProof.mockRejectedValueOnce(new Error('offline'));
  await expect(readGcEntitlement(config, ACCOUNT)).rejects.toThrow('offline');
  expect(mockFree).toHaveBeenCalledTimes(1);
});

it('reads the distributor weekly map for v2 and never reuses the legacy map', async () => {
  const distribution: CanonicalGcDistribution = {
    protocolVersion: 2,
    distributorId: ISSUER,
    distributorCodeCommitment: CODE,
    gcFaucetId: '0xe1f2c48d5bfa8d5173dfcfdc8ac977',
    weeklyClaimsSlot: 'bread::gc::distributor::weekly_claims'
  };
  mockGetProof.mockImplementationOnce(async (_account, requirements) => {
    const requestedSlot = requirements[0].name;
    return {
      vaultFungibleAssets: () => [],
      accountId: () => ({ toString: () => ISSUER }),
      accountHeader: () => ({ codeCommitment: () => ({ toHex: () => CODE }) }),
      getStorageSlotValue: () => ({ toHex: () => GENESIS }),
      blockNum: () => 123,
      hasStorageMapTooManyEntries: (slot: string) => (slot === distribution.weeklyClaimsSlot ? false : undefined),
      getStorageMapEntries: (slot: string) =>
        slot === requestedSlot && slot === distribution.weeklyClaimsSlot
          ? [
              {
                key: () => ({ toHex: () => mockRequirements.at(-1)?.join(',') }),
                value: () => ({ toU64s: () => new BigUint64Array([1n, 0n, 0n, 0n]) })
              }
            ]
          : undefined
    };
  });
  await expect(readGcEntitlement({ ...config, distribution }, ACCOUNT)).resolves.toMatchObject({ claimed: true });
  await expect(
    readGcEntitlement({ ...config, distribution: { ...distribution, distributorId: ACCOUNT } }, ACCOUNT)
  ).rejects.toThrow();
});

const fundedDistribution: CanonicalGcDistribution = {
  protocolVersion: 2,
  distributorId: ISSUER,
  distributorCodeCommitment: CODE,
  gcFaucetId: '0x97924b9a77ed54917ff6d6364ae661',
  weeklyClaimsSlot: 'bread::gc::distributor::weekly_claims'
};
it.each([
  [0n, false],
  [9_999_999n, false],
  [10_000_000n, true],
  [20_000_000n, true]
])('checks %s GC base units against one weekly payout', async (units, available) => {
  inventory = [{ faucet: fundedDistribution.gcFaucetId, amount: units }];
  await expect(readGcEntitlement({ ...config, distribution: fundedDistribution }, ACCOUNT)).resolves.toMatchObject({
    inventoryAvailable: available
  });
});
it('does not treat another asset as distributor GC inventory', async () => {
  inventory = [{ faucet: ISSUER, amount: 10_000_000n }];
  await expect(readGcEntitlement({ ...config, distribution: fundedDistribution }, ACCOUNT)).resolves.toMatchObject({
    inventoryAvailable: false
  });
});
it('fails closed when requested distributor vault data is unavailable', async () => {
  inventory = undefined;
  await expect(readGcEntitlement({ ...config, distribution: fundedDistribution }, ACCOUNT)).rejects.toThrow(
    'GC inventory'
  );
});

it('rejects duplicate GC inventory entries instead of overstating available funds', async () => {
  inventory = [
    { faucet: fundedDistribution.gcFaucetId, amount: 5_000_000n },
    { faucet: fundedDistribution.gcFaucetId, amount: 5_000_000n }
  ];
  await expect(readGcEntitlement({ ...config, distribution: fundedDistribution }, ACCOUNT)).rejects.toThrow(
    'duplicate assets'
  );
});
