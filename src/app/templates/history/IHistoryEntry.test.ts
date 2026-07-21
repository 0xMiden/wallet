import { HistoryEntryType, IHistoryEntry } from './IHistoryEntry';

// `IHistoryEntry.ts` is almost entirely erasable types: the `IHistoryEntry`
// interface and the `lib/miden/db/types` imports vanish at runtime, leaving
// only the `HistoryEntryType` enum as executable code. Importing the module
// runs the enum's IIFE, and the assertions below touch every member (and its
// reverse mapping) so the emitted enum object is fully exercised.

describe('HistoryEntryType', () => {
  it('assigns the documented numeric values', () => {
    expect(HistoryEntryType.PendingTransaction).toBe(1);
    expect(HistoryEntryType.ProcessingTransaction).toBe(2);
    expect(HistoryEntryType.CompletedTransaction).toBe(3);
  });

  it('preserves the ordering used for chronological sorting', () => {
    // Lower numbers must sort as "earlier". Pending < Processing < Completed.
    expect(HistoryEntryType.PendingTransaction).toBeLessThan(HistoryEntryType.ProcessingTransaction);
    expect(HistoryEntryType.ProcessingTransaction).toBeLessThan(HistoryEntryType.CompletedTransaction);
  });

  it('exposes the reverse (value -> name) mapping TypeScript emits for numeric enums', () => {
    expect(HistoryEntryType[1]).toBe('PendingTransaction');
    expect(HistoryEntryType[2]).toBe('ProcessingTransaction');
    expect(HistoryEntryType[3]).toBe('CompletedTransaction');
  });

  it('contains exactly the three known members (forward + reverse keys)', () => {
    // Numeric enums emit both name->value and value->name keys.
    expect(Object.keys(HistoryEntryType).sort()).toEqual(
      ['1', '2', '3', 'CompletedTransaction', 'PendingTransaction', 'ProcessingTransaction'].sort()
    );
    // The distinct numeric values are exactly {1, 2, 3}.
    const numericValues = Object.values(HistoryEntryType).filter((v): v is number => typeof v === 'number');
    expect(numericValues.sort()).toEqual([1, 2, 3]);
  });
});

describe('IHistoryEntry (type-level shape)', () => {
  it('accepts a fully-populated entry (compile-time contract, runtime smoke)', () => {
    // The interface is erased at runtime, so this is a documentation-grade
    // assertion: constructing an object typed as IHistoryEntry proves the
    // required/optional fields line up with the source, and the object is
    // still a plain value we can assert against at runtime.
    const cancel = jest.fn(async () => {});
    const entry: IHistoryEntry = {
      key: 'entry-1',
      address: '0xabc',
      timestamp: 1609502400,
      message: 'Sent 5 TOK',
      type: HistoryEntryType.CompletedTransaction,
      txType: 'send',
      status: undefined,
      token: 'TOK',
      amount: 5n,
      requestedAmount: '10',
      requestedToken: 'REQ',
      secondaryAddress: '0xdef',
      cancel,
      explorerLink: 'https://explorer.example/tx/1',
      transactionIcon: 'SEND',
      txId: 'tx-1',
      fee: '0.01',
      noteType: 'private',
      noteId: 'note-1',
      externalTxId: 'ext-1',
      faucetId: 'faucet-1',
      blockNumber: 42,
      outputNoteIds: ['out-1', 'out-2']
    };

    expect(entry.key).toBe('entry-1');
    expect(entry.type).toBe(HistoryEntryType.CompletedTransaction);
    expect(entry.txType).toBe('send');
    expect(entry.amount).toBe(5n);
    expect(entry.outputNoteIds).toHaveLength(2);
  });

  it('accepts an entry with only the required fields', () => {
    const entry: IHistoryEntry = {
      key: 'entry-2',
      address: '0x123',
      timestamp: 0,
      message: '',
      type: HistoryEntryType.PendingTransaction,
      txType: 'consume'
    };

    expect(entry.status).toBeUndefined();
    expect(entry.amount).toBeUndefined();
    expect(entry.cancel).toBeUndefined();
    expect(entry.type).toBe(HistoryEntryType.PendingTransaction);
  });

  it('exposes an awaitable cancel hook when provided', async () => {
    const cancel = jest.fn(async () => {});
    const entry: IHistoryEntry = {
      key: 'entry-3',
      address: '0x456',
      timestamp: 1,
      message: 'Pending',
      type: HistoryEntryType.ProcessingTransaction,
      txType: 'send',
      cancel
    };

    await entry.cancel?.();
    expect(cancel).toHaveBeenCalledTimes(1);
  });
});
