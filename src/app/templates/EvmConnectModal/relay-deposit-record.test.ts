import type { PendingRelayDeposit } from 'lib/evm-relay/pending-deposit';

import {
  claimPendingRelayDeposit,
  decodeRelayDepositForm,
  encodeRelayDepositForm,
  type RelayDepositForm
} from './relay-deposit-record';

const mockStorage = new Map<string, unknown>();
const mockTurns: string[] = [];
jest.mock('lib/miden/front/storage', () => ({
  fetchFromStorage: async (key: string) => mockStorage.get(key),
  putToStorage: async (key: string, value: unknown) => {
    mockStorage.set(key, value);
  },
  inStorageTurn: async <T>(name: string, operation: () => Promise<T>) => {
    mockTurns.push(name);
    return operation();
  }
}));

const ACCOUNT = 'mtst1account';
const KEY = `relay_pending_deposits_v1:${ACCOUNT}`;
const deposit = (id: string, createdAt: number): PendingRelayDeposit => ({
  id,
  accountPublicKey: ACCOUNT,
  address: '0x00000000000000000000000000000000000000e5',
  chainId: 1,
  route: 'agglayer',
  token: { address: '0x0000000000000000000000000000000000000000', symbol: 'ETH', decimals: 18 },
  amount: '1',
  amountBaseUnits: '1000000000000000000',
  createdAt
});

beforeEach(() => {
  mockStorage.clear();
  mockTurns.length = 0;
});

describe('relay deposit form', () => {
  it.each([
    ['ETH', 'ETH'],
    ['the engine USDC', 'USDC'],
    ['an Epoch token', { kind: 'epoch', key: 'POL' }],
    ['an ERC-20', { kind: 'erc20', contractAddress: '0x00000000000000000000000000000000000000c0' }]
  ] satisfies [string, RelayDepositForm['token']][])('reads back %s', (_case, token) => {
    const form: RelayDepositForm = { token, chainId: 8453, route: 'epoch', amount: '12.5' };
    expect(decodeRelayDepositForm(encodeRelayDepositForm(form))).toEqual(form);
  });

  it.each([
    ['no form', undefined],
    ['Circle USDC', { tokenKind: 'CIRCLE_USDC', tokenId: '', chainId: '1', route: 'agglayer', amount: '1' }],
    ['a bad route', { tokenKind: 'ETH', tokenId: '', chainId: '1', route: 'usdcx', amount: '1' }],
    ['a bad amount', { tokenKind: 'ETH', tokenId: '', chainId: '1', route: 'agglayer', amount: '1.' }],
    ['a bad chain', { tokenKind: 'ETH', tokenId: '', chainId: '-1', route: 'agglayer', amount: '1' }],
    ['a bad contract', { tokenKind: 'erc20', tokenId: '0xC0', chainId: '1', route: 'agglayer', amount: '1' }],
    ['a bad Epoch key', { tokenKind: 'epoch', tokenId: 'a b', chainId: '1', route: 'agglayer', amount: '1' }]
  ])('refuses %s', (_case, form) => {
    expect(decodeRelayDepositForm(form)).toBeNull();
  });
});

describe('claimPendingRelayDeposit', () => {
  it('takes the deposit out in one storage turn and gives it back', async () => {
    mockStorage.set(KEY, [deposit('b', 2), deposit('a', 1)]);

    await expect(claimPendingRelayDeposit(ACCOUNT, 'a')).resolves.toEqual(deposit('a', 1));
    expect(mockStorage.get(KEY)).toEqual([deposit('b', 2)]);
    expect(mockTurns).toEqual([KEY]);
  });

  it('gives null, and writes nothing, when the deposit is not there', async () => {
    mockStorage.set(KEY, [deposit('b', 2)]);

    await expect(claimPendingRelayDeposit(ACCOUNT, 'a')).resolves.toBeNull();
    await expect(claimPendingRelayDeposit(ACCOUNT, 'b')).resolves.not.toBeNull();
    await expect(claimPendingRelayDeposit(ACCOUNT, 'b')).resolves.toBeNull();
    expect(mockStorage.get(KEY)).toEqual([]);
  });
});
