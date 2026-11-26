import { renderHook } from '@testing-library/react';

import {
  createPendingRelayDepositId,
  MAX_PENDING_RELAY_DEPOSITS,
  parsePendingRelayDeposit,
  parsePendingRelayDeposits,
  pendingRelayDepositsKey,
  readPendingRelayDeposits,
  removePendingRelayDeposit,
  savePendingRelayDeposit,
  usePendingRelayDeposits,
  type PendingRelayDeposit
} from './pending-deposit';
import { NATIVE, RELAY_ADDRESS, upperHex, USDC } from './testing';

const storage = new Map<string, unknown>();
const turns: string[] = [];
const mockPut = jest.fn(async (key: string, value: unknown) => {
  storage.set(key, value);
});
jest.mock('lib/miden/front/storage', () => ({
  fetchFromStorage: async (key: string) => storage.get(key) ?? null,
  putToStorage: (key: string, value: unknown) => mockPut(key, value),
  inStorageTurn: async (name: string, operation: () => Promise<unknown>) => {
    turns.push(name);
    return operation();
  },
  useStorage: (key: string, fallback: unknown) => [storage.get(key) ?? fallback, jest.fn()]
}));

const ACCOUNT = 'miden-account';
const KEY = `relay_pending_deposits_v1:${ACCOUNT}`;

function deposit(overrides: Partial<PendingRelayDeposit> = {}): PendingRelayDeposit {
  return {
    id: 'deposit-1',
    accountPublicKey: ACCOUNT,
    address: RELAY_ADDRESS,
    chainId: 8453,
    route: 'epoch',
    token: { address: USDC, symbol: 'USDC', decimals: 6 },
    amount: '12.5',
    amountBaseUnits: '12500000',
    createdAt: 1_000,
    ...overrides
  };
}

beforeEach(() => {
  storage.clear();
  turns.length = 0;
  mockPut.mockClear();
});

describe('pendingRelayDepositsKey', () => {
  it('is one key for each account', () => {
    expect(pendingRelayDepositsKey(ACCOUNT)).toBe(KEY);
  });
});

describe('createPendingRelayDepositId', () => {
  it('gives a new random id each time', () => {
    const first = createPendingRelayDepositId();
    expect(first).toMatch(/^[0-9a-f-]{36}$/);
    expect(createPendingRelayDepositId()).not.toBe(first);
  });
});

describe('parsePendingRelayDeposit', () => {
  it('reads a full record, lowers the addresses and drops unknown fields', () => {
    const full = {
      ...deposit({ outputAmount: '12.4', outputSymbol: 'USDC', form: { route: 'fast', note: '' } }),
      address: upperHex(RELAY_ADDRESS),
      token: { address: upperHex(USDC), symbol: 'USDC', decimals: 6 },
      extra: 'dropped'
    };
    expect(parsePendingRelayDeposit(full, ACCOUNT)).toEqual(
      deposit({ outputAmount: '12.4', outputSymbol: 'USDC', form: { route: 'fast', note: '' } })
    );
  });

  it('reads the native coin and a record without the optional fields', () => {
    const native = deposit({ token: { address: NATIVE, symbol: 'ETH', decimals: 18 }, route: 'agglayer' });
    expect(parsePendingRelayDeposit(native, ACCOUNT)).toEqual(native);
  });

  it.each<[string, Record<string, unknown>]>([
    ['another account', { accountPublicKey: 'other' }],
    ['an empty id', { id: '' }],
    ['a long id', { id: 'x'.repeat(65) }],
    ['a bad address', { address: '0x12' }],
    ['a zero chain id', { chainId: 0 }],
    ['a fractional chain id', { chainId: 1.5 }],
    ['an unknown route', { route: 'circle' }],
    ['a token that is not an object', { token: 'USDC' }],
    ['a bad token address', { token: { address: 'usdc', symbol: 'USDC', decimals: 6 } }],
    ['an empty token symbol', { token: { address: USDC, symbol: '', decimals: 6 } }],
    ['negative decimals', { token: { address: USDC, symbol: 'USDC', decimals: -1 } }],
    ['too many decimals', { token: { address: USDC, symbol: 'USDC', decimals: 37 } }],
    ['an amount that is not decimal text', { amount: '1e6' }],
    ['a zero base amount', { amountBaseUnits: '0' }],
    ['a base amount with a leading zero', { amountBaseUnits: '012' }],
    ['a base amount that is a number', { amountBaseUnits: 12 }],
    ['a zero creation time', { createdAt: 0 }],
    ['a bad output amount', { outputAmount: 'many' }],
    ['an empty output symbol', { outputSymbol: '' }],
    ['a form that is not an object', { form: ['a'] }],
    ['a form with a value that is not text', { form: { a: 1 } }],
    ['a form with an empty key', { form: { '': 'a' } }],
    ['a form with a long value', { form: { a: 'x'.repeat(2049) } }],
    ['a form with too many entries', { form: Object.fromEntries([...Array(33).keys()].map(i => [`k${i}`, 'v'])) }]
  ])('drops a record with %s', (_name, change) => {
    expect(parsePendingRelayDeposit({ ...deposit(), ...change }, ACCOUNT)).toBeNull();
  });

  it('drops a value that is not an object', () => {
    expect(parsePendingRelayDeposit('deposit', ACCOUNT)).toBeNull();
  });
});

