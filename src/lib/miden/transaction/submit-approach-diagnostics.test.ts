import { __resetBackgroundTimeForTest, initBackgroundTimeTracking } from 'lib/mobile/background-time';
import { installHiddenDocument, type HiddenDocument } from 'lib/mobile/testing/hidden-document';
import { isMobile } from 'lib/platform';

import { proofWindowBucket, submitApproach, submitApproachHiddenBucket } from './submit-approach-diagnostics';
import { ITransactionStatus, type ISubmitEvidence, type ITransaction } from '../db/types';

jest.mock('lib/platform', () => ({ ...jest.requireActual('lib/platform'), isMobile: jest.fn(() => true) }));

const PROPOSAL_AT = 1_800_000_000_000;
const SUBMIT_AT = PROPOSAL_AT + 10_000;

const entry = (overrides: Partial<ISubmitEvidence> = {}): ISubmitEvidence => ({
  attemptId: 'a1',
  capturedAt: 0,
  source: 'stage',
  refBlock: 1_000,
  expirationBlock: 1_020,
  ...overrides
});

const row = (overrides: Partial<ITransaction> = {}): ITransaction => ({
  id: 'tx-1',
  type: 'send',
  accountId: 'account',
  status: ITransactionStatus.Failed,
  initiatedAt: 0,
  displayIcon: 'SEND',
  attemptId: 'a1',
  stageTimestamps: { 'creating-proposal': PROPOSAL_AT, submitting: SUBMIT_AT },
  submitEvidence: [entry()],
  ...overrides
});

describe('submitApproachHiddenBucket', () => {
  let doc: HiddenDocument;
  let clock: jest.SpyInstance;

  const hide = (fromMs: number, toMs: number) => {
    clock.mockReturnValue(fromMs);
    doc.setHidden(true);
    clock.mockReturnValue(toMs);
    doc.setHidden(false);
  };

  beforeEach(() => {
    jest.mocked(isMobile).mockReturnValue(true);
    __resetBackgroundTimeForTest();
    doc = installHiddenDocument();
    clock = jest.spyOn(Date, 'now').mockReturnValue(PROPOSAL_AT - 1_000);
    initBackgroundTimeTracking();
  });

  afterEach(() => {
    clock.mockRestore();
    doc.restore();
    __resetBackgroundTimeForTest();
  });

  it.each([
    [0, 'none'],
    [4_999, 'under_half'],
    [5_000, 'half_or_more'],
    [10_000, 'half_or_more']
  ])('reads %s ms hidden of a 10 s approach as %s', (hiddenMs, bucket) => {
    if (hiddenMs > 0) hide(PROPOSAL_AT, PROPOSAL_AT + hiddenMs);
    expect(submitApproachHiddenBucket(row())).toBe(bucket);
  });

  it('counts neither what came before the proposal nor what came after the submit stamp', () => {
    hide(PROPOSAL_AT - 900, PROPOSAL_AT - 100);
    hide(SUBMIT_AT + 100, SUBMIT_AT + 60_000);
    expect(submitApproachHiddenBucket(row())).toBe('none');
  });

  it('opens at local signing on a row with no proposal stamp, and at the proposal when a row has both', () => {
    hide(PROPOSAL_AT + 1_000, PROPOSAL_AT + 4_000);
    const direct = (stamps: ITransaction['stageTimestamps']) => row({ stageTimestamps: stamps });
    expect(submitApproachHiddenBucket(direct({ 'signing-locally': PROPOSAL_AT + 1_000, submitting: SUBMIT_AT }))).toBe(
      'under_half'
    );
    expect(submitApproachHiddenBucket(direct({ 'signing-locally': PROPOSAL_AT + 6_000, submitting: SUBMIT_AT }))).toBe(
      'none'
    );
    expect(
      submitApproachHiddenBucket(
        direct({
          'creating-proposal': PROPOSAL_AT,
          'signing-locally': PROPOSAL_AT + 6_000,
          submitting: SUBMIT_AT
        })
      )
    ).toBe('under_half');
  });

  it('is not measured off mobile, where hidden time is processing time', () => {
    jest.mocked(isMobile).mockReturnValue(false);
    hide(PROPOSAL_AT, SUBMIT_AT);
    expect(submitApproachHiddenBucket(row())).toBe('not_measured');
  });

  it('stays unobserved until this run is recording background time', () => {
    __resetBackgroundTimeForTest();
    expect(submitApproachHiddenBucket(row())).toBe('unobserved');
    expect(submitApproachHiddenBucket(row({ stageTimestamps: undefined }))).toBe('unobserved');
  });

  it('is unobserved, never none, for an approach a later run of the App did not see', () => {
    __resetBackgroundTimeForTest();
    clock.mockReturnValue(SUBMIT_AT + 3_600_000);
    initBackgroundTimeTracking();
    expect(submitApproachHiddenBucket(row())).toBe('unobserved');
  });

  it.each<[string, ITransaction['stageTimestamps']]>([
    ['no stamps', undefined],
    ['no start', { submitting: SUBMIT_AT }],
    ['no submit stamp', { 'creating-proposal': PROPOSAL_AT }],
    ['a submit before its start', { 'creating-proposal': SUBMIT_AT, submitting: PROPOSAL_AT }],
    ['a submit at its start', { 'creating-proposal': PROPOSAL_AT, submitting: PROPOSAL_AT }],
    ['a stamp that is no number', { 'creating-proposal': PROPOSAL_AT, submitting: Number.NaN }]
  ])('is unavailable for a row with %s', (_name, stageTimestamps) => {
    expect(submitApproachHiddenBucket(row({ stageTimestamps }))).toBe('unavailable');
  });
});

