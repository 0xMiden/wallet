import { CLAIM_STARTED_ELSEWHERE_WINDOW_MS as PRODUCT_WINDOW_MS } from 'lib/miden/guardian/claims-elsewhere';

import {
  CLAIM_STARTED_ELSEWHERE_WINDOW_MS,
  claimRowStatus,
  claimRowsNaming,
  claimWindowOf,
  completedClaimsPerNote,
  expectedBalanceAfterClaims,
  feesOf,
  isLiveStatus,
  isProposalListRead,
  isProposalPost,
  namesNote,
  noteKey,
  parseProposalList,
  parseProposalPostAnswer,
  parseProposalPostBody,
  passedProposal,
  pendingClaimsNaming,
  sameNoteId,
  toJsonText,
  unexplainedFailedClaims,
  waitForNoPendingCard,
  windowPosition,
  type ClaimRow
} from './multi-device-claims';

const NOTE_A = '0x' + 'ab'.repeat(32);
const NOTE_B = '0x' + 'cd'.repeat(32);
const GUARDIAN = 'https://guardian-testnet.openzeppelin.com';

function row(overrides: Partial<ClaimRow>): ClaimRow {
  return {
    id: 'row-1',
    type: 'consume',
    status: 'Completed',
    stage: null,
    stageStamps: {},
    noteIds: [NOTE_A],
    amount: '100',
    faucetId: 'mtst1faucet',
    error: null,
    rawError: null,
    feeAmount: null,
    feeFaucetId: null,
    entryPoint: 'claim',
    claimedElsewhereCheckUntil: null,
    guardianBusy: false,
    nextEligibleAt: null,
    mayHaveSubmitted: false,
    restoredFromBackup: false,
    recovered: false,
    initiatedAt: 1_000,
    completedAt: 1_010,
    ...overrides
  };
}

