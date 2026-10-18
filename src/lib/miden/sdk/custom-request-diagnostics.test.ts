import type { TransactionRequest } from '@miden-sdk/miden-sdk/lazy';

import { customRequestAuthDiagnostics } from './custom-request-diagnostics';

let hashFails = false;
let hashInput: unknown;
let adviceFails = false;
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
      if (hashFails) throw new Error('sensitive hash input');
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
        if (adviceFails) throw new Error('sensitive advice');
        return values;
      }
    })
  } as unknown as TransactionRequest;
}

beforeEach(() => {
  hashFails = false;
  adviceFails = false;
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
  hashFails = true;
  expect(customRequestAuthDiagnostics(request([1, 2, 3, 4, 5, 6, 7, 8]))).toEqual({
    authLayout: 'fee',
    commitmentMatch: 'unavailable'
  });
});

it('contains SDK advice lookup failure', () => {
  adviceFails = true;
  expect(customRequestAuthDiagnostics(request([1, 2, 3, 4, 5, 6, 7, 8]))).toEqual({
    authLayout: 'unavailable',
    commitmentMatch: 'unavailable'
  });
});
