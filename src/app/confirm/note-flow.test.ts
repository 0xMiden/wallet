import { TransactionResult, TransactionSummary } from '@miden-sdk/miden-sdk/lazy';

import { noteFlowFromSimulatedBytes, noteFlowFromTransaction } from './note-flow';

jest.mock('@miden-sdk/miden-sdk/lazy', () => ({
  NoteScript: {
    p2id: () => ({ root: () => ({ toHex: () => 'p2id-root' }) }),
    p2ide: () => ({ root: () => ({ toHex: () => 'p2ide-root' }) }),
    pswap: () => ({ root: () => ({ toHex: () => 'pswap-root' }) }),
    swap: () => ({ root: () => ({ toHex: () => 'swap-root' }) }),
    mint: () => ({ root: () => ({ toHex: () => 'mint-root' }) }),
    burn: () => ({ root: () => ({ toHex: () => 'burn-root' }) }),
    networkAccountConfig: () => ({ root: () => ({ toHex: () => 'network-account-config-root' }) }),
    feeSponsorship: () => ({ root: () => ({ toHex: () => 'fee-sponsorship-root' }) })
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

const note = (id: string, root: string, visibility = 1, standardNoteName?: string | null) => ({
  id: () => ({ toString: () => id }),
  metadata: () => ({ noteType: () => visibility, sender: () => 'sender' }),
  assets: () => ({
    fungibleAssets: () => [{ faucetId: () => 'faucet', amount: () => 4n }],
    nonFungibleAssets: () => []
  }),
  script: () => ({
    root: () => ({ toHex: () => root }),
    ...(standardNoteName === undefined
      ? {}
      : { standardNoteName: () => (standardNoteName === null ? undefined : standardNoteName) })
  })
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
    ['payment', 'P2ID'],
    ['partial', 'unknown'],
    ['swap', 'PSWAP'],
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
    ['in-1', 'P2IDE'],
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
  expect(flow.outputs[0]?.kind).toBe('P2ID');
  expect(flow.storageChanges).toBeUndefined();
});

it('names every standard note the SDK can construct, and a script outside that list stays custom', () => {
  const tx = {
    inputNotes: () => ({ numNotes: () => 0, notes: () => [] }),
    userNotes: [
      output('sponsor', note('sponsor', 'FEE-SPONSORSHIP-ROOT')),
      output('swap', note('swap', 'swap-root')),
      output('mint', note('mint', 'mint-root')),
      output('burn', note('burn', 'burn-root')),
      output('config', note('config', 'network-account-config-root')),
      output('custom', note('custom', '0xnot-a-standard-script'))
    ],
    feeNote: undefined
  };
  expect(noteFlowFromTransaction(tx as any).outputs.map(item => [item.id, item.kind])).toEqual([
    ['sponsor', 'FEE_SPONSORSHIP'],
    ['swap', 'SWAP'],
    ['mint', 'MINT'],
    ['burn', 'BURN'],
    ['config', 'NETWORK_ACCOUNT_CONFIG'],
    ['custom', 'custom']
  ]);
});

it('uses StandardNote::from_script when the SDK reports it, including a tx fee that is not the partitioned fee', () => {
  const tx = {
    inputNotes: () => ({ numNotes: () => 0, notes: () => [] }),
    userNotes: [
      output('fee-script', note('fee-script', 'unlisted-root', 1, 'TX_FEE')),
      output('upgrade', note('upgrade', 'unlisted-root', 1, 'UPGRADE')),
      output('future', note('future', 'unlisted-root', 1, 'FUTURE_NOTE')),
      output('foreign', note('foreign', 'p2id-root', 1, null))
    ],
    feeNote: output('kernel-fee', note('kernel-fee', 'unlisted-root', 1, 'TX_FEE'))
  };
  expect(noteFlowFromTransaction(tx as any).outputs.map(item => [item.id, item.kind])).toEqual([
    ['fee-script', 'TX_FEE'],
    ['upgrade', 'UPGRADE'],
    ['future', 'FUTURE_NOTE'],
    ['foreign', 'custom'],
    ['kernel-fee', 'fee']
  ]);
});

it('leaves the kind unknown when the standard-note name cannot be read', () => {
  const broken = note('broken', 'tx-root');
  const script = broken.script();
  const tx = {
    inputNotes: () => ({ numNotes: () => 0, notes: () => [] }),
    userNotes: [
      output('broken', {
        ...broken,
        script: () => ({
          ...script,
          standardNoteName: () => {
            throw new Error('wasm');
          }
        })
      })
    ],
    feeNote: undefined
  };
  expect(noteFlowFromTransaction(tx as any).outputs[0]).toMatchObject({ id: 'broken', kind: 'unknown' });
});
