import type { DeltaObject, HistoryEntry, ProposalMetadata } from '@openzeppelin/guardian-client';

import { normalizeHistoryOperators, recoveredAction, recoveredHistoryRecord, sameNonemptyNotes } from './history';
import type { ITransactionType } from '../db/types';
import {
  ConsumeTransaction,
  ITransactionStatus,
  ReplaceHotKeyTransaction,
  SendTransaction,
  SwitchGuardianTransaction,
  UpdateProcedureThresholdTransaction
} from '../db/types';
import type { GuardianSummary } from '../sdk/guardian-history';

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
  expect(recoveredAction({ proposalType: 'add_signer', description: 'Other signer' })).toBe('execute');
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

it('normalizes operators and accepts only exact nonempty note sets', () => {
  expect(normalizeHistoryOperators(['https://ONE/', 'https://one', 'bad', 'https://two/path/'])).toEqual([
    'https://one',
    'https://two/path'
  ]);
  expect(sameNonemptyNotes([], [])).toBe(false);
  expect(sameNonemptyNotes(['a'], ['a', 'b'])).toBe(false);
  expect(sameNonemptyNotes(['a', 'b'], ['b', 'a'])).toBe(true);
});
