import type { DeltaObject, HistoryEntry, ProposalMetadata } from '@openzeppelin/guardian-client';
import { deserialize, serialize } from 'v8';

import {
  historyCheckpointId,
  normalizeHistoryOperators,
  reconcileRecoveredSwaps,
  recoveredAction,
  recoveredHistoryRecord,
  recoveredHotKeyMode,
  sameNonemptyNotes
} from './history';
import { GuardianHistoryDataError } from './history-errors';
import type { ITransaction, ITransactionType } from '../db/types';
import {
  ConsumeTransaction,
  ITransactionStatus,
  ReplaceHotKeyTransaction,
  SendTransaction,
  SwitchGuardianTransaction,
  UpdateProcedureThresholdTransaction
} from '../db/types';
import * as Repo from '../repo';
import type { GuardianHistoryNote, GuardianSummary } from '../sdk/guardian-history';
import { recoveredSwapOrderRef } from '../swap/recovered-order';
import { trackRecoveredSwapOrders } from '../swap/recovered-order-tracking';

// What the node says of a recovered order's lineage; its reads are pinned in pswap-order-note's suite.
const mockReadPswapOrderLineage = jest.fn();
jest.mock('../sdk/pswap-order-note', () => ({
  readPswapOrderLineage: (...args: unknown[]) => mockReadPswapOrderLineage(...args)
}));
jest.mock('lib/miden-chain/constants', () => ({ ensureSdkWasmReady: async () => undefined }));

const timestamp = '2026-08-01T00:00:00Z';
const entry: HistoryEntry = {
  nonce: 12,
  status: 'canonical',
  timestamp,
  newCommitment: 'final',
  inputNotes: [],
  outputNotes: [],
  decodeWarnings: []
};
function delta(proposal?: ProposalMetadata): DeltaObject {
  return {
    accountId: '0x123',
    nonce: 12,
    prevCommitment: 'previous',
    newCommitment: 'final',
    status: { status: 'canonical', timestamp },
    deltaPayload: { txSummary: { data: '' }, signatures: [] },
    metadata: { proposal }
  };
}
const summary: GuardianSummary = {
  accountId: '0x123',
  inputNotes: [],
  outputNotes: [
    {
      id: 'out',
      sender: 'account',
      recipient: 'recipient',
      visibility: 'private',
      assets: [{ faucetId: 'asset', amount: '9007199254740993' }]
    }
  ],
  fee: { faucetId: 'fee-asset', amount: '5' }
};
const actions: [string, ITransactionType][] = [
  ['p2id', 'send'],
  ['recallable_send', 'send'],
  ['consume_notes', 'consume'],
  ['custom_transaction', 'execute'],
  ['custom_label', 'execute'],
  ['swap', 'swap'],
  ['bridged_send', 'bridged-send'],
  ['agglayer_bridged_send', 'bridged-send'],
  ['earn_deposit', 'earn-deposit'],
  ['switch_guardian', 'switch-guardian'],
  ['add_signer', 'execute'],
  ['update_procedure_threshold', 'update-procedure-threshold'],
  ['bridged_receive', 'execute'],
  ['earn_withdraw', 'execute']
];

it.each(actions)('restores the retained %s action', (proposalType, expected) => {
  const row = recoveredHistoryRecord(
    'account',
    '0x123',
    'testnet',
    'https://one',
    entry,
    delta({ proposalType }),
    summary
  );
  expect(row.type).toBe(expected);
  expect(row.status).toBe(ITransactionStatus.Completed);
  expect(row.recovery?.proposal?.proposalType).toBe(proposalType);
  expect(row.transactionId).toBeUndefined();
  expect(row.requestBytes).toBeUndefined();
  expect(row.queuedSeq).toBeUndefined();
  expect(row.displayMessage).toBeUndefined();
  expect(row.restoredFromBackup).toBe(true);
  expect(row.recovered).toBe(true);
  expect(row.id).toBe('guardian-history:testnet:0x123:final');
});

it('keeps the id safe for a route segment when no commitment is known', () => {
  const unknown: HistoryEntry = { ...entry, newCommitment: '' };
  const row = recoveredHistoryRecord(
    'account',
    '0x123',
    'testnet',
    'https://one.example/g',
    unknown,
    { ...delta(), newCommitment: '' },
    summary
  );
  expect(row.id).toBe('guardian-history:testnet:0x123:nonce-12-https_one_example_g');
  expect(encodeURIComponent(row.id)).toBe(row.id.replace(/:/g, '%3A'));
});

