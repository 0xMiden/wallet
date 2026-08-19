import type { DeltaObject, ProposalMetadata } from '@openzeppelin/guardian-client';

import { ITransactionStatus, type ITransactionType } from 'lib/miden/db/types';
import { NoteTypeEnum } from 'lib/miden/types';

import { type GuardianSummaryDetails, mapGuardianDeltaToTransaction } from './guardian-recovery';

const accountId = 'mtst1guardian';

function makeDelta(metadata: ProposalMetadata, timestamp = '2026-08-19T10:00:00.000Z'): DeltaObject {
  return {
    accountId,
    nonce: 7,
    prevCommitment: '0xprev',
    newCommitment: '0xnext',
    deltaPayload: {
      txSummary: { data: '' },
      signatures: [],
      metadata
    },
    status: { status: 'canonical', timestamp }
  };
}

const sendSummary: GuardianSummaryDetails = {
  inputNotes: [],
  outputNotes: [
    {
      noteId: '0xoutput',
      noteType: NoteTypeEnum.Private,
      assets: [{ faucetId: '0xsummary-faucet', amount: 25n }]
    }
  ]
};

describe('mapGuardianDeltaToTransaction', () => {
  it('reconstructs a complete P2ID row from authenticated Guardian metadata', () => {
    const row = mapGuardianDeltaToTransaction(
      accountId,
      makeDelta({
        proposalType: 'p2id',
        recipientId: 'mtst1recipient',
        faucetId: '0xmetadata-faucet',
        amount: '42',
        noteType: 'private'
      }),
      sendSummary
    );

    expect(row).toMatchObject({
      id: `guardian-recovery:${accountId}:7`,
      accountId,
      type: 'send',
      status: ITransactionStatus.Completed,
      initiatedAt: 1787133600,
      completedAt: 1787133600,
      secondaryAccountId: 'mtst1recipient',
      faucetId: '0xmetadata-faucet',
      amount: 42n,
      noteType: NoteTypeEnum.Private,
      outputNoteIds: ['0xoutput'],
      recovery: { source: 'guardian-delta', guardianNonce: 7, detail: 'complete' }
    });
  });

  it('reconstructs a consume row and totals matching input assets', () => {
    const summary: GuardianSummaryDetails = {
      inputNotes: [
        {
          noteId: '0xinput-a',
          senderAccountId: 'mtst1sender',
          noteType: NoteTypeEnum.Public,
          assets: [{ faucetId: '0xfaucet', amount: 10n }]
        },
        {
          noteId: '0xinput-b',
          senderAccountId: 'mtst1sender',
          noteType: NoteTypeEnum.Public,
          assets: [
            { faucetId: '0xfaucet', amount: 15n },
            { faucetId: '0xother', amount: 99n }
          ]
        }
      ],
      outputNotes: []
    };

    const row = mapGuardianDeltaToTransaction(accountId, makeDelta({ proposalType: 'consume_notes' }), summary);

    expect(row).toMatchObject({
      type: 'consume',
      noteId: '0xinput-a',
      noteIds: ['0xinput-a', '0xinput-b'],
      inputNoteIds: ['0xinput-a', '0xinput-b'],
      secondaryAccountId: 'mtst1sender',
      faucetId: '0xfaucet',
      amount: 25n,
      recovery: { detail: 'complete' }
    });
  });

  const partialCustomRows: Array<{
    proposalType: string;
    transactionType: ITransactionType;
    message: string;
  }> = [
    { proposalType: 'recallable_send', transactionType: 'send', message: 'Sent' },
    { proposalType: 'bridged_send', transactionType: 'bridged-send', message: 'Bridged to EVM' },
    { proposalType: 'agglayer_bridged_send', transactionType: 'bridged-send', message: 'Bridged to EVM' },
    { proposalType: 'earn_deposit', transactionType: 'earn-deposit', message: 'Deposited to lending' },
    { proposalType: 'swap', transactionType: 'swap', message: 'Swapped' },
    { proposalType: 'custom_transaction', transactionType: 'execute', message: 'Executed' }
  ];

  test.each(partialCustomRows)('keeps $proposalType visible with partial details', rowType => {
    const row = mapGuardianDeltaToTransaction(
      accountId,
      makeDelta({ proposalType: rowType.proposalType }),
      sendSummary
    );

    expect(row.type).toBe(rowType.transactionType);
    expect(row.displayMessage).toBe(rowType.message);
    expect(row.recovery?.detail).toBe('partial');
  });

  it('marks an otherwise complete row partial when Guardian has no usable timestamp', () => {
    const row = mapGuardianDeltaToTransaction(
      accountId,
      makeDelta(
        {
          proposalType: 'p2id',
          recipientId: 'mtst1recipient',
          faucetId: '0xfaucet',
          amount: '1'
        },
        'not-a-date'
      ),
      sendSummary
    );

    expect(row.initiatedAt).toBe(0);
    expect(row.completedAt).toBe(0);
    expect(row.recovery?.detail).toBe('partial');
  });
});