describe('proofWindowBucket', () => {
  it.each([
    [1, 'under_30_blocks'],
    [20, 'under_30_blocks'],
    [29, 'under_30_blocks'],
    [30, '30_to_180_blocks'],
    [180, '30_to_180_blocks'],
    [181, 'over_180_blocks'],
    [4_321, 'over_180_blocks']
  ])('reads a window of %s blocks as %s', (window, bucket) => {
    expect(proofWindowBucket(row({ submitEvidence: [entry({ expirationBlock: 1_000 + window })] }))).toBe(bucket);
  });

  it.each<[string, Partial<ITransaction>]>([
    ['no attempt', { attemptId: undefined }],
    ['no evidence', { submitEvidence: undefined }],
    ['evidence of another attempt only', { submitEvidence: [entry({ attemptId: 'a0' })] }],
    ['no reference block', { submitEvidence: [entry({ refBlock: undefined })] }],
    ['no expiration', { submitEvidence: [entry({ expirationBlock: undefined })] }],
    ['an expiration at its reference block', { submitEvidence: [entry({ expirationBlock: 1_000 })] }],
    ['an expiration before its reference block', { submitEvidence: [entry({ expirationBlock: 900 })] }],
    ['a block that is no number', { submitEvidence: [entry({ refBlock: Number.NaN })] }]
  ])('is unavailable for a row with %s', (_name, overrides) => {
    expect(proofWindowBucket(row(overrides))).toBe('unavailable');
  });
});

describe('submitApproach', () => {
  it('says nothing for a row that never reached its submit', () => {
    expect(submitApproach(row({ stageTimestamps: {}, submitEvidence: undefined }))).toEqual({});
    expect(submitApproach(row({ stageTimestamps: undefined, submitEvidence: undefined }))).toEqual({});
  });

  it('says nothing for an attempt marked as ending before its submit', () => {
    const ended = row({ stageTimestamps: {}, submitEvidence: [entry({ preSubmitEnd: true })] });
    expect(submitApproach(ended)).toEqual({});
  });

  it("says nothing for another attempt's evidence", () => {
    const stale = row({ stageTimestamps: {}, submitEvidence: [entry({ attemptId: 'a0' })] });
    expect(submitApproach(stale)).toEqual({});
  });

  it('reports a row with a submit stamp even when its attempt holds no evidence', () => {
    expect(submitApproach(row({ submitEvidence: undefined }))).toEqual({
      submitApproachHidden: expect.any(String),
      proofWindow: 'unavailable'
    });
  });

  // An offscreen `submitting` stamp is fire-and-forget, so evidence can outlive a stamp that never arrived.
  it("reports a row whose stamp was lost when its attempt's evidence shows the crossing", () => {
    expect(submitApproach(row({ stageTimestamps: {} }))).toEqual({
      submitApproachHidden: expect.any(String),
      proofWindow: 'under_30_blocks'
    });
  });
});