it('builds the concrete transaction class when the Guardian retains its constructor data', () => {
  const send = recoveredHistoryRecord(
    'account',
    '0x123',
    'testnet',
    'one',
    entry,
    delta({ proposalType: 'p2id' }),
    summary
  );
  expect(send).toBeInstanceOf(SendTransaction);
  expect(send.displayIcon).toBe('SEND');
  expect(send.secondaryAccountId).toBe('recipient');
  const switched = recoveredHistoryRecord(
    'account',
    '0x123',
    'testnet',
    'one',
    entry,
    delta({ proposalType: 'switch_guardian', newGuardianEndpoint: 'https://new' }),
    summary
  );
  expect(switched).toBeInstanceOf(SwitchGuardianTransaction);
  expect(switched.extraInputs).toEqual({ previousGuardianEndpoint: 'one', newGuardianEndpoint: 'https://new' });
  const replaced = recoveredHistoryRecord(
    'account',
    '0x123',
    'testnet',
    'one',
    entry,
    delta({ proposalType: 'add_signer', description: 'Replace device (hot) signer' }),
    summary
  );
  expect(replaced).toBeInstanceOf(ReplaceHotKeyTransaction);
  const secured = recoveredHistoryRecord(
    'account',
    '0x123',
    'testnet',
    'one',
    entry,
    delta({ proposalType: 'update_procedure_threshold', targetProcedure: 'update_guardian', targetThreshold: 2 }),
    summary
  );
  expect(secured).toBeInstanceOf(UpdateProcedureThresholdTransaction);
  expect(secured.extraInputs).toEqual({ procedure: 'update_guardian', threshold: 2 });
});

it('falls back to a plain record when constructor data is missing', () => {
  const partial: GuardianSummary = { ...summary, outputNotes: [{ id: 'out', visibility: 'private', assets: [] }] };
  const send = recoveredHistoryRecord(
    'account',
    '0x123',
    'testnet',
    'one',
    entry,
    delta({ proposalType: 'p2id' }),
    partial
  );
  expect(send).not.toBeInstanceOf(SendTransaction);
  expect(send.type).toBe('send');
  expect(send.extraInputs).toBeUndefined();
  const switched = recoveredHistoryRecord(
    'account',
    '0x123',
    'testnet',
    'one',
    entry,
    delta({ proposalType: 'switch_guardian' }),
    summary
  );
  expect(switched).not.toBeInstanceOf(SwitchGuardianTransaction);
  expect(switched.extraInputs).toBeUndefined();
  const swap = recoveredHistoryRecord(
    'account',
    '0x123',
    'testnet',
    'one',
    entry,
    delta({ proposalType: 'swap' }),
    summary
  );
  expect(swap.type).toBe('swap');
  expect(swap.extraInputs).toBeUndefined();
});

it('requires the device replacement marker', () => {
  expect(recoveredAction({ proposalType: 'add_signer', description: 'Replace device (hot) signer' })).toBe(
    'replace-hot-key'
  );
  expect(recoveredAction({ proposalType: 'add_signer', description: 'Add device (hot) signer' })).toBe(
    'replace-hot-key'
  );
  expect(recoveredAction({ proposalType: 'add_signer', description: 'Other signer' })).toBe('execute');
});

// Only the add description reads as an add: every other rotation, and a proposal with no metadata, is a replace.
it('reads the recovered rotation mode from the proposal description', () => {
  expect(recoveredHotKeyMode({ proposalType: 'add_signer', description: 'Add device (hot) signer' })).toBe('add');
  expect(recoveredHotKeyMode({ proposalType: 'add_signer', description: 'Replace device (hot) signer' })).toBe(
    'replace'
  );
  expect(recoveredHotKeyMode({ proposalType: 'add_signer', description: 'add device (hot) signer' })).toBe('replace');
  expect(recoveredHotKeyMode(undefined)).toBe('replace');
});

it('uses top-level metadata before legacy metadata', () => {
  const retained = delta({ proposalType: 'swap' });
  retained.deltaPayload.metadata = { proposalType: 'p2id' };
  expect(recoveredHistoryRecord('account', '0x123', 'testnet', 'one', entry, retained, summary).type).toBe('swap');
  delete retained.metadata;
  expect(recoveredHistoryRecord('account', '0x123', 'testnet', 'one', entry, retained, summary).type).toBe('send');
});