describe('parsePendingRelayDeposits', () => {
  it('keeps the newest five valid entries, newest first, one for each id', () => {
    const stored = [
      ...[1, 2, 3, 4, 5, 6].map(n => deposit({ id: `d${n}`, createdAt: n })),
      deposit({ id: 'd6', createdAt: 99 }),
      { broken: true }
    ];
    expect(parsePendingRelayDeposits(stored, ACCOUNT).map(entry => entry.id)).toEqual(['d6', 'd5', 'd4', 'd3', 'd2']);
    expect(MAX_PENDING_RELAY_DEPOSITS).toBe(5);
  });

  it('is empty for a value that is not a list', () => {
    expect(parsePendingRelayDeposits(null, ACCOUNT)).toEqual([]);
    expect(parsePendingRelayDeposits({ id: 'd1' }, ACCOUNT)).toEqual([]);
  });
});

describe('the storage writers', () => {
  it('saves a deposit through putToStorage in one storage turn of the key', async () => {
    await savePendingRelayDeposit(deposit());

    expect(turns).toEqual([KEY]);
    expect(mockPut).toHaveBeenCalledWith(KEY, [deposit()]);
    await expect(readPendingRelayDeposits(ACCOUNT)).resolves.toEqual([deposit()]);
  });

  it('replaces an entry with the same id, and keeps the newest five', async () => {
    for (const n of [1, 2, 3, 4, 5]) await savePendingRelayDeposit(deposit({ id: `d${n}`, createdAt: n }));
    await savePendingRelayDeposit(deposit({ id: 'd2', createdAt: 2, amount: '7' }));
    await savePendingRelayDeposit(deposit({ id: 'd6', createdAt: 6 }));

    const stored = await readPendingRelayDeposits(ACCOUNT);
    expect(stored.map(entry => entry.id)).toEqual(['d6', 'd5', 'd4', 'd3', 'd2']);
    expect(stored.find(entry => entry.id === 'd2')?.amount).toBe('7');
  });

  it('refuses a deposit that does not parse, before any write', async () => {
    await expect(savePendingRelayDeposit(deposit({ amountBaseUnits: '0' }))).rejects.toThrow(TypeError);
    expect(mockPut).not.toHaveBeenCalled();
  });

  it('drops a stored entry that does not parse when it writes', async () => {
    storage.set(KEY, [{ broken: true }, deposit({ id: 'old' })]);
    await savePendingRelayDeposit(deposit({ id: 'new', createdAt: 2_000 }));
    expect(storage.get(KEY)).toEqual([deposit({ id: 'new', createdAt: 2_000 }), deposit({ id: 'old' })]);
  });

  it('removes one deposit and leaves the others', async () => {
    await savePendingRelayDeposit(deposit({ id: 'd1', createdAt: 1 }));
    await savePendingRelayDeposit(deposit({ id: 'd2', createdAt: 2 }));

    await removePendingRelayDeposit(ACCOUNT, 'd1');
    await removePendingRelayDeposit(ACCOUNT, 'missing');

    await expect(readPendingRelayDeposits(ACCOUNT)).resolves.toEqual([deposit({ id: 'd2', createdAt: 2 })]);
  });
});

describe('usePendingRelayDeposits', () => {
  it('reads the deposits of the account through the storage hook', () => {
    storage.set(KEY, [deposit(), { broken: true }]);
    const { result } = renderHook(() => usePendingRelayDeposits(ACCOUNT));
    expect(result.current).toEqual([deposit()]);
  });

  it('is empty with no account', () => {
    storage.set('relay_pending_deposits_v1:', [deposit()]);
    const { result } = renderHook(() => usePendingRelayDeposits(undefined));
    expect(result.current).toEqual([]);
  });
});
