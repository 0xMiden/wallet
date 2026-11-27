import { readVaultHoldings } from './vault-read';
import { midenClientProxy } from '../back/miden-client-proxy';
import { isSyncFused, noteProbeFailure, noteSyncSuccess } from '../front/sync-fuse';
import { tryWithWasmClientLock } from '../sdk/miden-client';

jest.mock('../back/miden-client-proxy', () => ({ midenClientProxy: { tryGetAccount: jest.fn() } }));
jest.mock('../front/sync-fuse', () => ({
  isSyncFused: jest.fn(() => false),
  noteProbeFailure: jest.fn(),
  noteSyncSuccess: jest.fn()
}));
jest.mock('../sdk/helpers', () => ({ getBech32AddressFromAccountId: (id: string) => `bech32:${id}` }));
jest.mock('../sdk/miden-client', () => ({ assertWasmHoldCurrent: jest.fn(), tryWithWasmClientLock: jest.fn() }));
jest.mock('../sdk/wasm-client-poison', () => ({ WASM_LOCK_SYNC_WATCHDOG_MS: 1 }));

const tryGetAccount = jest.mocked(midenClientProxy.tryGetAccount);
const lock = jest.mocked(tryWithWasmClientLock);
const account = (assets: [string, bigint][]) =>
  ({
    vault: () => ({
      fungibleAssets: () => assets.map(([id, amount]) => ({ faucetId: () => id, amount: () => amount }))
    })
  }) as never;

beforeEach(() => {
  jest.clearAllMocks();
  lock.mockImplementation(async operation => ({ ran: true, value: await operation({} as never) }));
});

it('sums each faucet of the vault under its bech32 id and books the read as a balances success', async () => {
  tryGetAccount.mockResolvedValue({
    ran: true,
    account: account([
      ['a', 2n],
      ['b', 3n],
      ['a', 4n]
    ])
  });
  expect(await readVaultHoldings('acct', 'test')).toEqual(
    new Map([
      ['bech32:a', 6n],
      ['bech32:b', 3n]
    ])
  );
  expect(noteSyncSuccess).toHaveBeenCalledWith('balances');
  expect(lock).toHaveBeenCalledWith(expect.any(Function), expect.objectContaining({ label: 'test' }));
});

it('reads null, never an empty vault, when the read cannot run', async () => {
  jest.mocked(isSyncFused).mockReturnValueOnce(true);
  expect(await readVaultHoldings('acct', 'test')).toBeNull();
  expect(lock).not.toHaveBeenCalled();

  lock.mockResolvedValueOnce({ ran: false });
  expect(await readVaultHoldings('acct', 'test')).toBeNull();

  tryGetAccount.mockResolvedValueOnce({ ran: false });
  expect(await readVaultHoldings('acct', 'test')).toBeNull();
  tryGetAccount.mockResolvedValueOnce({ ran: true, account: null });
  expect(await readVaultHoldings('acct', 'test')).toBeNull();

  const failure = new Error('read');
  tryGetAccount.mockRejectedValueOnce(failure);
  expect(await readVaultHoldings('acct', 'test')).toBeNull();
  expect(noteProbeFailure).toHaveBeenCalledWith('balances', failure);
  expect(noteSyncSuccess).not.toHaveBeenCalled();
});