it('keeps decoded amounts, recipients, visibility and fees when metadata conflicts', () => {
  const row = recoveredHistoryRecord(
    'account',
    '0x123',
    'testnet',
    'one',
    entry,
    delta({ proposalType: 'p2id', recipientId: 'wrong', amount: '1', faucetId: 'wrong', noteType: 'public' }),
    summary
  );
  expect(row.amount).toBe(9007199254740993n);
  expect(row.secondaryAccountId).toBe('recipient');
  expect(row.noteType).toBe('private');
  expect(row.feeAmount).toBe(5n);
  expect(row.feeFaucetId).toBe('fee-asset');
});

it('uses metadata for a partial private recipient, without inventing an amount', () => {
  const partial: GuardianSummary = { ...summary, outputNotes: [{ id: 'out', visibility: 'private', assets: [] }] };
  const row = recoveredHistoryRecord(
    'account',
    '0x123',
    'testnet',
    'one',
    entry,
    delta({ proposalType: 'p2id', recipientId: 'private-recipient', amount: '99' }),
    partial
  );
  expect(row.secondaryAccountId).toBe('private-recipient');
  expect(row.amount).toBeUndefined();
});

it('keeps older records when neither metadata nor a summary can be read', () => {
  const older: HistoryEntry = {
    ...entry,
    outputNotes: [{ noteId: 'note', tag: 'custom', noteType: 'private', assets: [] }]
  };
  const row = recoveredHistoryRecord('account', '0x123', 'testnet', 'one', older, delta());
  expect(row.type).toBe('execute');
  expect(row.noteIds).toEqual(['note']);
  expect(row.recovery?.completeness).toBe('partial');
  expect(row.completedAt).toBe(Date.parse(timestamp) / 1000);
});

it('sums batch claims by asset and detects reclaim only when every sender matches', () => {
  const batch: GuardianSummary = {
    accountId: '0x123',
    outputNotes: [],
    inputNotes: [
      { id: 'one', sender: 'account', visibility: 'private', assets: [{ faucetId: 'A', amount: '2' }] },
      {
        id: 'two',
        sender: 'account',
        visibility: 'public',
        assets: [
          { faucetId: 'A', amount: '3' },
          { faucetId: 'B', amount: '7' }
        ]
      }
    ]
  };
  const row = recoveredHistoryRecord(
    'account',
    '0x123',
    'testnet',
    'one',
    entry,
    delta({ proposalType: 'consume_notes' }),
    batch
  );
  expect(row).toBeInstanceOf(ConsumeTransaction);
  expect(row.assetTotals).toEqual([
    { faucetId: 'A', amount: 5n },
    { faucetId: 'B', amount: 7n }
  ]);
  expect(row.amount).toBeUndefined();
  expect(row.noteIds).toEqual(['one', 'two']);
  expect(row.recovery?.reclaimed).toBe(true);
  const first = batch.inputNotes[0];
  if (!first) throw new Error('Missing test note');
  first.sender = 'other';
  expect(
    recoveredHistoryRecord('account', '0x123', 'testnet', 'one', entry, delta({ proposalType: 'consume_notes' }), batch)
      .recovery?.reclaimed
  ).toBe(false);
});

it('rejects mismatched canonical identity and commitments', () => {
  expect(() => recoveredHistoryRecord('account', 'other', 'net', 'one', entry, delta(), summary)).toThrow('identity');
  expect(() =>
    recoveredHistoryRecord('account', '0x123', 'net', 'one', { ...entry, nonce: 9 }, delta(), summary)
  ).toThrow('identity');
  expect(() =>
    recoveredHistoryRecord('account', '0x123', 'net', 'one', entry, { ...delta(), newCommitment: 'different' }, summary)
  ).toThrow('commitments');
  expect(() =>
    recoveredHistoryRecord(
      'account',
      '0x123',
      'net',
      'one',
      entry,
      { ...delta(), status: { status: 'candidate', timestamp } },
      summary
    )
  ).toThrow('canonical');
  expect(() =>
    recoveredHistoryRecord('account', '0x123', 'net', 'one', entry, delta(), { ...summary, accountId: 'other' })
  ).toThrow('another account');
});

