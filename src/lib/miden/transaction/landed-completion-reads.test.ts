import { NoteScript, NoteType, type TransactionResult } from '@miden-sdk/miden-sdk/lazy';

import { installLandedTrapRetirement } from 'lib/miden/sdk/landed-trap-retirement';
import { snapshotCrashDiagnostics } from 'lib/telemetry/crash-diagnostics';

import {
  consumeCompletionRead,
  customCompletionRead,
  forgetLandedCompletion,
  keptOrThrow,
  readLandedCompletion,
  sendCompletionRead,
  swapCompletionRead
} from './landed-completion-reads';
import { TX_FEE_NOTE_TAG } from '../activity/fee-notes';
import type { ITransaction, SendTransaction, SwapTransaction } from '../db/types';

jest.mock('../sdk/helpers', () => ({
  ...jest.requireActual('../sdk/helpers'),
  getBech32AddressFromAccountId: (id: string) => id
}));
// A chain that charges, so the fee split finds the kernel's note.
jest.mock('lib/miden-chain/native-asset', () => ({
  ...jest.requireActual('lib/miden-chain/native-asset'),
  getNativeAssetIdSync: () => 'native',
  getVerificationBaseFeeSync: () => 10000
}));

const feeNote = {
  id: () => ({ toString: () => 'fee-note' }),
  metadata: () => ({ tag: () => ({ asU32: () => TX_FEE_NOTE_TAG }) }),
  assets: () => ({
    fungibleAssets: () => [{ faucetId: () => 'native', amount: () => 100n }],
    nonFungibleAssets: () => []
  })
};

// A result with the fee note, one user note and `inputs` copies of one input note. The reads a completion's order
// turns on are logged by name; each can be made to throw instead.
const recordingResult = (
  noteType: NoteType,
  { inputs = 1, throws = {} }: { inputs?: number; throws?: Record<string, unknown> } = {}
) => {
  const reads: string[] = [];
  const logged =
    <T>(name: string, read: () => T) =>
    () => {
      reads.push(name);
      if (name in throws) throw throws[name];
      return read();
    };
  const body = {
    id: () => ({ toString: logged('noteId', () => 'user-note') }),
    metadata: () => ({ noteType: logged('noteType', () => noteType), sender: logged('sender', () => 'sender') }),
    assets: () => ({
      fungibleAssets: () => [{ faucetId: () => 'faucet', amount: () => 5n }],
      nonFungibleAssets: () => []
    }),
    recipient: () => ({
      script: () => ({ root: () => NoteScript.pswap().root() }),
      serialNum: () => ({ toFelts: () => [{ asInt: () => 0n }, { asInt: () => 42n }] })
    })
  };
  const userNote = { ...body, intoFull: logged('intoFull', () => body) };
  const inputNote = { id: () => ({ toString: () => 'input-note' }), note: logged('inputNote', () => body) };
  const executed = {
    id: () => ({ toHex: logged('toHex', () => 'landed-id') }),
    outputNotes: logged('outputNotes', () => ({ notes: () => [feeNote, userNote] })),
    inputNotes: logged('inputNotes', () => ({ notes: () => Array.from({ length: inputs }, () => inputNote) })),
    blockHeader: () => ({ verificationBaseFee: () => 10000 })
  };
  const result: TransactionResult = Object.create(null);
  Object.assign(result, {
    executedTransaction: logged('executedTransaction', () => executed),
    serialize: logged('serialize', () => new Uint8Array([7]))
  });
  return { result, reads };
};

const row = (id: string, type: string, fields: Record<string, unknown> = {}) =>
  ({ id, type, accountId: 'account', secondaryAccountId: 'recipient', noteType: 'public', ...fields }) as ITransaction;

let retire: jest.Mock;
let restore: () => void;

beforeEach(() => {
  retire = jest.fn();
  restore = installLandedTrapRetirement(retire);
});

afterEach(() => restore());

