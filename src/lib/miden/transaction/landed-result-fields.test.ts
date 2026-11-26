import type { TransactionResult } from '@miden-sdk/miden-sdk/lazy';

import { installLandedTrapRetirement } from 'lib/miden/sdk/landed-trap-retirement';
import { WasmClientPoisonedError } from 'lib/miden/sdk/wasm-client-poison';

import { keptLandedTransactionId, keptValue, landedFee, readLandedResultFields } from './landed-result-fields';
import { TX_FEE_NOTE_TAG } from '../activity/fee-notes';
import { RegisterNameTransaction } from '../db/types';
import { canonicalFeeSponsorshipNoteId } from '../sdk/fee-sponsorship';

jest.mock('../sdk/helpers', () => ({
  ...jest.requireActual('../sdk/helpers'),
  getBech32AddressFromAccountId: (id: string) => id,
  canonicalWalletAccountId: (id: string) => id
}));
// A chain that charges, so the fee read finds the kernel's note.
jest.mock('lib/miden-chain/native-asset', () => ({
  ...jest.requireActual('lib/miden-chain/native-asset'),
  getNativeAssetIdSync: () => 'native',
  getVerificationBaseFeeSync: () => 10000
}));
jest.mock('../sdk/fee-sponsorship', () => ({
  canonicalFeeSponsorshipNoteId: jest.fn(() => 'sponsor-note')
}));

const feeNote = {
  id: () => ({ toString: () => 'fee-note' }),
  metadata: () => ({ tag: () => ({ asU32: () => TX_FEE_NOTE_TAG }) }),
  assets: () => ({
    fungibleAssets: () => [{ faucetId: () => 'native', amount: () => 100n }],
    nonFungibleAssets: () => []
  })
};

// Each accessor answers until `stop()`, then throws, as the handles of a client replaced since.
const landedResult = (id: () => string = () => 'landed-id') => {
  let stopped = false;
  const answering =
    <T>(read: () => T) =>
    () => {
      if (stopped) throw new Error('null pointer passed to rust');
      return read();
    };
  const executedTransaction = jest.fn(
    answering(() => ({
      id: () => ({ toHex: id }),
      outputNotes: () => ({ notes: () => [feeNote] })
    }))
  );
  const serialize = jest.fn(answering(() => new Uint8Array([7])));
  const result: TransactionResult = Object.create(null);
  Object.assign(result, { executedTransaction, serialize });
  return { result, executedTransaction, serialize, stop: () => (stopped = true) };
};

let retire: jest.Mock;
let restore: () => void;

beforeEach(() => {
  retire = jest.fn();
  restore = installLandedTrapRetirement(retire);
});

afterEach(() => restore());

it('reads a landed result once and answers later calls from that read', () => {
  const { result, executedTransaction, serialize, stop } = landedResult();

  const first = readLandedResultFields(result, 'row-once');
  const reads = [executedTransaction.mock.calls.length, serialize.mock.calls.length];
  stop();
  const second = readLandedResultFields(result, 'row-once');

  expect(second).toBe(first);
  expect([executedTransaction.mock.calls.length, serialize.mock.calls.length]).toEqual(reads);
  expect(serialize).toHaveBeenCalledTimes(1);
  expect(first).toEqual({
    transactionId: { value: 'landed-id' },
    resultBytes: { value: new Uint8Array([7]) },
    feeFields: { value: { feeAmount: 100n, feeFaucetId: 'native' } }
  });
  expect(landedFee(second)).toEqual({ feeAmount: 100n, feeFaucetId: 'native' });
  expect(retire).not.toHaveBeenCalled();
});

it('retires a trap once under the row and keeps the error instead of throwing', () => {
  const trap = new WebAssembly.RuntimeError('unreachable');
  const { result } = landedResult(() => {
    throw trap;
  });

  const fields = readLandedResultFields(result, 'row-trap');

  expect(retire.mock.calls).toEqual([[trap, 'row-trap']]);
  expect(fields.transactionId).toEqual({ error: trap });
  expect(keptValue(fields.transactionId)).toBeUndefined();
  expect(fields.resultBytes).toEqual({ value: new Uint8Array([7]) });
  expect(fields.feeFields).toEqual({ value: { feeAmount: 100n, feeFaucetId: 'native' } });
});

it('peeks at the kept id without reading the result', () => {
  const { result, executedTransaction } = landedResult();

  expect(keptLandedTransactionId(result)).toBeUndefined();
  expect(executedTransaction).not.toHaveBeenCalled();

  readLandedResultFields(result, 'row-peek');
  const reads = executedTransaction.mock.calls.length;
  expect(keptLandedTransactionId(result)).toBe('landed-id');
  expect(executedTransaction).toHaveBeenCalledTimes(reads);
});

it('peeks at no id when the read kept an error', () => {
  const { result } = landedResult(() => {
    throw new Error('id unreadable');
  });

  readLandedResultFields(result, 'row-peek-error');

  expect(keptLandedTransactionId(result)).toBeUndefined();
});

// The fee read lets only an eviction out, so the write that spreads the fee throws where it threw before.
it('rethrows an eviction the fee read kept as the same object, without retiring', () => {
  const eviction = new WasmClientPoisonedError('watchdog');
  const { result, executedTransaction } = landedResult();
  const answer = executedTransaction.getMockImplementation()!;
  executedTransaction.mockImplementationOnce(answer).mockImplementationOnce(() => {
    throw eviction;
  });

  const fields = readLandedResultFields(result, 'row-eviction');

  expect(keptValue(fields.transactionId)).toBe('landed-id');
  expect(fields.feeFields).toEqual({ error: eviction });
  let thrown: unknown;
  try {
    landedFee(fields);
  } catch (error) {
    thrown = error;
  }
  expect(thrown).toBe(eviction);
  expect(retire).not.toHaveBeenCalled();
});

it('forwards the originating transaction to feeFieldsFromResult so register-name companion fees are included', () => {
  jest.mocked(canonicalFeeSponsorshipNoteId).mockReset().mockReturnValue('sponsor-note');
  const regNote = {
    id: () => ({ toString: () => 'reg-note' }),
    metadata: () => ({ tag: () => ({ asU32: () => 0 }) }),
    assets: () => ({
      fungibleAssets: () => [{ faucetId: () => 'pay', amount: () => 20_000_000n }],
      nonFungibleAssets: () => []
    })
  };
  const sponsorNote = {
    id: () => ({ toString: () => 'sponsor-note' }),
    metadata: () => ({ tag: () => ({ asU32: () => 0 }) }),
    assets: () => ({
      fungibleAssets: () => [{ faucetId: () => 'native', amount: () => 210n }],
      nonFungibleAssets: () => []
    })
  };
  const tx = new RegisterNameTransaction({
    accountId: 'acct',
    label: 'alice',
    network: 'testnet',
    paymentFaucetId: 'pay',
    registryAccountId: 'registry',
    priceBaseUnits: 20_000_000n,
    networkFeeBaseUnits: 210n,
    requestBytes: new Uint8Array([1]),
    registrationNoteId: 'reg-note',
    reclaimHeight: 1300,
    builtAtBlock: 1000
  });
  const result: TransactionResult = Object.assign(Object.create(null), {
    executedTransaction: () => ({
      id: () => ({ toHex: () => 'landed-reg-id' }),
      outputNotes: () => ({ notes: () => [regNote, sponsorNote, feeNote] })
    }),
    serialize: () => new Uint8Array([7])
  });

  const fields = readLandedResultFields(result, tx.id, tx);

  expect(landedFee(fields)).toEqual({ feeAmount: 310n, feeFaucetId: 'native' });
});
