import type { TransactionRequest } from '@miden-sdk/miden-sdk/lazy';

import { observeTransactionExecutionRequest } from './transaction-execution-diagnostics';

const digest = { toU64s: () => BigUint64Array.from([1n, 2n, 3n, 4n]), free: jest.fn() };
let hashingFails = false;
let hashInput: unknown;
jest.mock('@miden-sdk/miden-sdk/lazy', () => ({
  FeltArray: class {
    constructor(values: unknown) {
      hashInput = values;
    }
  },
  Poseidon2: {
    hashElements: () => {
      if (hashingFails) throw new Error('private hash');
      return digest;
    }
  }
}));
jest.mock('@openzeppelin/miden-multisig-client', () => ({ getProcedureRoot: () => 'pinned-public-root' }));

function request(values?: bigint[], mismatch = false): TransactionRequest {
  return {
    authArg: () => ({ toU64s: () => BigUint64Array.from(mismatch ? [9n, 2n, 3n, 4n] : [1n, 2n, 3n, 4n]) }),
    adviceMap: () => ({ get: () => values })
  } as never;
}

beforeEach(() => {
  hashingFails = false;
  hashInput = undefined;
  digest.free.mockClear();
});

it.each([
  [8, false, 'fee', 'fee'],
  [12, false, 'guardian', 'guardian'],
  [8, true, 'fee', 'neither'],
  [7, false, 'other', 'unavailable']
])(
  'observes supported layout/match locally for %s elements without changing advice',
  (count, mismatch, layout, match) => {
    const values = Array.from({ length: Number(count) }, (_, index) => BigInt(index));
    const original = [...values];
    const facts = observeTransactionExecutionRequest(request(values, Boolean(mismatch)), 'ordinary_new_transaction');
    expect(facts).toEqual({
      executionRoute: 'ordinary_new_transaction',
      authObservation: 'observed',
      authArgPresence: 'present',
      authLayout: layout,
      commitmentMatch: match,
      accountAuthCode: 'unavailable'
    });
    expect(values).toEqual(original);
    expect(JSON.stringify(facts)).not.toContain('private');
  }
);

it('retains known presence/layout on a failed hash and contains the error', () => {
  hashingFails = true;
  expect(observeTransactionExecutionRequest(request(Array(8).fill(1n)), 'guardian_signed_request')).toEqual({
    executionRoute: 'guardian_signed_request',
    authObservation: 'read_failed',
    authArgPresence: 'present',
    authLayout: 'fee',
    commitmentMatch: 'unavailable',
    accountAuthCode: 'unavailable'
  });
});

it('does not consume the auth word or request and hashes only a private copy of fee advice', () => {
  const values = [0n, 1n, 2n, 3n, 4n, 5n, 6n, 7n];
  const authFree = jest.fn();
  const requestFree = jest.fn();
  const auth = Object.freeze({ toU64s: () => BigUint64Array.from([1n, 2n, 3n, 4n]), free: authFree });
  const borrowed = Object.freeze({ authArg: () => auth, adviceMap: () => ({ get: () => values }), free: requestFree });
  observeTransactionExecutionRequest(borrowed as never, 'ordinary_new_transaction');
  expect(hashInput).toEqual([4n, 5n, 6n, 7n, 0n, 1n, 2n, 3n]);
  expect(values).toEqual([0n, 1n, 2n, 3n, 4n, 5n, 6n, 7n]);
  expect(authFree).not.toHaveBeenCalled();
  expect(requestFree).not.toHaveBeenCalled();
  expect(digest.free).toHaveBeenCalledTimes(1);
});