// Each sequence is the completion's own, read off complete.ts before the reads moved: what it reads before its first
// await, and for a consume in each of its steps.
it.each<[string, NoteType, Record<string, unknown>, string[]]>([
  [
    'send',
    NoteType.Public,
    {},
    [
      ...['executedTransaction', 'executedTransaction', 'outputNotes', 'intoFull', 'noteId', 'noteType'],
      ...['executedTransaction', 'toHex', 'serialize', 'executedTransaction', 'outputNotes']
    ]
  ],
  [
    'execute',
    NoteType.Private,
    {},
    [
      ...['executedTransaction', 'executedTransaction', 'outputNotes', 'noteType', 'noteId', 'intoFull'],
      ...['executedTransaction', 'toHex', 'serialize', 'executedTransaction', 'outputNotes'],
      ...['executedTransaction', 'inputNotes', 'executedTransaction', 'outputNotes', 'inputNote'],
      ...['executedTransaction', 'toHex', 'noteId', 'serialize']
    ]
  ],
  [
    'consume',
    NoteType.Public,
    {},
    [
      ...['executedTransaction', 'inputNotes', 'inputNote', 'sender', 'inputNote', 'inputNote', 'noteType', 'toHex'],
      ...['executedTransaction', 'outputNotes', 'serialize', 'inputNote', 'noteId', 'sender']
    ]
  ],
  [
    'swap',
    NoteType.Public,
    {},
    [
      ...['executedTransaction', 'executedTransaction', 'outputNotes', 'noteType', 'intoFull', 'intoFull', 'noteId'],
      ...['executedTransaction', 'outputNotes', 'toHex', 'serialize']
    ]
  ],
  [
    'bridged-send',
    NoteType.Public,
    {},
    [
      ...['executedTransaction', 'executedTransaction', 'outputNotes', 'intoFull', 'noteId'],
      ...['executedTransaction', 'outputNotes', 'toHex', 'serialize']
    ]
  ],
  [
    'bridged-send',
    NoteType.Public,
    { extraInputs: { usdcxBurn: { noteId: 'burn-note' } } },
    ['executedTransaction', 'executedTransaction', 'outputNotes', 'toHex', 'serialize']
  ],
  [
    'earn-deposit',
    NoteType.Public,
    {},
    [
      ...['executedTransaction', 'executedTransaction', 'outputNotes', 'intoFull', 'noteId'],
      ...['executedTransaction', 'outputNotes', 'toHex', 'serialize']
    ]
  ]
])("reads a %s completion's handles in that completion's order", (type, noteType, fields, expected) => {
  const { result, reads } = recordingResult(noteType);
  const errors = jest.spyOn(console, 'error').mockImplementation(() => {});
  try {
    readLandedCompletion(row(`row-order-${type}-${reads.length}`, type, fields), result);
  } finally {
    errors.mockRestore();
    forgetLandedCompletion(result);
  }

  expect(reads).toEqual(expected);
  expect(retire).not.toHaveBeenCalled();
});

it('ends a read at the statement that throws, retires a trap there once under the row, and keeps the error as itself', () => {
  const trap = new WebAssembly.RuntimeError('unreachable');
  const { result, reads } = recordingResult(NoteType.Public, { throws: { toHex: trap } });

  const completion = readLandedCompletion(row('row-stops', 'swap') as SwapTransaction, result);
  forgetLandedCompletion(result);

  expect(reads.slice(-1)).toEqual(['toHex']);
  expect(reads).not.toContain('serialize');
  expect(retire.mock.calls).toEqual([[trap, 'row-stops']]);
  let thrown: unknown;
  try {
    keptOrThrow(completion.read as ReturnType<typeof swapCompletionRead>);
  } catch (error) {
    thrown = error;
  }
  expect(thrown).toBe(trap);
});

it("answers a completion of the same row and arm from the tail's read, and reads again for another row or arm, or after the tail", () => {
  const { result, reads } = recordingResult(NoteType.Public);
  const send = row('row-kept', 'send') as SendTransaction;

  const tail = readLandedCompletion(send, result);
  const tailReads = reads.length;
  expect(sendCompletionRead(send, result)).toBe(tail.read);
  expect(reads).toHaveLength(tailReads);

  const otherRow = sendCompletionRead({ ...send, id: 'row-other' }, result);
  expect(otherRow).not.toBe(tail.read);
  const afterOtherRow = reads.length;
  expect(afterOtherRow).toBeGreaterThan(tailReads);

  const otherArm = customCompletionRead(send, result);
  expect(otherArm).not.toBe(tail.read);
  expect(reads.length).toBeGreaterThan(afterOtherRow);

  forgetLandedCompletion(result);
  const afterTail = reads.length;
  const direct = sendCompletionRead(send, result);
  expect(direct).not.toBe(tail.read);
  expect(direct).toEqual(tail.read);
  expect(reads.length).toBeGreaterThan(afterTail);
});

describe("a consume's read", () => {
  it('reads no bytes once its notes refused, and keeps the refusal its completion names', () => {
    const { result, reads } = recordingResult(NoteType.Public, { inputs: 0 });

    const read = consumeCompletionRead('row-consume-refused', result);

    expect(reads).toEqual(['executedTransaction', 'inputNotes']);
    expect('error' in read && snapshotCrashDiagnostics(read.error)).toMatchObject({
      completionStep: 'result_read',
      completionGuard: 'no_input_notes'
    });
  });

  it('reads no deliveries once its bytes failed, and keeps the fields it read', () => {
    const failure = new Error('serialize failed');
    const { result, reads } = recordingResult(NoteType.Public, { throws: { serialize: failure } });

    const read = keptOrThrow(consumeCompletionRead('row-consume-bytes', result));

    expect(reads.slice(reads.indexOf('serialize'))).toEqual(['serialize']);
    expect(read).toMatchObject({ sender: 'sender', transactionId: 'landed-id', amount: 5n });
    expect(read.bytes).toEqual({ error: failure });
  });
});