describe('multi-device claims helpers', () => {
  it('copies the claim window of the product', () => {
    expect(CLAIM_STARTED_ELSEWHERE_WINDOW_MS).toBe(PRODUCT_WINDOW_MS);
  });

  describe('note ids', () => {
    it('compares ids with and without 0x and in any case', () => {
      expect(noteKey(` ${NOTE_A.toUpperCase().replace('0X', '0x')} `)).toBe('ab'.repeat(32));
      expect(sameNoteId(NOTE_A, 'AB'.repeat(32))).toBe(true);
      expect(sameNoteId(NOTE_A, NOTE_B)).toBe(false);
      expect(namesNote([NOTE_B, NOTE_A.slice(2)], NOTE_A)).toBe(true);
      expect(namesNote([NOTE_B], NOTE_A)).toBe(false);
    });
  });

  describe('rows', () => {
    it('names each ITransactionStatus code', () => {
      expect([0, 1, 2, 3, 4, 9].map(claimRowStatus)).toEqual([
        'Queued',
        'GeneratingTransaction',
        'Completed',
        'Failed',
        'Unconfirmed',
        'Unknown'
      ]);
      expect(isLiveStatus('Queued')).toBe(true);
      expect(isLiveStatus('GeneratingTransaction')).toBe(true);
      expect(isLiveStatus('Unconfirmed')).toBe(true);
      expect(isLiveStatus('Completed')).toBe(false);
      expect(isLiveStatus('Failed')).toBe(false);
      expect(isLiveStatus('Unknown')).toBe(true);
    });

    it('keeps only the consume rows of this device that name the note', () => {
      const rows = [
        row({ id: 'own' }),
        row({ id: 'restored', restoredFromBackup: true }),
        row({ id: 'recovered', recovered: true }),
        row({ id: 'send', type: 'send' }),
        row({ id: 'other-note', noteIds: [NOTE_B] })
      ];
      expect(claimRowsNaming(rows, NOTE_A).map(item => item.id)).toEqual(['own']);
    });

    it('sees a proposal on the Guardian only from a stage after it, a stamp of one, or a landed status', () => {
      expect(passedProposal(row({ status: 'GeneratingTransaction', stage: 'creating-proposal' }))).toBe(false);
      expect(passedProposal(row({ status: 'Queued', stage: 'creating-proposal', stageStamps: {} }))).toBe(false);
      expect(passedProposal(row({ status: 'GeneratingTransaction', stage: 'signing-proposal' }))).toBe(true);
      expect(
        passedProposal(
          row({ status: 'GeneratingTransaction', stage: 'creating-proposal', stageStamps: { proving: 5 } })
        )
      ).toBe(true);
      expect(passedProposal(row({ status: 'Unconfirmed' }))).toBe(true);
      expect(passedProposal(row({ status: 'Failed', stage: 'creating-proposal' }))).toBe(false);
    });

    it('counts the Completed claims of each note over every device', () => {
      const deviceA = [row({ id: 'a1', noteIds: [NOTE_A, NOTE_B] }), row({ id: 'a2', status: 'Failed' })];
      const deviceB = [row({ id: 'b1', noteIds: [NOTE_B] }), row({ id: 'b2', restoredFromBackup: true })];
      expect(completedClaimsPerNote([deviceA, deviceB], [NOTE_A, NOTE_B])).toEqual({ [NOTE_A]: 1, [NOTE_B]: 2 });
    });

    it('explains a Failed claim only when another device completed every note it names', () => {
      const failed = row({ id: 'lost', status: 'Failed', noteIds: [NOTE_A, NOTE_B] });
      const coversBoth = [row({ id: 'won', noteIds: [NOTE_A, NOTE_B] })];
      const coversOne = [row({ id: 'won', noteIds: [NOTE_A] })];
      expect(unexplainedFailedClaims([failed], [coversBoth])).toEqual([]);
      expect(unexplainedFailedClaims([failed], [coversOne]).map(item => item.id)).toEqual(['lost']);
      expect(unexplainedFailedClaims([failed], [[row({ id: 'restored', restoredFromBackup: true })]])).toHaveLength(1);
    });

    it('never explains a Failed claim that names no note', () => {
      const nameless = row({ id: 'nameless', status: 'Failed', noteIds: [] });
      const other = [row({ id: 'won', noteIds: [NOTE_A, NOTE_B] })];
      expect(unexplainedFailedClaims([nameless], [other]).map(item => item.id)).toEqual(['nameless']);
    });
  });

  describe('money', () => {
    it('adds the credits and takes the fees off the baseline', () => {
      expect(expectedBalanceAfterClaims(1_000n, [500n, 500n], [30n, 20n])).toBe(1_950n);
      expect(expectedBalanceAfterClaims(7n, [], [])).toBe(7n);
    });

    it('sums only the fees recorded in the fee faucet and lists the other rows', () => {
      const rows = [
        row({ id: 'paid', feeAmount: '25', feeFaucetId: 'native' }),
        row({ id: 'none' }),
        row({ id: 'other-faucet', feeAmount: '9', feeFaucetId: 'other' }),
        row({ id: 'not-a-number', feeAmount: 'x', feeFaucetId: 'native' })
      ];
      const { fees, withoutFee } = feesOf(rows, 'native');
      expect(fees).toEqual([25n]);
      expect(withoutFee.map(item => item.id)).toEqual(['none', 'other-faucet', 'not-a-number']);
    });

    it('writes bigints as decimal strings', () => {
      expect(JSON.parse(toJsonText({ amount: 12n }))).toEqual({ amount: '12' });
    });
  });

  describe('the claim window', () => {
    const proposing = row({
      status: 'GeneratingTransaction',
      stage: 'signing-proposal',
      stageStamps: { 'creating-proposal': 10_000, 'signing-proposal': 14_000 }
    });

    it('ends between the proposal stamps plus the window', () => {
      expect(claimWindowOf(proposing)).toEqual({ endLow: 130_000, endHigh: 134_000 });
      expect(() => claimWindowOf(row({ stageStamps: { 'creating-proposal': 1 } }))).toThrow(/no creating-proposal/);
    });

    it('places an interval inside, outside or at the edge of the window', () => {
      const window = claimWindowOf(proposing);
      expect(windowPosition({ from: 20_000, to: 110_000 }, window, 15_000)).toBe('inside');
      expect(windowPosition({ from: 150_000, to: 160_000 }, window, 15_000)).toBe('outside');
      expect(windowPosition({ from: 100_000, to: 120_000 }, window, 15_000)).toBe('edge');
      expect(windowPosition({ from: 140_000, to: 160_000 }, window, 15_000)).toBe('edge');
    });
  });

  describe('Guardian proposal traffic', () => {
    it('tells the gate read and a new proposal from the other proposal requests', () => {
      expect(isProposalListRead('GET', `${GUARDIAN}/delta/proposal?account_id=0x12`)).toBe(true);
      expect(isProposalListRead('GET', `${GUARDIAN}/delta/proposal/single?account_id=0x12&commitment=0x1`)).toBe(false);
      expect(isProposalListRead('GET', `${GUARDIAN}/delta/proposal/execution?account_id=0x12`)).toBe(false);
      expect(isProposalListRead('POST', `${GUARDIAN}/delta/proposal`)).toBe(false);
      expect(isProposalListRead('GET', 'not a url')).toBe(false);
      expect(isProposalPost('POST', `${GUARDIAN}/delta/proposal`)).toBe(true);
      expect(isProposalPost('PUT', `${GUARDIAN}/delta/proposal`)).toBe(false);
      expect(isProposalPost('POST', `${GUARDIAN}/delta/proposal/execution`)).toBe(false);
    });

    it('reads the type and notes of a new proposal and the timestamp of its answer', () => {
      const body = JSON.stringify({
        account_id: '0x12',
        nonce: 3,
        delta_payload: {
          tx_summary: {},
          signatures: [],
          metadata: { proposal_type: 'consume_notes', note_ids: [NOTE_A] }
        }
      });
      expect(parseProposalPostBody(body)).toEqual({ proposalType: 'consume_notes', noteIds: [NOTE_A] });
      expect(parseProposalPostBody(null)).toEqual({ proposalType: null, noteIds: [] });
      expect(parseProposalPostBody('{')).toEqual({ proposalType: null, noteIds: [] });
      const answer = JSON.stringify({
        delta: {
          status: { status: 'pending', timestamp: '2026-11-25T10:00:00Z', proposer_id: '0xaa', cosigner_sigs: [] }
        },
        commitment: '0x1'
      });
      expect(parseProposalPostAnswer(answer)).toBe(Date.parse('2026-11-25T10:00:00Z'));
      expect(parseProposalPostAnswer(JSON.stringify({ delta: {} }))).toBeNull();
    });

    it('lists only the pending proposals, with metadata from the payload or the outer proposal', () => {
      const list = JSON.stringify({
        proposals: [
          {
            delta_payload: { metadata: { proposal_type: 'consume_notes', note_ids: [NOTE_A] } },
            status: { status: 'pending', timestamp: '2026-11-25T10:00:00Z', proposer_id: '0xaa', cosigner_sigs: [] }
          },
          {
            delta_payload: { tx_summary: {} },
            metadata: { proposal: { proposal_type: 'p2id', note_ids: [NOTE_B] } },
            status: { status: 'pending', timestamp: 'not a time', proposer_id: '0xbb', cosigner_sigs: [] }
          },
          { delta_payload: {}, status: { status: 'candidate', timestamp: '2026-11-25T10:00:00Z' } },
          'not a proposal'
        ]
      });
      const views = parseProposalList(list);
      expect(views).toEqual([
        {
          proposerId: '0xaa',
          proposedAtMs: Date.parse('2026-11-25T10:00:00Z'),
          proposalType: 'consume_notes',
          noteIds: [NOTE_A]
        },
        { proposerId: '0xbb', proposedAtMs: null, proposalType: 'p2id', noteIds: [NOTE_B] }
      ]);
      expect(pendingClaimsNaming(views, NOTE_A)).toHaveLength(1);
      expect(pendingClaimsNaming(views, NOTE_B)).toHaveLength(0);
      expect(parseProposalList('{"proposals":7}')).toEqual([]);
      expect(parseProposalList(null)).toEqual([]);
    });
  });
});

