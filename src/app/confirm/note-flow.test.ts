import { TransactionResult, TransactionSummary } from '@miden-sdk/miden-sdk/lazy';

import { noteFlowFromSimulatedBytes, noteFlowFromTransaction } from './note-flow';

jest.mock('@miden-sdk/miden-sdk/lazy', () => ({
  NoteScript: {
    p2id: () => ({ root: () => ({ toHex: () => 'p2id-root' }) }),
    p2ide: () => ({ root: () => ({ toHex: () => 'p2ide-root' }) }),
    pswap: () => ({ root: () => ({ toHex: () => 'pswap-root' }) })
  },
  NoteType: { Private: 0, Public: 1 },
  TransactionResult: { deserialize: jest.fn() },
  TransactionSummary: { deserialize: jest.fn() },
  StoragePatchOperation: { Create: 0, Update: 1, Remove: 2 }
}));
jest.mock('lib/miden/sdk/helpers', () => ({ getBech32AddressFromAccountId: (id: string) => `bech32:${id}` }));
jest.mock('lib/miden/activity/fee-notes', () => ({
  splitExecutedOutputNotes: (tx: any) => ({ feeNote: tx.feeNote, userNotes: tx.userNotes })
}));
jest.mock('lib/shared/helpers', () => ({ b64ToU8: (value: string) => new Uint8Array([value.length]) }));

const note = (id: string, root: string, visibility = 1) => ({
  id: () => ({ toString: () => id }),
  metadata: () => ({ noteType: () => visibility, sender: () => 'sender' }),
  assets: () => ({
    fungibleAssets: () => [{ faucetId: () => 'faucet', amount: () => 4n }],
    nonFungibleAssets: () => []
  }),
  script: () => ({ root: () => ({ toHex: () => root }) })
});
const output = (id: string, full?: ReturnType<typeof note>) => ({
  id: () => ({ toString: () => id }),
  metadata: () => full?.metadata() ?? { noteType: () => 0, sender: () => 'sender' },
  assets: () => undefined,
  intoFull: () => full
});

it('lists zero inputs and every output, including the fee note', () => {
  const tx = {
    inputNotes: () => ({ numNotes: () => 0, notes: () => [] }),
    userNotes: [
      output('payment', note('payment', 'p2id-root')),
      output('partial'),
      output('swap', note('swap', 'pswap-root'))
    ],
    feeNote: output('fee')
  };
  const flow = noteFlowFromTransaction(tx as any);
  expect(flow.inputs).toEqual([]);
  expect(flow.inputCount).toBe(0);
  expect(flow.outputs.map(n => [n.id, n.kind])).toEqual([
    ['payment', 'p2id'],
    ['partial', 'unknown'],
    ['swap', 'pswap'],
    ['fee', 'fee']
  ]);
  expect(flow.outputs[0]).toMatchObject({ visibility: 'public', sender: 'bech32:sender' });
  expect(flow.outputs[1]).toMatchObject({ visibility: 'private', assets: undefined });
  expect(flow.outputs[0]?.assets).toEqual([{ faucetId: 'bech32:faucet', amount: 4n }]);
});

it('keeps multiple inputs and labels unknown full scripts without inventing a recipient', () => {
  const tx = {
    inputNotes: () => ({
      numNotes: () => 2,
      notes: () => [
        { id: () => ({ toString: () => 'in-1' }), note: () => note('in-1', 'p2ide-root') },
        { id: () => ({ toString: () => 'in-2' }), note: () => note('in-2', 'custom-root', 0) }
      ]
    }),
    userNotes: [],
    feeNote: undefined
  };
  const flow = noteFlowFromTransaction(tx as any);
  expect(flow.inputs.map(n => [n.id, n.kind])).toEqual([
    ['in-1', 'p2ide'],
    ['in-2', 'custom']
  ]);
  expect(flow.inputs[1]).not.toHaveProperty('recipient');
});

