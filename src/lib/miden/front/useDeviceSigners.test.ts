import { readDeviceSigners } from './useDeviceSigners';

type FakeHold = { label: string };

const mockGetAccount = jest.fn();
const mockFindSigner = jest.fn<Promise<string | undefined>, [object, string]>();
let mockLockBusy = false;
let mockBusyTries = 0;
let mockTries = 0;
let mockCurrentHold: FakeHold | null = null;
const mockLockOptions: Array<{ watchdogMs?: number; label?: string }> = [];
jest.mock('lib/miden/back/miden-client-proxy', () => ({ midenClientProxy: { getAccount: () => mockGetAccount() } }));
jest.mock('lib/miden/guardian/account', () => ({
  findOwnSignerCommitment: (state: object, key: string) => mockFindSigner(state, key),
  getSignerCommitmentsFromAccount: (state: { signers: string[] }) => state.signers
}));
jest.mock('lib/miden/sdk/wasm-client-poison', () => ({ WASM_LOCK_SYNC_WATCHDOG_MS: 120_000 }));
jest.mock('lib/miden/sdk/miden-client', () => {
  const run = async <T>(
    operation: (hold: FakeHold) => Promise<T>,
    options: { watchdogMs?: number; label?: string }
  ) => {
    mockLockOptions.push(options);
    const hold = { label: options.label ?? '' };
    mockCurrentHold = hold;
    try {
      return await operation(hold);
    } finally {
      mockCurrentHold = null;
    }
  };
  return {
    withWasmClientLock: run,
    tryWithWasmClientLock: async <T>(
      operation: (hold: FakeHold) => Promise<T>,
      options: { watchdogMs?: number; label?: string }
    ) => {
      mockTries += 1;
      if (mockLockBusy || mockBusyTries > 0) {
        mockBusyTries -= 1;
        return { ran: false };
      }
      return { ran: true, value: await run(operation, options) };
    },
    assertWasmHoldCurrent: (hold: FakeHold) => {
      if (mockCurrentHold !== hold) throw new Error('operation abandoned');
    }
  };
});

beforeEach(() => {
  jest.resetAllMocks();
  mockLockBusy = false;
  mockBusyTries = 0;
  mockTries = 0;
  mockCurrentHold = null;
  mockLockOptions.length = 0;
});

it('hides the recovery key and identifies this device in any slot', async () => {
  mockGetAccount.mockResolvedValue({ signers: ['0x11', '0x22', '0x33', '0x44'] });
  mockFindSigner.mockImplementation(async (_state, key) => (key === 'cold' ? '0x22' : '0x44'));
  await expect(
    readDeviceSigners({ publicKey: 'account', coldPublicKey: 'cold', hotPublicKey: 'hot' })
  ).resolves.toEqual([
    { commitment: '0x11', current: false },
    { commitment: '0x33', current: false },
    { commitment: '0x44', current: true }
  ]);
  expect(mockLockOptions).toEqual([{ watchdogMs: 120_000, label: 'device-list' }]);
});

it('rejects without reading the account when the client is busy', async () => {
  mockLockBusy = true;
  mockGetAccount.mockResolvedValue({ signers: ['0x11', '0x22'] });
  mockFindSigner.mockImplementation(async (_state, key) => (key === 'cold' ? '0x11' : '0x22'));

  await expect(readDeviceSigners({ publicKey: 'account', coldPublicKey: 'cold', hotPublicKey: 'hot' })).rejects.toThrow(
    'Client is busy'
  );
  expect(mockTries).toBe(3);
  expect(mockGetAccount).not.toHaveBeenCalled();
  expect(mockFindSigner).not.toHaveBeenCalled();
});

it('does not read signer keys after eviction during the account read', async () => {
  mockGetAccount.mockImplementation(async () => {
    mockCurrentHold = null;
    return { signers: ['0x11', '0x22'] };
  });

  await expect(readDeviceSigners({ publicKey: 'account', coldPublicKey: 'cold', hotPublicKey: 'hot' })).rejects.toThrow(
    'operation abandoned'
  );
  expect(mockFindSigner).not.toHaveBeenCalled();
});

it('does not guess which key is the recovery key when it is unavailable', async () => {
  mockGetAccount.mockResolvedValue({ signers: ['0x11'] });
  mockFindSigner.mockResolvedValue(undefined);
  await expect(
    readDeviceSigners({ publicKey: 'account', coldPublicKey: 'cold', hotPublicKey: 'hot' })
  ).rejects.toThrow();
  await expect(readDeviceSigners({ publicKey: 'account', hotPublicKey: 'hot' })).rejects.toThrow();
});

// A sync holds the client every few seconds on mobile, so one busy try must not fail the device list.
it('reads once the client frees within its tries', async () => {
  mockBusyTries = 2;
  mockGetAccount.mockResolvedValue({ signers: ['0x11', '0x22'] });
  mockFindSigner.mockImplementation(async (_state, key) => (key === 'cold' ? '0x11' : '0x22'));

  await expect(
    readDeviceSigners({ publicKey: 'account', coldPublicKey: 'cold', hotPublicKey: 'hot' })
  ).resolves.toEqual([{ commitment: '0x22', current: true }]);
  expect(mockTries).toBe(3);
});
