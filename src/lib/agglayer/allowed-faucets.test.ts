import { fetchFromStorage, putToStorage } from 'lib/miden/front/storage';

import { isAgglayerFaucetAllowed } from './allowed-faucets';

const mockGetAccountProof = jest.fn();
jest.mock('@miden-sdk/miden-sdk/lazy', () => ({
  AccountId: { fromHex: (id: string) => id },
  AccountStorageRequirements: { fromSlotAndKeysArray: (slots: object[]) => slots },
  Endpoint: jest.fn(),
  RpcClient: jest.fn(() => ({ getAccountProof: mockGetAccountProof })),
  SlotAndKeys: jest.fn(),
  Word: jest.fn(() => ({ toHex: () => 'registry-key' }))
}));
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
function proof(flag: bigint) {
  return {
    getStorageMapEntries: () => [
      {
        key: () => ({ toHex: () => 'registry-key' }),
        value: () => ({ toU64s: () => new BigUint64Array([flag, 0n, 0n, 0n]) })
      }
    ],
    hasStorageMapTooManyEntries: () => false
  };
}

beforeEach(() => {
  jest.clearAllMocks();
  jest.mocked(fetchFromStorage).mockResolvedValue([]);
  mockGetAccountProof.mockResolvedValue(proof(1n));
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
  mockGetAccountProof.mockResolvedValue(proof(0n));
  await expect(isAgglayerFaucetAllowed('bech32-token', rpcUrl)).resolves.toBe(false);
  expect(putToStorage).not.toHaveBeenCalled();
});

it('does not reuse testnet approvals on another endpoint', async () => {
  jest.mocked(fetchFromStorage).mockResolvedValue(['0xfaucet']);
  mockGetAccountProof.mockResolvedValue(proof(0n));
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
