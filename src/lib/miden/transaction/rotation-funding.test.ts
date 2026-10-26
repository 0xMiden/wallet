import { ITransactionStatus, ReplaceHotKeyTransaction } from '../db/types';
import { ConsumableNote, SwapOrderNoteMetadata } from '../types';
import { isLiveRotationFundingRow, isLiveRotationRow, selectRotationFundingNotes } from './rotation-funding';

const NATIVE = 'native-faucet';
const ACCOUNT = 'acc-1';

const note = (id: string, extra: Partial<ConsumableNote> = {}): ConsumableNote => ({
  id,
  faucetId: NATIVE,
  amount: '1000000',
  senderAddress: 'sender',
  isBeingClaimed: false,
  type: 'unknown',
  standardPayment: true,
  ...extra
});

const live = (data: ConsumableNote[]) => ({ data, isFallback: false });

describe('selectRotationFundingNotes', () => {
  it('keeps only native, non-swap, not-cached notes, and leaves notes being claimed out of the batch', () => {
    const swapOrder: SwapOrderNoteMetadata = {
      orderId: '1',
      depth: 0,
      role: 'payback',
      lineageState: 'active',
      expiresAt: 0,
      autoConsume: false
    };
    const notes = [
      note('a'),
      note('other', { faucetId: 'other-faucet' }),
      note('swap', { swapOrder }),
      note('cached', { fromCache: true }),
      note('claiming', { isBeingClaimed: true })
    ];

    const selection = selectRotationFundingNotes(live(notes), NATIVE, 10000);

    expect(selection.native.map(n => n.id)).toEqual(['a', 'claiming']);
    expect(selection.batch.map(n => n.id)).toEqual(['a']);
    expect(selection.tooSmall).toBe(false);
  });

  it('takes the whole batch when the notes are worth one fee together', () => {
    const selection = selectRotationFundingNotes(
      live([note('a', { amount: '200000' }), note('b', { amount: '200000' })]),
      NATIVE,
      10000
    );

    expect(selection.batch.map(n => n.id)).toEqual(['a', 'b']);
  });

  it('returns nothing to claim below the floor, and says so', () => {
    const selection = selectRotationFundingNotes(live([note('dust', { amount: '300000' })]), NATIVE, 10000);

    expect(selection.batch).toEqual([]);
    expect(selection.native.map(n => n.id)).toEqual(['dust']);
    expect(selection.tooSmall).toBe(true);
  });

  it('claims on an unknown fee, like every other claim floor', () => {
    expect(selectRotationFundingNotes(live([note('a', { amount: '1' })]), NATIVE, null).batch).toHaveLength(1);
  });

  it('returns nothing from a fallback list, or while the native asset is unknown', () => {
    expect(selectRotationFundingNotes({ data: [note('a')], isFallback: true }, NATIVE, 10000)).toEqual({
      native: [],
      batch: [],
      tooSmall: false
    });
    expect(selectRotationFundingNotes(live([note('a')]), null, 10000).native).toEqual([]);
    expect(selectRotationFundingNotes({ data: undefined, isFallback: false }, NATIVE, 10000).native).toEqual([]);
  });

  // Generation refuses a whole claim over one non-standard note, and a note worth less than
  // its own fee is never split out of a batch, so one such note would lock the gate (#805).
  it('claims only standard payment notes, leaving out a custom-script note worth less than a fee', () => {
    const selection = selectRotationFundingNotes(
      live([note('standard'), note('custom', { standardPayment: false, amount: '1' })]),
      NATIVE,
      10000
    );

    expect(selection.batch.map(n => n.id)).toEqual(['standard']);
    expect(selection.native.map(n => n.id)).toEqual(['standard']);
  });

  it('never claims a note that does not say it is a standard payment', () => {
    const selection = selectRotationFundingNotes(
      live([note('unknown', { standardPayment: undefined })]),
      NATIVE,
      10000
    );

    expect(selection).toEqual({ native: [], batch: [], tooSmall: false });
  });

  it('is not too small when every listed note is already being claimed', () => {
    const selection = selectRotationFundingNotes(
      live([note('a', { isBeingClaimed: true, amount: '1' })]),
      NATIVE,
      10000
    );

    expect(selection.tooSmall).toBe(false);
  });
});

describe('the gate row predicates', () => {
  it('reads a Queued or Generating row of the account as live, and nothing else', () => {
    const rotation = new ReplaceHotKeyTransaction(ACCOUNT, false);
    expect(isLiveRotationRow(rotation, ACCOUNT)).toBe(true);
    expect(isLiveRotationRow({ ...rotation, status: ITransactionStatus.GeneratingTransaction }, ACCOUNT)).toBe(true);
    expect(isLiveRotationRow({ ...rotation, status: ITransactionStatus.Failed }, ACCOUNT)).toBe(false);
    expect(isLiveRotationRow(rotation, 'acc-2')).toBe(false);
    expect(isLiveRotationFundingRow({ ...rotation, type: 'consume', rotationFunding: true }, ACCOUNT)).toBe(true);
    expect(isLiveRotationFundingRow({ ...rotation, type: 'consume' }, ACCOUNT)).toBe(false);
  });
});
