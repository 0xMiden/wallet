import { ITransactionStatus } from 'lib/miden/db/types';
import type { TokenBalanceData } from 'lib/miden/front/balance';
import { MIDEN_METADATA } from 'lib/miden/metadata';
import { TRANSACTION_VAULT_SHORTFALL_ERROR } from 'lib/miden/transaction/constants';

import {
  claimNoteIds,
  describeRotationFailure,
  GateRow,
  isBelowBaseFee,
  newestRow,
  resolveRotationGateView,
  RotationFailureRow,
  RotationGateViewInput,
  rotationFundingMinimum
} from './HotKeyRotationGate.selectors';

// The root manual mock of this module has no `formatBigInt`; the minimum line needs the real one.
jest.mock('lib/i18n/numbers', () => jest.requireActual('lib/i18n/numbers'));

const row = (id: string, extra: Partial<GateRow> = {}): GateRow => ({
  id,
  type: 'replace-hot-key',
  status: ITransactionStatus.Queued,
  initiatedAt: 100,
  ...extra
});
const shortfall = row('rotation-1', { status: ITransactionStatus.Failed, error: TRANSACTION_VAULT_SHORTFALL_ERROR });
const claim = (id: string, extra: Partial<GateRow> = {}): GateRow =>
  row(id, { type: 'consume', noteIds: ['note-1'], initiatedAt: 200, ...extra });

const input = (extra: Partial<RotationGateViewInput> = {}): RotationGateViewInput => ({
  initError: null,
  baseFee: 10000,
  belowBaseFee: false,
  rotationRows: [],
  fundingRows: [],
  listedNoteIds: new Set(),
  tooSmall: false,
  ...extra
});

const nativeRow = (balance: number, metadata = MIDEN_METADATA): TokenBalanceData => ({
  tokenId: 'native',
  tokenSlug: 'MIDEN',
  metadata,
  balance,
  fiatPrice: 0,
  change24h: 0
});

describe('resolveRotationGateView: the view table', () => {
  it('shows the recovery-seed prompt for a queued row awaiting the seed, ahead of funding', () => {
    const awaiting = row('rotation-1', { awaitingRecoverySeed: true });
    expect(resolveRotationGateView(input({ trackedRow: awaiting, belowBaseFee: true }))).toEqual({
      view: 'recovery-seed'
    });
  });

  it('shows funding for a tracked shortfall, ahead of the failure surface', () => {
    const view = resolveRotationGateView(input({ trackedRow: shortfall, rotationRows: [shortfall] }));
    expect(view).toEqual({ view: 'funding', reason: 'rotation-shortfall', status: 'waiting' });
  });

  it('shows the failure surface for a rotation that failed for another reason, or an init error', () => {
    const failed = row('rotation-1', { status: ITransactionStatus.Failed, error: 'guardian unreachable' });
    expect(resolveRotationGateView(input({ trackedRow: failed })).view).toBe('failed');
    expect(resolveRotationGateView(input({ initError: 'lock failed' })).view).toBe('failed');
  });

  it('shows the spinner otherwise', () => {
    expect(resolveRotationGateView(input({ trackedRow: row('rotation-1') })).view).toBe('rotating');
    expect(resolveRotationGateView(input()).view).toBe('rotating');
  });

  it('never shows funding on a chain that charges nothing', () => {
    const view = resolveRotationGateView(
      input({ baseFee: 0, trackedRow: shortfall, belowBaseFee: true, fundingRows: [claim('claim-1')] })
    );
    expect(view.view).toBe('failed');
  });

  it('keeps the shortfall trigger while the fee is unknown', () => {
    expect(resolveRotationGateView(input({ baseFee: null, trackedRow: shortfall })).view).toBe('funding');
  });
});