it('retains an unavailable-detail placeholder when a note accessor fails', () => {
  const tx = {
    inputNotes: () => ({
      numNotes: () => 1,
      notes: () => [
        {
          id: () => ({ toString: () => 'opaque' }),
          note: () => {
            throw new Error('partial');
          }
        }
      ]
    }),
    userNotes: [],
    feeNote: undefined
  };
  expect(noteFlowFromTransaction(tx as any).inputs).toEqual([
    expect.objectContaining({ id: 'opaque', kind: 'unknown', assets: undefined })
  ]);
});

it('reads either authoritative dry-run shape and leaves absent summaries unknown', () => {
  const tx = { inputNotes: () => ({ numNotes: () => 0, notes: () => [] }), userNotes: [], feeNote: undefined };
  (TransactionSummary.deserialize as jest.Mock).mockReturnValueOnce(tx);
  (TransactionResult.deserialize as jest.Mock).mockReturnValueOnce({ executedTransaction: () => tx });
  expect(noteFlowFromSimulatedBytes({ summaryBytes: 'summary' })).toMatchObject({ inputCount: 0, outputs: [] });
  expect(noteFlowFromSimulatedBytes({ executedBytes: 'executed' })).toMatchObject({ inputCount: 0, outputs: [] });
  expect(noteFlowFromSimulatedBytes({})).toBeUndefined();
  expect(TransactionSummary.deserialize).toHaveBeenCalledWith(new Uint8Array([7]));
  expect(TransactionResult.deserialize).toHaveBeenCalledWith(new Uint8Array([8]));
});

it('lists named storage slot operations without guessing slot meaning or exposing raw words', () => {
  const tx = {
    inputNotes: () => ({ numNotes: () => 0, notes: () => [] }),
    userNotes: [],
    feeNote: undefined,
    accountDelta: () => ({
      storage: () => ({
        isEmpty: () => false,
        valueSlots: () => [{ slotName: 'counter', operation: 1, value: { toHex: () => 'secret' } }],
        mapSlots: () => [{ slotName: 'balances', operation: 0, entries: () => [{ key: 'private-key' }] }]
      })
    })
  };
  expect(noteFlowFromTransaction(tx as any).storageChanges).toEqual([
    { slotName: 'counter', kind: 'value', operation: 'update' },
    { slotName: 'balances', kind: 'map', operation: 'create', entryCount: 1 }
  ]);
});

it('distinguishes an empty storage patch from unknown operations and removed slots', () => {
  const transaction = (patch: unknown) => ({
    inputNotes: () => ({ numNotes: () => 0, notes: () => [] }),
    userNotes: [],
    feeNote: undefined,
    accountPatch: () => ({ storage: () => patch })
  });
  expect(noteFlowFromTransaction(transaction({ isEmpty: () => true }) as any).storageChanges).toEqual([]);
  expect(
    noteFlowFromTransaction(
      transaction({
        isEmpty: () => false,
        valueSlots: () => [
          { slotName: 'old', operation: 2 },
          { slotName: 'future', operation: 99 }
        ],
        mapSlots: () => []
      }) as any
    ).storageChanges
  ).toEqual([
    { slotName: 'old', kind: 'value', operation: 'remove' },
    { slotName: 'future', kind: 'value', operation: 'unknown' }
  ]);
});

it('keeps note details when a storage slot cannot be decoded', () => {
  const tx = {
    inputNotes: () => ({ numNotes: () => 0, notes: () => [] }),
    userNotes: [output('payment', note('payment', 'p2id-root'))],
    feeNote: undefined,
    accountDelta: () => ({
      storage: () => ({
        isEmpty: () => false,
        valueSlots: () => [
          {
            get slotName() {
              throw new Error('unreadable');
            },
            operation: 1
          }
        ],
        mapSlots: () => []
      })
    })
  };
  const flow = noteFlowFromTransaction(tx as any);
  expect(flow.outputs[0]?.kind).toBe('p2id');
  expect(flow.storageChanges).toBeUndefined();
});
