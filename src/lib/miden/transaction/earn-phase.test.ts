import { canAdvanceEarnWithdrawPhase, updateEarnWithdrawPhase } from './complete';
import { IEarnWithdrawExtraInputs, IEarnWithdrawPhase, ITransaction } from '../db/types';

const mockTransactionsWhere = jest.fn();

jest.mock('lib/miden/repo', () => ({
  get transactions() {
    return { where: mockTransactionsWhere };
  }
}));

/**
 * The `earn-withdraw` lifecycle is driven by two independent writers that race:
 * the Epoch delivery poll (`redeeming` → `delivering` → `failed`) and the
 * auto-consume path (`received`). Without a monotonic guard, a late `delivering`
 * write could downgrade a row that had already reached a terminal phase and
 * strand it at "Delivering" forever.
 */
describe('canAdvanceEarnWithdrawPhase', () => {
  it('allows forward moves through the non-terminal phases', () => {
    expect(canAdvanceEarnWithdrawPhase('redeeming', 'delivering')).toBe(true);
    expect(canAdvanceEarnWithdrawPhase('redeeming', 'received')).toBe(true);
    expect(canAdvanceEarnWithdrawPhase('delivering', 'received')).toBe(true);
  });

  it('allows either terminal phase from a non-terminal one', () => {
    expect(canAdvanceEarnWithdrawPhase('redeeming', 'failed')).toBe(true);
    expect(canAdvanceEarnWithdrawPhase('delivering', 'failed')).toBe(true);
  });

  it('refuses a backwards move', () => {
    expect(canAdvanceEarnWithdrawPhase('delivering', 'redeeming')).toBe(false);
  });

  it('refuses moving out of `received` (the delivery race this guard exists for)', () => {
    expect(canAdvanceEarnWithdrawPhase('received', 'delivering')).toBe(false);
    expect(canAdvanceEarnWithdrawPhase('received', 'redeeming')).toBe(false);
  });

  it('refuses moving out of `failed`', () => {
    expect(canAdvanceEarnWithdrawPhase('failed', 'delivering')).toBe(false);
    expect(canAdvanceEarnWithdrawPhase('failed', 'redeeming')).toBe(false);
  });

  it('treats the two terminal phases as equal-rank and immovable', () => {
    expect(canAdvanceEarnWithdrawPhase('received', 'failed')).toBe(false);
    expect(canAdvanceEarnWithdrawPhase('failed', 'received')).toBe(false);
  });

  it('allows a same-phase write so extras stay patchable on a terminal row', () => {
    expect(canAdvanceEarnWithdrawPhase('received', 'received')).toBe(true);
    expect(canAdvanceEarnWithdrawPhase('failed', 'failed')).toBe(true);
    expect(canAdvanceEarnWithdrawPhase('redeeming', 'redeeming')).toBe(true);
  });
});

interface EarnRow {
  extraInputs: IEarnWithdrawExtraInputs;
  amount?: bigint;
  error?: string;
}

function wireRow(row: EarnRow) {
  mockTransactionsWhere.mockImplementation(() => ({
    modify: jest.fn((fn: (tx: ITransaction) => void) => {
      const asTx: unknown = row;
      fn(asTx as ITransaction);
      return Promise.resolve(1);
    })
  }));
  return row;
}

function earnRow(phase: IEarnWithdrawPhase): EarnRow {
  return {
    extraInputs: {
      phase,
      evmOwner: '0x1111111111111111111111111111111111111111',
      marketUid: 'DUMMY_LENDING:11155111:0xunderlying',
      sourceAmount: '10',
      sourceSymbol: 'USDC',
      destinationFaucetId: 'mtst1native'
    }
  };
}

describe('updateEarnWithdrawPhase monotonicity', () => {
  beforeEach(() => jest.clearAllMocks());

  it('applies a legal forward transition together with its extras', async () => {
    const row = wireRow(earnRow('redeeming'));

    await updateEarnWithdrawPhase('TX1', 'delivering', { evmTxHash: '0xsource' });

    expect(row.extraInputs.phase).toBe('delivering');
    expect(row.extraInputs.evmTxHash).toBe('0xsource');
  });

  it('drops an illegal transition WHOLE — phase and extras', async () => {
    const row = wireRow(earnRow('received'));
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => undefined);

    await updateEarnWithdrawPhase('TX1', 'delivering', { evmTxHash: '0xlate' });

    expect(row.extraInputs.phase).toBe('received');
    // The extras of a refused write must not leak onto the row.
    expect(row.extraInputs.evmTxHash).toBeUndefined();
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it('still patches extras (and the delivered amount) on a same-phase terminal write', async () => {
    const row = wireRow(earnRow('received'));

    await updateEarnWithdrawPhase('TX1', 'received', { midenNoteId: '0xnote' }, 42n);

    expect(row.extraInputs.phase).toBe('received');
    expect(row.extraInputs.midenNoteId).toBe('0xnote');
    expect(row.amount).toBe(42n);
  });

  it('mirrors the failure reason onto tx.error when moving to failed', async () => {
    const row = wireRow(earnRow('delivering'));

    await updateEarnWithdrawPhase('TX1', 'failed', { error: 'intent expired' });

    expect(row.extraInputs.phase).toBe('failed');
    expect(row.error).toBe('intent expired');
  });

  it('does not touch the amount when a refused write carries one', async () => {
    const row = wireRow(earnRow('failed'));
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => undefined);

    await updateEarnWithdrawPhase('TX1', 'delivering', undefined, 99n);

    expect(row.extraInputs.phase).toBe('failed');
    expect(row.amount).toBeUndefined();
    warn.mockRestore();
  });
});