describe('resolveRotationGateView: why the panel is up', () => {
  it('names the shortfall first, then the balance, then a claim alone', () => {
    const live = claim('claim-1');
    expect(
      resolveRotationGateView(input({ trackedRow: shortfall, belowBaseFee: true, fundingRows: [live] }))
    ).toMatchObject({ reason: 'rotation-shortfall' });
    expect(resolveRotationGateView(input({ belowBaseFee: true, fundingRows: [live] }))).toMatchObject({
      reason: 'below-base-fee'
    });
    expect(resolveRotationGateView(input({ fundingRows: [live] }))).toMatchObject({
      view: 'funding',
      reason: 'claim-in-progress'
    });
  });

  it('does not raise the panel for a finished claim alone', () => {
    const done = claim('claim-1', { status: ITransactionStatus.Completed });
    expect(resolveRotationGateView(input({ fundingRows: [done] })).view).toBe('rotating');
  });
});

describe('resolveRotationGateView: the funding status', () => {
  it('is claiming while a claim is live, even with a rotation live beside it', () => {
    const view = resolveRotationGateView(
      input({
        belowBaseFee: true,
        rotationRows: [row('rotation-2')],
        fundingRows: [claim('claim-1', { status: ITransactionStatus.GeneratingTransaction })]
      })
    );
    expect(view).toMatchObject({ status: 'claiming' });
  });

  it('is activating while a rotation is live', () => {
    const view = resolveRotationGateView(input({ belowBaseFee: true, rotationRows: [shortfall, row('rotation-2')] }));
    expect(view).toMatchObject({ status: 'activating' });
  });

  it('is claim-failed when the newest attempt is a failed claim whose notes are still listed', () => {
    const failed = claim('claim-1', { status: ITransactionStatus.Failed, error: 'guardian unreachable' });
    const view = resolveRotationGateView(
      input({
        trackedRow: shortfall,
        rotationRows: [shortfall],
        fundingRows: [failed],
        listedNoteIds: new Set(['note-1'])
      })
    );
    expect(view).toEqual({
      view: 'funding',
      reason: 'rotation-shortfall',
      status: 'claim-failed',
      failedClaim: failed
    });
  });

  it('stays claim-failed after a later rotation attempt while the failed claim notes are still listed', () => {
    const failed = claim('claim-1', { status: ITransactionStatus.Failed });
    const later = row('rotation-2', {
      status: ITransactionStatus.Failed,
      error: TRANSACTION_VAULT_SHORTFALL_ERROR,
      initiatedAt: 300
    });
    const view = resolveRotationGateView(
      input({
        trackedRow: later,
        rotationRows: [shortfall, later],
        fundingRows: [failed],
        listedNoteIds: new Set(['note-1'])
      })
    );
    expect(view).toMatchObject({ status: 'claim-failed', failedClaim: failed });
  });

  it('is not claim-failed when the failed claim notes are no longer listed', () => {
    const failed = claim('claim-1', { status: ITransactionStatus.Failed });
    const view = resolveRotationGateView(
      input({ trackedRow: shortfall, rotationRows: [shortfall], fundingRows: [failed] })
    );
    expect(view).toMatchObject({ status: 'waiting' });
  });

  it('is too-small when the listed native notes are worth less than a claim', () => {
    expect(resolveRotationGateView(input({ trackedRow: shortfall, tooSmall: true }))).toMatchObject({
      status: 'too-small'
    });
  });
});

describe('newestRow', () => {
  it('breaks a same-second tie on the queue sequence', () => {
    const first = row('a', { queuedSeq: 1 });
    const second = row('b', { queuedSeq: 2 });
    expect(newestRow([second, first])).toBe(second);
    expect(newestRow([first, second])).toBe(second);
    expect(newestRow([])).toBeUndefined();
    // Rows written before the sequence existed tie at 0: the first read stays newest.
    const legacy = row('c');
    expect(newestRow([legacy, row('d')])).toBe(legacy);
  });
});

describe('claimNoteIds', () => {
  it('reads a batch claim, and nothing from a row without notes', () => {
    expect(claimNoteIds(claim('a', { noteIds: ['n1', 'n2'] }))).toEqual(['n1', 'n2']);
    expect(claimNoteIds(claim('c', { noteIds: undefined }))).toEqual([]);
  });
});

