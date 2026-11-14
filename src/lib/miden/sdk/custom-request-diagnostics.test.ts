import type { MidenClient, TransactionRequest } from '@miden-sdk/miden-sdk/lazy';

import { customRequestAccountAuthCode, customRequestAuthDiagnostics } from './custom-request-diagnostics';

let hashFailure: unknown;
let hashInput: unknown;
let adviceFailure: unknown;
const hashWord = { toU64s: () => BigUint64Array.from([10n, 20n, 30n, 40n]), free: jest.fn() };

jest.mock('@openzeppelin/miden-multisig-client', () => ({ getProcedureRoot: () => 'public-pinned-root' }));

jest.mock('@miden-sdk/miden-sdk/lazy', () => ({
  FeltArray: class {
    constructor(values: unknown) {
      hashInput = values;
    }
  },
  Poseidon2: {
    hashElements: () => {
      if (hashFailure !== undefined) throw hashFailure;
      return hashWord;
    }
  }
}));

const auth = { toU64s: () => BigUint64Array.from([10n, 20n, 30n, 40n]) };
function request(values?: number[], word: typeof auth | undefined = auth): TransactionRequest {
  return {
    authArg: () => word,
    adviceMap: () => ({
      get: () => {
        if (adviceFailure !== undefined) throw adviceFailure;
        return values;
      }
    })
  } as unknown as TransactionRequest;
}

const thrownBy = (run: () => unknown): unknown => {
  try {
    run();
  } catch (error) {
    return error;
  }
  return undefined;
};

beforeEach(() => {
  hashFailure = undefined;
  adviceFailure = undefined;
  hashInput = undefined;
  hashWord.free.mockClear();
});

it.each([
  [[], 'other', 'unavailable'],
  [[1, 2, 3, 4, 5, 6, 7, 8], 'fee', 'fee'],
  [[1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12], 'guardian', 'guardian']
])('derives only closed categories from auth advice %j', (values, authLayout, commitmentMatch) => {
  expect(customRequestAuthDiagnostics(request(values as number[]))).toEqual({ authLayout, commitmentMatch });
});

it('reorders the fee preimage and leaves request advice untouched', () => {
  const values = [1, 2, 3, 4, 5, 6, 7, 8];
  customRequestAuthDiagnostics(request(values));
  expect(hashInput).toEqual([5, 6, 7, 8, 1, 2, 3, 4]);
  expect(values).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
  expect(hashWord.free).toHaveBeenCalledTimes(1);
});

it('keeps the Guardian block, salt and fee words in their original order', () => {
  customRequestAuthDiagnostics(request([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]));
  expect(hashInput).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]);
});

it('distinguishes mismatched authentication from unavailable advice', () => {
  const mismatch = { toU64s: () => BigUint64Array.from([99n, 20n, 30n, 40n]) };
  expect(customRequestAuthDiagnostics(request([1, 2, 3, 4, 5, 6, 7, 8], mismatch))).toEqual({
    authLayout: 'fee',
    commitmentMatch: 'neither'
  });
  expect(customRequestAuthDiagnostics(request(undefined))).toEqual({
    authLayout: 'missing_preimage',
    commitmentMatch: 'unavailable'
  });
});

it('recognizes authentication that is absent', () => {
  expect(customRequestAuthDiagnostics({ authArg: () => undefined } as unknown as TransactionRequest)).toEqual({
    authLayout: 'absent',
    commitmentMatch: 'unavailable'
  });
});

it('does not hash arbitrary advice shapes', () => {
  customRequestAuthDiagnostics(request([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13]));
  expect(hashInput).toBeUndefined();
});

it('keeps a recognized layout when hashing fails without returning the error', () => {
  hashFailure = new Error('sensitive hash input');
  expect(customRequestAuthDiagnostics(request([1, 2, 3, 4, 5, 6, 7, 8]))).toEqual({
    authLayout: 'fee',
    commitmentMatch: 'unavailable'
  });
});

it('contains SDK advice lookup failure', () => {
  adviceFailure = new Error('sensitive advice');
  expect(customRequestAuthDiagnostics(request([1, 2, 3, 4, 5, 6, 7, 8]))).toEqual({
    authLayout: 'unavailable',
    commitmentMatch: 'unavailable'
  });
});

it.each([['the advice read'], ['the hash']])(
  'rethrows a trap from %s as that same object without reporting read_failed',
  source => {
    const trap = new WebAssembly.RuntimeError('unreachable');
    if (source === 'the hash') hashFailure = trap;
    else adviceFailure = trap;
    const observe = jest.fn();
    expect(thrownBy(() => customRequestAuthDiagnostics(request([1, 2, 3, 4, 5, 6, 7, 8]), observe))).toBe(trap);
    expect(observe).not.toHaveBeenCalledWith('read_failed');
  }
);

const accountReadFailing = (failure: unknown) =>
  ({
    accounts: {
      get: async () => {
        throw failure;
      }
    }
  }) as unknown as MidenClient;

it('customRequestAccountAuthCode rethrows a trap from the account read as that same object', async () => {
  const trap = new WebAssembly.RuntimeError('unreachable');
  await expect(customRequestAccountAuthCode(accountReadFailing(trap), 'acc')).rejects.toBe(trap);
});

it('customRequestAccountAuthCode rethrows a terminated client from the account read as itself', async () => {
  const terminated = new Error('Client terminated');
  await expect(customRequestAccountAuthCode(accountReadFailing(terminated), 'acc')).rejects.toBe(terminated);
});