it.each([undefined, 42])('files a delta whose account id is %p as an identity mismatch', accountId => {
  const served = { ...delta(), accountId } as unknown as DeltaObject;
  let thrown: unknown;
  try {
    recoveredHistoryRecord('account', '0x123', 'net', 'one', entry, served, summary);
  } catch (error) {
    thrown = error;
  }
  expect(thrown).toBeInstanceOf(GuardianHistoryDataError);
  expect((thrown as Error).message).toBe('Guardian delta identity does not match the history entry');
  expect(recoveredHistoryRecord('account', '0x123', 'net', 'one', entry, delta(), summary).recovery?.nonce).toBe(12);
});

const thrownBy = (served: DeltaObject) => {
  try {
    recoveredHistoryRecord('account', '0x123', 'net', 'one', entry, served, summary);
  } catch (error) {
    return error;
  }
  return undefined;
};

it.each([undefined, null])('files a delta whose status is %p as not canonical', status => {
  const thrown = thrownBy({ ...delta(), status } as unknown as DeltaObject);
  expect(thrown).toBeInstanceOf(GuardianHistoryDataError);
  expect((thrown as Error).message).toBe('Guardian history entry is not canonical');
  expect(recoveredHistoryRecord('account', '0x123', 'net', 'one', entry, delta(), summary).recovery?.nonce).toBe(12);
});

it.each<[unknown]>([[2024], [['2026-08-01T00:00:00Z']]])(
  'files a canonical timestamp of %p as invalid instead of coercing it',
  served => {
    const thrown = thrownBy({
      ...delta(),
      status: { status: 'canonical', timestamp: served }
    } as unknown as DeltaObject);
    expect(thrown).toBeInstanceOf(GuardianHistoryDataError);
    expect((thrown as Error).message).toBe('Invalid Guardian canonical timestamp');
  }
);

it('reads a delta with no payload as one with no payload metadata', () => {
  const served = { ...delta({ proposalType: 'p2id' }), deltaPayload: undefined } as unknown as DeltaObject;
  expect(recoveredHistoryRecord('account', '0x123', 'net', 'one', entry, served, summary).type).toBe('send');
});

it('normalizes operators and accepts only exact nonempty note sets', () => {
  expect(normalizeHistoryOperators(['https://ONE/', 'https://one', 'bad', 'https://two/path/'])).toEqual([
    'https://one',
    'https://two/path'
  ]);
  expect(sameNonemptyNotes([], [])).toBe(false);
  expect(sameNonemptyNotes(['a'], ['a', 'b'])).toBe(false);
  expect(sameNonemptyNotes(['a', 'b'], ['b', 'a'])).toBe(true);
});

it('folds a renamed built-in host into the first spelling seen', () => {
  expect(
    normalizeHistoryOperators(['https://guardian.openzeppelin.com', 'https://guardian-testnet.openzeppelin.com'])
  ).toEqual(['https://guardian.openzeppelin.com']);
  expect(
    normalizeHistoryOperators(['https://guardian-devnet.openzeppelin.com', 'https://guardian-stg.openzeppelin.com'])
  ).toEqual(['https://guardian-devnet.openzeppelin.com']);
});

it('keeps plain http operators only on the local hosts Guardian Settings accepts', () => {
  expect(
    normalizeHistoryOperators([
      'http://plain.example',
      'http://localhost:3001/',
      'http://127.0.0.1:4000',
      'https://one'
    ])
  ).toEqual(['http://localhost:3001', 'http://127.0.0.1:4000', 'https://one']);
});

function recoveredSwapPair() {
  const swap = recoveredHistoryRecord('account', '0x123', 'testnet', 'one', entry, delta({ proposalType: 'swap' }), {
    ...summary,
    outputNotes: [
      {
        id: 'order',
        visibility: 'public',
        assets: [{ faucetId: 'miden', amount: '70' }],
        swap: { orderId: '42', requestedAsset: { faucetId: 'ieth', amount: '30' } }
      }
    ]
  });
  const consume = recoveredHistoryRecord(
    'account',
    '0x123',
    'testnet',
    'one',
    entry,
    delta({ proposalType: 'consume_notes' }),
    {
      ...summary,
      outputNotes: [],
      inputNotes: [
        {
          id: 'payback',
          visibility: 'public',
          recipient: 'account',
          assets: [{ faucetId: 'ieth', amount: '30' }],
          swap: { orderId: '42' }
        }
      ]
    }
  );
  consume.id = 'consume';
  return { swap, consume };
}