describe('isBelowBaseFee', () => {
  it('stays off while balances load, since the placeholder is a zero native row', () => {
    expect(isBelowBaseFee(true, [nativeRow(0)], 'native', 10000)).toBe(false);
  });

  // HotKeyRotationGate.test.tsx defaults its mock balances to `[]`, so an empty
  // list must not read as below the fee.
  it('reads an empty balances array as not below fee', () => {
    expect(isBelowBaseFee(false, [], 'native', 10000)).toBe(false);
  });
});

describe('rotationFundingMinimum', () => {
  it('asks for one claim and one rotation at the reserve bound: 0.6 MIDEN at base fee 10000', () => {
    expect(rotationFundingMinimum(10000, nativeRow(0))).toBe('0.6');
  });

  it('is hidden while the fee or the native scale is unknown, and on a chain that charges nothing', () => {
    expect(rotationFundingMinimum(null, nativeRow(0))).toBeNull();
    expect(rotationFundingMinimum(0, nativeRow(0))).toBeNull();
    expect(rotationFundingMinimum(10000, undefined)).toBeNull();
    expect(rotationFundingMinimum(10000, nativeRow(0, { ...MIDEN_METADATA, scaleIsUnknown: true }))).toBeNull();
  });
});

describe('describeRotationFailure', () => {
  const failed = (extra: Partial<RotationFailureRow> = {}): RotationFailureRow => ({
    type: 'replace-hot-key',
    status: ITransactionStatus.Failed,
    ...extra
  });
  const rawTimeout = 'Error: Error during Guardian transaction submission or execution: request timeout';

  it('puts an init error behind the generic message, even while a failed row is tracked', () => {
    expect(describeRotationFailure(failed({ error: rawTimeout, mayHaveSubmitted: true }), 'enqueue failed')).toEqual({
      unconfirmed: false,
      message: null,
      details: 'enqueue failed'
    });
  });

  it('shows nothing but the generic message with no row and no init error', () => {
    expect(describeRotationFailure(undefined, null)).toEqual({ unconfirmed: false, message: null });
  });

  it('names an old-format shortfall and keeps its kernel line as the details', () => {
    const kernel = 'assertion failed with error code: 644413868907058392';
    expect(describeRotationFailure(failed({ error: kernel }), null)).toEqual({
      unconfirmed: false,
      message: TRANSACTION_VAULT_SHORTFALL_ERROR,
      details: kernel
    });
  });

  it('gives a classified shortfall no details when there is no raw text beyond its message', () => {
    expect(describeRotationFailure(failed({ error: TRANSACTION_VAULT_SHORTFALL_ERROR }), null)).toEqual({
      unconfirmed: false,
      message: TRANSACTION_VAULT_SHORTFALL_ERROR,
      details: undefined
    });
  });

  it('shows classified copy with its raw error behind it, even when the row may have submitted', () => {
    const copy = 'The guardian or the Miden network could not be reached, so this transaction was not sent.';
    expect(
      describeRotationFailure(failed({ error: copy, rawError: 'Error: 503', mayHaveSubmitted: true }), null)
    ).toEqual({ unconfirmed: false, message: copy, details: 'Error: 503' });
  });

  it('reads an unclassified failure past the submit crossing as unconfirmed', () => {
    expect(describeRotationFailure(failed({ error: rawTimeout, mayHaveSubmitted: true }), null)).toEqual({
      unconfirmed: true,
      message: null,
      details: rawTimeout
    });
  });

  it('puts an unclassified failure before the submit crossing behind the generic message', () => {
    expect(describeRotationFailure(failed({ error: rawTimeout }), null)).toEqual({
      unconfirmed: false,
      message: null,
      details: rawTimeout
    });
  });

  it('gives a failed row with an empty error the generic message and no details', () => {
    expect(describeRotationFailure(failed({ error: '' }), null)).toEqual({
      unconfirmed: false,
      message: null,
      details: undefined
    });
  });
});
