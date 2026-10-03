import { getAgglayerMidenBridge } from 'lib/remote-config/values';

import { allowAgglayerFaucetForE2E, isAgglayerFaucetAllowed } from './allowed-faucets';

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
jest.mock('lib/remote-config/values', () => ({ getAgglayerMidenBridge: jest.fn() }));
jest.mock('lib/miden/sdk/helpers', () => ({
  accountRefToSdk: (ref: string) => ({
    toString: () => ref,
    suffix: () => ({ asInt: () => 2n }),
    prefix: () => ({ asInt: () => 3n })
  })
}));

const BRIDGE = '0x3b66e20b5088f25133b69216484652';
const rpcUrl = 'https://rpc.one.example';
const otherRpcUrl = 'https://rpc.two.example';
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
  mockGetAccountProof.mockReset().mockImplementation(answerRequestedKeys);
  jest.mocked(getAgglayerMidenBridge).mockReturnValue(BRIDGE);
});

it('reads the registry of the bridge the config names, and asks again once the config moves it', async () => {
  await expect(isAgglayerFaucetAllowed('moved-token', rpcUrl)).resolves.toBe(true);
  jest.mocked(getAgglayerMidenBridge).mockReturnValue('0x0123456789abcdef0123456789abcd');
  await expect(isAgglayerFaucetAllowed('moved-token', rpcUrl)).resolves.toBe(true);
  expect(mockGetAccountProof.mock.calls.map(([bridge]) => bridge)).toEqual([
    BRIDGE,
    '0x0123456789abcdef0123456789abcd'
  ]);
});

it('reads no registry while the config names no bridge', async () => {
  jest.mocked(getAgglayerMidenBridge).mockImplementation(() => {
    throw new Error('no bridge');
  });
  await expect(isAgglayerFaucetAllowed('unconfigured-token', rpcUrl)).rejects.toThrow('no bridge');
  expect(mockGetAccountProof).not.toHaveBeenCalled();
});

it('reuses an approval in this realm without another RPC (#1276)', async () => {
  await expect(isAgglayerFaucetAllowed('reused-token', rpcUrl)).resolves.toBe(true);
  await expect(isAgglayerFaucetAllowed('reused-token', rpcUrl)).resolves.toBe(true);
  expect(mockGetAccountProof).toHaveBeenCalledTimes(1);
});

it('asks again on another endpoint (#1276)', async () => {
  await expect(isAgglayerFaucetAllowed('endpoint-token', rpcUrl)).resolves.toBe(true);
  await expect(isAgglayerFaucetAllowed('endpoint-token', otherRpcUrl)).resolves.toBe(true);
  expect(mockGetAccountProof).toHaveBeenCalledTimes(2);
});

it('does not remember an unregistered faucet (#1276)', async () => {
  registryFlag = 0n;
  await expect(isAgglayerFaucetAllowed('unregistered-token', rpcUrl)).resolves.toBe(false);
  await expect(isAgglayerFaucetAllowed('unregistered-token', rpcUrl)).resolves.toBe(false);
  expect(mockGetAccountProof).toHaveBeenCalledTimes(2);
});

it('does not treat missing proof entries as approval', async () => {
  mockGetAccountProof.mockResolvedValue({
    getStorageMapEntries: () => [],
    hasStorageMapTooManyEntries: () => false
  });
  await expect(isAgglayerFaucetAllowed('missing-entry-token', rpcUrl)).rejects.toThrow('requested key');
});

it('reads the key it asked for after the SDK took it (#1276)', async () => {
  await expect(isAgglayerFaucetAllowed('consumed-key-token', rpcUrl)).resolves.toBe(true);
});

it('retries a failed read with fresh requirements (#1276)', async () => {
  mockGetAccountProof.mockImplementationOnce(async (_bridge: string, requirements: MockRequirements) => {
    requirements.consumed = true;
    throw new Error('timeout');
  });
  await expect(isAgglayerFaucetAllowed('retry-token', rpcUrl)).resolves.toBe(true);
  expect(mockGetAccountProof).toHaveBeenCalledTimes(2);
  expect(mockGetAccountProof.mock.calls[1][1]).not.toBe(mockGetAccountProof.mock.calls[0][1]);
});

it('asks the bridge for the [0, 0, suffix, prefix] key (#1276)', async () => {
  await expect(isAgglayerFaucetAllowed('layout-token', rpcUrl)).resolves.toBe(true);
  expect(mockSlotRecords).toEqual([{ slot: 'agglayer::bridge::faucet_registry_map', keys: [[0n, 0n, 2n, 3n]] }]);
});

it('an E2E allowlisted faucet is allowed without an RPC on that endpoint only (#1276)', async () => {
  await allowAgglayerFaucetForE2E('allowlisted-token', rpcUrl);
  await expect(isAgglayerFaucetAllowed('allowlisted-token', rpcUrl)).resolves.toBe(true);
  expect(mockGetAccountProof).not.toHaveBeenCalled();
  registryFlag = 0n;
  await expect(isAgglayerFaucetAllowed('allowlisted-token', otherRpcUrl)).resolves.toBe(false);
  expect(mockGetAccountProof).toHaveBeenCalledTimes(1);
});