// Whether a recovered order is closed is its lineage's to say on the node: a payout claimed from a partial fill leaves
// the remainder open, so a linked consume never stamps the order (#1487).
it('links a recovered receive to its swap by order ID, and stamps no close on the order', () => {
  const { swap, consume } = recoveredSwapPair();
  expect(reconcileRecoveredSwaps([consume, swap])).toEqual([consume]);
  expect(swap.faucetId).toBe('miden');
  expect(swap.extraInputs).toMatchObject({ requestedFaucetId: 'ieth', requestedAmount: 30n, autoConsume: false });
  expect(consume.extraInputs).toMatchObject({ swapOrderTxId: swap.id, swapSettleKind: 'settle' });
  expect(swap.extraInputs.settledAt).toBeUndefined();
  expect(reconcileRecoveredSwaps([consume, swap])).toEqual([]);
});

it('returns a later receipt for a linked order, not the earlier receipt', () => {
  const { swap, consume } = recoveredSwapPair();
  reconcileRecoveredSwaps([consume, swap]);
  const later = { ...consume, id: 'later-consume', completedAt: (consume.completedAt ?? 0) + 60, extraInputs: {} };
  const changed = reconcileRecoveredSwaps([consume, swap, later]);
  expect(changed.map(row => row.id)).toEqual([later.id]);
  expect(swap.extraInputs.settledAt).toBeUndefined();
});

it('still stamps a local order a recovered receive settles, as a live order is settled', () => {
  const { swap, consume } = recoveredSwapPair();
  const local = { ...swap, recovered: undefined, restoredFromBackup: undefined };
  expect(reconcileRecoveredSwaps([consume, local])).toHaveLength(2);
  expect(local.extraInputs.settledAt).toBe(consume.completedAt ?? consume.initiatedAt);
});

it('keeps a recovered order a 10 of 30 payout settled open at its remainder, and closes it once the walk ends', async () => {
  const { swap, consume } = recoveredSwapPair();
  if (!consume.recovery) throw new Error('Missing recovery data');
  const payout = consume.recovery.inputNotes[0];
  if (!payout) throw new Error('Missing payout note');
  consume.recovery.inputNotes = [{ ...payout, assets: [{ faucetId: 'ieth', amount: '10' }] }];
  consume.completedAt = 1_785_000_000;
  await Repo.transactions.clear();

  for (const row of reconcileRecoveredSwaps([consume, swap])) await Repo.transactions.put(row);
  await Repo.transactions.put(swap);
  expect(consume.extraInputs).toMatchObject({ swapOrderTxId: swap.id, swapSettleKind: 'settle' });
  const order = recoveredSwapOrderRef(swap);
  if (!order) throw new Error('The linked payout closed the recovered order');

  // 70 for 30 filled 10 pays 23, leaving 47 for 20 on the node.
  mockReadPswapOrderLineage.mockResolvedValueOnce({
    kind: 'open',
    noteId: 'remainder-1',
    depth: 1,
    offeredAmount: 47n,
    requestedAmount: 20n
  });
  await trackRecoveredSwapOrders([order]);
  const open = await Repo.transactions.get(swap.id);
  expect(open?.extraInputs?.settledAt).toBeUndefined();
  const tip = open && recoveredSwapOrderRef(open);
  expect(tip).toEqual(expect.objectContaining({ tipNoteId: 'remainder-1', tipDepth: 1, tipOfferedAmount: 47n }));
  if (!tip) throw new Error('The open recovered order lost its tracking');

  mockReadPswapOrderLineage.mockResolvedValueOnce({ kind: 'finished' });
  await trackRecoveredSwapOrders([tip]);
  expect((await Repo.transactions.get(swap.id))?.extraInputs?.settledAt).toBe(consume.completedAt);
});

it('leaves a local receipt that only gained recovery data alone', () => {
  const { swap, consume } = recoveredSwapPair();
  const local = {
    ...consume,
    id: 'local-consume',
    recovered: undefined,
    restoredFromBackup: undefined,
    extraInputs: { swapOrderTxId: 'local-order' }
  };
  expect(reconcileRecoveredSwaps([local, swap])).toEqual([]);
  expect(local.extraInputs).toEqual({ swapOrderTxId: 'local-order' });
  expect(swap.extraInputs.settledAt).toBeUndefined();
});

