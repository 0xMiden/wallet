import { webcrypto } from 'node:crypto';

import { StorageJournal } from './storage-journal';
import { importVaultKey } from '../passworder';
import { markWalletStorageUnavailable } from '../storage-health';

const mockValues: Record<string, unknown> = {};
const mockSet = jest.fn(async (entries: Record<string, unknown>) => Object.assign(mockValues, entries));

jest.mock('lib/platform/storage-adapter', () => ({
  getStorageProvider: () => ({
    get: async (keys: string[]) =>
      Object.fromEntries(keys.filter(key => key in mockValues).map(key => [key, mockValues[key]])),
    set: (entries: Record<string, unknown>) => mockSet(entries)
  })
}));
jest.mock('lib/miden-chain/effective-endpoints', () => ({ getEffectiveNetworkName: () => 'mainnet' }));
jest.mock('../storage-health', () => ({
  ...jest.requireActual('../storage-health'),
  markWalletStorageUnavailable: jest.fn(async () => {})
}));

const noop = () => {};
let journal: StorageJournal;
let cryptoDescriptor: PropertyDescriptor | undefined;

beforeAll(() => {
  cryptoDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'crypto');
  Object.defineProperty(globalThis, 'crypto', { configurable: true, value: webcrypto });
});

afterAll(() => {
  if (cryptoDescriptor) Object.defineProperty(globalThis, 'crypto', cryptoDescriptor);
});

beforeEach(async () => {
  for (const key of Object.keys(mockValues)) delete mockValues[key];
  jest.clearAllMocks();
  journal = new StorageJournal(await importVaultKey(new Uint8Array(32)));
});

it('retains account and note recovery data encrypted outside IndexedDB', async () => {
  await journal.retain(data => ({ ...data, notes: ['private-note-material'] }), noop);
  await journal.retain(data => ({ ...data, accounts: [{ id: 'wallet-id', state: 'account-state' }] }), noop);

  expect(await journal.read()).toMatchObject({
    accounts: [{ id: 'wallet-id', state: 'account-state' }],
    notes: ['private-note-material']
  });
  expect(JSON.stringify(mockValues)).not.toMatch(/private-note-material|account-state|wallet-id/);
});

it('refuses a failed save and preserves the last verified generation', async () => {
  await journal.retain(data => ({ ...data, notes: ['first'] }), noop);
  mockSet.mockRejectedValueOnce(new DOMException('No space left', 'QuotaExceededError'));

  await expect(journal.retain(data => ({ ...data, notes: ['second'] }), noop)).rejects.toThrow('No space left');

  expect(await journal.read()).toMatchObject({ generation: 1, notes: ['first'] });
  expect(markWalletStorageUnavailable).toHaveBeenCalledTimes(1);
});

it('does not acknowledge an oversized journal or evict the previous notes', async () => {
  await journal.retain(data => ({ ...data, notes: ['first'] }), noop);
  const notes = Array.from({ length: 257 }, (_, index) => String(index));

  await expect(journal.retain(data => ({ ...data, notes }), noop)).rejects.toThrow('Wallet storage unavailable');

  expect(await journal.read()).toMatchObject({ generation: 1, notes: ['first'] });
  expect(mockSet).toHaveBeenCalledTimes(1);
});
