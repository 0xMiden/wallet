import { fetchFromStorage, putToStorage } from 'lib/miden/front/storage';

import { isAgglayerFaucetAllowed } from './allowed-faucets';

interface MockSlot {
  slot: string;
  keys: bigint[][];
}
interface MockRequirements {
  slots: MockSlot[];
  consumed: boolean;
}

const mockSlotRecords: MockSlot[] = [];
const mockGetAccountProof = jest.fn();
// The glue takes these by value: getAccountProof destroys the requirements (dist/st/Cargo-aQznLgDn.js:20711-20725)
// and SlotAndKeys destroys each key through Word.__unwrap (25190-25199), so a consumed handle reads as pointer 0.
jest.mock('@miden-sdk/miden-sdk/lazy', () => {
  class Word {
    consumed = false;
    constructor(readonly data: BigUint64Array) {}
    toHex() {
      if (this.consumed) throw new Error('null pointer passed to rust');
      return this.data.join(',');
    }
  }
  class SlotAndKeys {
    readonly keys: bigint[][];
    constructor(
      readonly slot: string,
      words: Word[]
    ) {
      this.keys = words.map(word => Array.from(word.data));
      for (const word of words) word.consumed = true;
      mockSlotRecords.push(this);
    }
  }
  return {
    AccountId: { fromHex: (id: string) => id },
    AccountStorageRequirements: {
      fromSlotAndKeysArray: (slots: SlotAndKeys[]) => ({ slots, consumed: false })
    },
    Endpoint: jest.fn(),
    RpcClient: jest.fn(() => ({ getAccountProof: mockGetAccountProof })),
    SlotAndKeys,
    Word
  };
});
jest.mock('lib/miden-chain/constants', () => ({ ensureSdkWasmReady: jest.fn() }));
jest.mock('lib/miden/front/storage', () => ({
  fetchFromStorage: jest.fn(),
  putToStorage: jest.fn(),
  inStorageTurn: (_key: string, operation: () => Promise<void>) => operation()
}));
jest.mock('lib/miden/sdk/helpers', () => ({
  accountRefToSdk: () => ({
    toString: () => '0xfaucet',
    suffix: () => ({ asInt: () => 2n }),
    prefix: () => ({ asInt: () => 3n })
  })
}));

const rpcUrl = 'https://rpc.testnet.miden.io';
let registryFlag = 1n;

function registryProof(keys: bigint[][]) {
  return {
    getStorageMapEntries: () =>
      keys.map(key => ({
        key: () => ({ toHex: () => key.join(',') }),
        value: () => ({ toU64s: () => new BigUint64Array([registryFlag, 0n, 0n, 0n]) })
      })),
    hasStorageMapTooManyEntries: () => false
  };
}

async function answerRequestedKeys(_bridge: string, requirements: MockRequirements) {
  if (requirements.consumed) return registryProof([]);
  requirements.consumed = true;
  return registryProof(requirements.slots.flatMap(slot => slot.keys));
}

beforeEach(() => {
  jest.clearAllMocks();
  mockSlotRecords.length = 0;
  registryFlag = 1n;
  jest.mocked(fetchFromStorage).mockResolvedValue([]);
  mockGetAccountProof.mockReset().mockImplementation(answerRequestedKeys);
});

it('reads one key and appends the canonical approved ID through putToStorage', async () => {
  jest.mocked(fetchFromStorage).mockResolvedValue(['0xexisting']);
  await expect(isAgglayerFaucetAllowed('bech32-token', rpcUrl)).resolves.toBe(true);
  expect(mockGetAccountProof).toHaveBeenCalledTimes(1);
  expect(putToStorage).toHaveBeenCalledWith('allowed_agglayer_ids', ['0xexisting', '0xfaucet']);
});

it('uses a cached approval without RPC', async () => {
  jest.mocked(fetchFromStorage).mockResolvedValue(['0xfaucet']);
  await expect(isAgglayerFaucetAllowed('bech32-token', rpcUrl)).resolves.toBe(true);
  expect(mockGetAccountProof).not.toHaveBeenCalled();
});

it('does not cache an unregistered faucet', async () => {
  registryFlag = 0n;
  await expect(isAgglayerFaucetAllowed('bech32-token', rpcUrl)).resolves.toBe(false);
  expect(putToStorage).not.toHaveBeenCalled();
});

it('does not reuse testnet approvals on another endpoint', async () => {
  jest.mocked(fetchFromStorage).mockResolvedValue(['0xfaucet']);
  registryFlag = 0n;
  await expect(isAgglayerFaucetAllowed('bech32-token', 'http://localhost:57291')).resolves.toBe(false);
  expect(mockGetAccountProof).toHaveBeenCalledTimes(1);
  expect(putToStorage).not.toHaveBeenCalled();
});

it('does not treat missing proof entries as approval', async () => {
  mockGetAccountProof.mockResolvedValue({
    getStorageMapEntries: () => [],
    hasStorageMapTooManyEntries: () => false
  });
  await expect(isAgglayerFaucetAllowed('bech32-token', rpcUrl)).rejects.toThrow('requested key');
  expect(putToStorage).not.toHaveBeenCalled();
});

it('reads the key it asked for after the SDK took it (#1276)', async () => {
  await expect(isAgglayerFaucetAllowed('bech32-token', rpcUrl)).resolves.toBe(true);
});

it('retries a failed read with fresh requirements (#1276)', async () => {
  mockGetAccountProof.mockImplementationOnce(async (_bridge: string, requirements: MockRequirements) => {
    requirements.consumed = true;
    throw new Error('timeout');
  });
  await expect(isAgglayerFaucetAllowed('bech32-token', rpcUrl)).resolves.toBe(true);
  expect(mockGetAccountProof).toHaveBeenCalledTimes(2);
  expect(mockGetAccountProof.mock.calls[1][1]).not.toBe(mockGetAccountProof.mock.calls[0][1]);
});

it('asks the bridge for the [0, 0, suffix, prefix] key (#1276)', async () => {
  await expect(isAgglayerFaucetAllowed('bech32-token', rpcUrl)).resolves.toBe(true);
  expect(mockSlotRecords).toEqual([{ slot: 'agglayer::bridge::faucet_registry_map', keys: [[0n, 0n, 2n, 3n]] }]);
});