it('keeps mixed batches and unrelated assets visible', () => {
  const { swap, consume } = recoveredSwapPair();
  if (!consume.recovery) throw new Error('Missing recovery data');
  const note = consume.recovery.inputNotes[0];
  if (!note) throw new Error('Missing input note');
  consume.recovery.inputNotes.push({ ...note, id: 'unrelated', swap: undefined });
  expect(reconcileRecoveredSwaps([consume, swap])).toEqual([]);
  consume.recovery.inputNotes = [{ ...note, assets: [{ faucetId: 'other', amount: '30' }] }];
  expect(reconcileRecoveredSwaps([consume, swap])).toEqual([]);
});

it('does not link across accounts or networks or ambiguous orders', () => {
  const { swap, consume } = recoveredSwapPair();
  expect(reconcileRecoveredSwaps([consume, { ...swap, accountId: 'other' }])).toEqual([]);
  if (!swap.recovery) throw new Error('Missing recovery data');
  expect(
    reconcileRecoveredSwaps([
      consume,
      {
        ...swap,
        recovery: { ...swap.recovery, network: 'other' }
      }
    ])
  ).toEqual([]);
  expect(reconcileRecoveredSwaps([consume, swap, { ...swap, id: 'duplicate-order' }])).toEqual([]);
});

it('links a reclaimed PSWAP remainder without treating it as a fill, and leaves its close to the lineage', () => {
  const { swap, consume } = recoveredSwapPair();
  if (!consume.recovery) throw new Error('Missing recovery data');
  consume.recovery.inputNotes = swap.recovery?.outputNotes ?? [];
  reconcileRecoveredSwaps([consume, swap]);
  expect(consume.extraInputs.swapSettleKind).toBe('reclaim');
  expect(swap.extraInputs.reclaimedAt).toBeUndefined();
  expect(swap.extraInputs.settledAt).toBeUndefined();
});

function recoveredReclaim(proposalType: string, inputNotes: GuardianHistoryNote[]) {
  const row = recoveredHistoryRecord('account', '0x123', 'testnet', 'one', entry, delta({ proposalType }), {
    ...summary,
    outputNotes: [],
    inputNotes
  });
  row.id = 'reclaim';
  return row;
}

function orderNote(swap: ITransaction): GuardianHistoryNote {
  const note = swap.recovery?.outputNotes[0];
  if (!note) throw new Error('Missing order note');
  return note;
}

it.each(['custom_transaction', 'consume_notes'])(
  'stores a recovered %s reclaim of an own PSWAP order as its reclaim consume, linked across a reload',
  proposalType => {
    const { swap } = recoveredSwapPair();
    const reclaim = recoveredReclaim(proposalType, [{ ...orderNote(swap), sender: 'account' }]);
    const stored = new Map<string, ITransaction>();
    const put = (row: ITransaction) => stored.set(row.id, deserialize(serialize(row)));
    const load = () => [...stored.values()].map((row): ITransaction => deserialize(serialize(row)));
    put(swap);
    put(reclaim);
    for (const row of reconcileRecoveredSwaps(load())) put(row);

    const reloaded = load();
    expect(reloaded.find(row => row.id === 'reclaim')).toMatchObject({
      type: 'consume',
      amount: 70n,
      faucetId: 'miden',
      noteId: 'order',
      noteIds: ['order'],
      inputNoteIds: ['order'],
      extraInputs: { swapOrderTxId: swap.id, swapSettleKind: 'reclaim' },
      recovery: { reclaimed: true }
    });
    const order = reloaded.find(row => row.id === swap.id);
    expect(order?.extraInputs.reclaimedAt).toBeUndefined();
    expect(order?.extraInputs.settledAt).toBeUndefined();
    expect(reconcileRecoveredSwaps(reloaded)).toEqual([]);
  }
);

it.each([
  [
    'an own order note beside an unrelated note',
    (note: GuardianHistoryNote) => [
      { ...note, sender: 'account' },
      { ...note, id: 'unrelated', sender: 'account', swap: undefined }
    ]
  ],
  ["another account's order note", (note: GuardianHistoryNote) => [{ ...note, sender: 'maker' }]]
])('keeps a recovered custom transaction an execute when it consumes %s', (_label, inputNotes) => {
  const { swap } = recoveredSwapPair();
  const row = recoveredReclaim('custom_transaction', inputNotes(orderNote(swap)));
  expect(row.type).toBe('execute');
  expect(reconcileRecoveredSwaps([row, swap])).toEqual([]);
  expect(swap.extraInputs.reclaimedAt).toBeUndefined();
});