describe('waitForNoPendingCard', () => {
  const PENDING_URL = 'chrome-extension://id/fullpage.html#/history?filter=pending';
  const card = { entryKey: NOTE_A, status: 'pending', acceptEnabled: true };

  const walletWith = (evaluate: jest.Mock, loadingBars: jest.Mock): Parameters<typeof waitForNoPendingCard>[0] =>
    ({
      page: {
        url: () => PENDING_URL,
        evaluate,
        locator: () => ({ count: loadingBars }),
        waitForTimeout: () => Promise.resolve()
      }
    }) as unknown as Parameters<typeof waitForNoPendingCard>[0];

  it('does not take a failed read for a card that is gone', async () => {
    const evaluate = jest
      .fn()
      .mockRejectedValueOnce(new Error('Execution context was destroyed'))
      .mockResolvedValueOnce(card)
      .mockResolvedValueOnce(null);
    await waitForNoPendingCard(walletWith(evaluate, jest.fn().mockResolvedValue(0)), NOTE_A, 60_000);
    expect(evaluate).toHaveBeenCalledTimes(3);
  });

  it('does not take a card missing from a list that still fetches for a card that is gone', async () => {
    const evaluate = jest.fn().mockResolvedValueOnce(null).mockResolvedValueOnce(card).mockResolvedValueOnce(null);
    const loadingBars = jest.fn().mockResolvedValueOnce(1).mockResolvedValue(0);
    await waitForNoPendingCard(walletWith(evaluate, loadingBars), NOTE_A, 60_000);
    expect(evaluate).toHaveBeenCalledTimes(3);
  });
});