it('keeps a recovered custom transaction an execute with its output when it also creates a note', () => {
  const { swap } = recoveredSwapPair();
  // `summary` carries one user output note: this transaction did more than take the order back.
  const row = recoveredHistoryRecord(
    'account',
    '0x123',
    'testnet',
    'one',
    entry,
    delta({ proposalType: 'custom_transaction' }),
    { ...summary, inputNotes: [{ ...orderNote(swap), sender: 'account' }] }
  );
  expect(row).toMatchObject({
    type: 'execute',
    amount: 9007199254740993n,
    faucetId: 'asset',
    noteId: 'out',
    noteIds: ['out']
  });
  expect(reconcileRecoveredSwaps([row, swap])).toEqual([]);
  expect(swap.extraInputs.reclaimedAt).toBeUndefined();
});

it.each([
  { proposalType: 'add_signer', description: 'Replace device (hot) signer' },
  { proposalType: 'add_signer', description: 'Add device (hot) signer' },
  { proposalType: 'switch_guardian', newGuardianEndpoint: 'https://next' },
  { proposalType: 'update_procedure_threshold', targetProcedure: 'send', targetThreshold: 2 }
])('keeps account-management fees separate from transfer amounts: %s', proposal => {
  const row = recoveredHistoryRecord('account', '0x123', 'testnet', 'one', entry, delta(proposal), summary);
  expect(row.amount).toBeUndefined();
  expect(row.faucetId).toBeUndefined();
  expect(row.assetTotals).toEqual([]);
  expect(row.feeAmount).toBe(5n);
});

it('labels a recovered device-key rotation', () => {
  const proposal = { proposalType: 'add_signer', description: 'Replace device (hot) signer' };
  const row = recoveredHistoryRecord('account', '0x123', 'testnet', 'one', entry, delta(proposal), summary);
  expect(row.displayMessage).toBe('Device key rotated');
  expect(row.extraInputs.mode).toBe('replace');
});

it('labels a recovered device addition', () => {
  const proposal = { proposalType: 'add_signer', description: 'Add device (hot) signer' };
  const row = recoveredHistoryRecord('account', '0x123', 'testnet', 'one', entry, delta(proposal), summary);
  expect(row.type).toBe('replace-hot-key');
  expect(row.displayMessage).toBe('Device added');
  expect(row.extraInputs.mode).toBe('add');
});

it('recovers a Guardian endpoint from matching payload metadata', () => {
  const retained = delta({ proposalType: 'switch_guardian' });
  retained.deltaPayload.metadata = { proposalType: 'switch_guardian', newGuardianEndpoint: 'https://new' };
  const row = recoveredHistoryRecord('account', '0x123', 'testnet', 'https://old', entry, retained, summary);
  expect(row).toBeInstanceOf(SwitchGuardianTransaction);
  expect(row.extraInputs).toEqual({
    previousGuardianEndpoint: 'https://old',
    newGuardianEndpoint: 'https://new'
  });
});

it('keeps a Guardian switch partial when its destination is missing', () => {
  const row = recoveredHistoryRecord(
    'account',
    '0x123',
    'testnet',
    'https://old',
    entry,
    delta({ proposalType: 'switch_guardian' }),
    summary
  );
  expect(row.recovery?.completeness).toBe('partial');
});

it('gives a commitment-less row the same id from either spelling of a renamed host', () => {
  const unknown: HistoryEntry = { ...entry, newCommitment: '' };
  const idFrom = (operator: string) =>
    recoveredHistoryRecord('account', '0x123', 'testnet', operator, unknown, { ...delta(), newCommitment: '' }, summary)
      .id;
  const oldId = idFrom('https://guardian.openzeppelin.com');
  expect(oldId).toBe('guardian-history:testnet:0x123:nonce-12-https_guardian_openzeppelin_com');
  expect(idFrom('https://guardian-testnet.openzeppelin.com')).toBe(oldId);
  expect(historyCheckpointId('testnet', '0x123', 'https://guardian-testnet.openzeppelin.com')).toBe(
    historyCheckpointId('testnet', '0x123', 'https://guardian.openzeppelin.com')
  );
});
