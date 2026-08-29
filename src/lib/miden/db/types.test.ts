import { ConsumableNote, NoteTypeEnum } from '../types';
import {
  BridgedReceiveTransaction,
  ConsumeTransaction,
  EarnDepositTransaction,
  EarnWithdrawTransaction,
  formatTransactionStatus,
  ITransactionStatus,
  nextQueuedSeq,
  SendTransaction,
  Transaction
} from './types';

describe('transaction models', () => {
  it('initializes Transaction defaults', () => {
    const tx = new Transaction('acc', new Uint8Array([1, 2]), ['n1'], true, 'recip');
    expect(tx.type).toBe('execute');
    expect(tx.status).toBe(ITransactionStatus.Queued);
    expect(tx.displayMessage).toBe('Executing');
    expect(tx.delegateTransaction).toBe(true);
    expect(tx.secondaryAccountId).toBe('recip');
  });

  it('initializes SendTransaction defaults', () => {
    const tx = new SendTransaction('acc', BigInt(10), 'recip', 'faucet', NoteTypeEnum.Public, 5, true);
    expect(tx.type).toBe('send');
    expect(tx.status).toBe(ITransactionStatus.Queued);
    expect(tx.displayIcon).toBe('SEND');
    expect(tx.extraInputs.recallBlocks).toBe(5);
    expect(tx.delegateTransaction).toBe(true);
  });

  it('initializes ConsumeTransaction defaults', () => {
    const note: ConsumableNote = {
      id: 'note1',
      faucetId: 'faucet',
      amount: '1',
      senderAddress: 'sender',
      isBeingClaimed: false,
      type: NoteTypeEnum.Private
    };
    const tx = new ConsumeTransaction('acc', note, true);
    expect(tx.type).toBe('consume');
    expect(tx.status).toBe(ITransactionStatus.Queued);
    expect(tx.displayIcon).toBe('RECEIVE');
    expect(tx.delegateTransaction).toBe(true);
    expect(tx.completedAt).toBeUndefined();
  });

  describe('ConsumeTransaction batch aggregation', () => {
    const note = (over: Partial<ConsumableNote> & { id: string }): ConsumableNote => ({
      faucetId: 'faucet-a',
      amount: '10',
      senderAddress: 'sender',
      isBeingClaimed: false,
      type: NoteTypeEnum.Private,
      ...over
    });

    // Amounts are deliberately UNEQUAL: with three identical notes, summing each
    // note's own amount and summing the first note's amount three times give the
    // same answer, so the test would pass against a constructor that ignores
    // every note but the first.
    it('totals a mixed batch per faucet and keeps amount on the first note s faucet', () => {
      const tx = new ConsumeTransaction('acc', [
        note({ id: 'n1', faucetId: 'faucet-a', amount: '10' }),
        note({ id: 'n2', faucetId: 'faucet-a', amount: '3' }),
        note({ id: 'n3', faucetId: 'faucet-b', amount: '7' })
      ]);

      expect(tx.assetTotals).toEqual([
        { faucetId: 'faucet-a', amount: 13n },
        { faucetId: 'faucet-b', amount: 7n }
      ]);
      // The headline amount is one entry of assetTotals, never a separate tally.
      expect(tx.amount).toBe(13n);
      expect(tx.noteIds).toEqual(['n1', 'n2', 'n3']);
    });

    // The empty-amount note sits on its OWN faucet, so its absence is visible.
    // On a shared faucet it is invisible: `BigInt('')` is `0n`, so dropping the
    // skip changes nothing and the test passes against a missing guard.
    it('leaves assetTotals off a batch s odd note out when it has no amount', () => {
      const tx = new ConsumeTransaction('acc', [
        note({ id: 'n1', amount: '7' }),
        note({ id: 'n2', faucetId: 'faucet-empty', amount: '' }),
        note({ id: 'n3', amount: '5' })
      ]);

      expect(tx.assetTotals).toEqual([{ faucetId: 'faucet-a', amount: 12n }]);
      expect(tx.amount).toBe(12n);
    });

    it('omits assetTotals entirely when no note carries an identifiable asset', () => {
      const tx = new ConsumeTransaction('acc', [note({ id: 'n1', faucetId: '', amount: '4' })]);

      // An empty faucet id still yields a headline amount, but it cannot be a
      // per-faucet total — there is no faucet to attribute it to.
      expect(tx.amount).toBe(4n);
      expect(tx.assetTotals).toBeUndefined();
    });

    it('reports a note type only when the batch agrees on one', () => {
      const uniform = new ConsumeTransaction('acc', [
        note({ id: 'n1', type: NoteTypeEnum.Public }),
        note({ id: 'n2', type: NoteTypeEnum.Public })
      ]);
      const mixed = new ConsumeTransaction('acc', [
        note({ id: 'n1', type: NoteTypeEnum.Public }),
        note({ id: 'n2', type: NoteTypeEnum.Private })
      ]);

      expect(uniform.noteType).toBe(NoteTypeEnum.Public);
      expect(mixed.noteType).toBeUndefined();
    });

    // 'unknown' is what `claimable-notes`/`settlement` produce when the node did
    // not report a storage mode. It agrees with itself across the batch, so only
    // the explicit check keeps it off the row — otherwise the details card grows
    // a "Note type: unknown" line that tells the user nothing.
    it('reports no note type when the batch agrees only on not knowing', () => {
      const tx = new ConsumeTransaction('acc', [
        note({ id: 'n1', type: 'unknown' }),
        note({ id: 'n2', type: 'unknown' })
      ]);

      expect(tx.noteType).toBeUndefined();
    });

    it('rejects an empty batch rather than constructing a note-less consume', () => {
      expect(() => new ConsumeTransaction('acc', [])).toThrow('ConsumeTransaction requires at least one note');
    });
  });

  it('creates bridge receives as tracking-only completed rows', () => {
    const tx = new BridgedReceiveTransaction(
      'miden-account',
      10n,
      'miden-faucet',
      'epoch',
      '0x1111111111111111111111111111111111111111',
      '10',
      'USDC',
      '9.9',
      'USDC'
    );

    expect(tx.type).toBe('bridged-receive');
    expect(tx.status).toBe(ITransactionStatus.Completed);
    expect(tx.completedAt).toBe(tx.initiatedAt);
    expect(tx.extraInputs).toMatchObject({ provider: 'epoch', phase: 'submitting', outputAmount: '9.9' });
  });

  it('creates earn deposits as queued recallable sends', () => {
    const tx = new EarnDepositTransaction(
      'miden-account',
      1_500_000n,
      '0x1111111111111111111111111111111111111111',
      'DUMMY_LENDING:11155111:0xasset',
      'miden-usdc',
      {
        recipientId: 'allocator-account',
        noteType: NoteTypeEnum.Private,
        recallBlocks: 120
      },
      true
    );

    expect(tx).toMatchObject({
      type: 'earn-deposit',
      accountId: 'miden-account',
      amount: 1_500_000n,
      faucetId: 'miden-usdc',
      secondaryAccountId: 'allocator-account',
      noteType: NoteTypeEnum.Private,
      status: ITransactionStatus.Queued,
      displayIcon: 'DEFAULT',
      displayMessage: 'Depositing',
      delegateTransaction: true,
      extraInputs: {
        evmRecipient: '0x1111111111111111111111111111111111111111',
        marketUid: 'DUMMY_LENDING:11155111:0xasset',
        sourceFaucetId: 'miden-usdc',
        recallBlocks: 120,
        epochStatus: 'pending'
      }
    });
    expect(tx.id).toEqual(expect.any(String));
    expect(tx.initiatedAt).toEqual(expect.any(Number));
  });

  it('creates earn withdrawals as completed tracking-only rows', () => {
    const tx = new EarnWithdrawTransaction(
      'miden-account',
      0n,
      '0x2222222222222222222222222222222222222222',
      'DUMMY_LENDING:11155111:0xasset',
      'miden-usdc',
      '42.25'
    );

    expect(tx).toMatchObject({
      type: 'earn-withdraw',
      accountId: 'miden-account',
      amount: 0n,
      faucetId: 'miden-usdc',
      status: ITransactionStatus.Completed,
      displayIcon: 'DEFAULT',
      displayMessage: 'Withdrawing from lending',
      extraInputs: {
        evmOwner: '0x2222222222222222222222222222222222222222',
        marketUid: 'DUMMY_LENDING:11155111:0xasset',
        destinationFaucetId: 'miden-usdc',
        sourceAmount: '42.25',
        sourceSymbol: 'USDC',
        phase: 'redeeming'
      }
    });
    expect(tx.completedAt).toBe(tx.initiatedAt);
  });

  it('preserves an explicit earn withdrawal source symbol', () => {
    const tx = new EarnWithdrawTransaction(
      'miden-account',
      0n,
      '0x3333333333333333333333333333333333333333',
      'MARKET',
      'destination-faucet',
      '7',
      'USDT'
    );

    expect(tx.extraInputs.sourceSymbol).toBe('USDT');
  });

  it('formats transaction status', () => {
    expect(formatTransactionStatus(ITransactionStatus.GeneratingTransaction)).toBe('Generating Transaction');
  });

  it('formats all transaction statuses', () => {
    expect(formatTransactionStatus(ITransactionStatus.Queued)).toBe('Queued');
    expect(formatTransactionStatus(ITransactionStatus.Completed)).toBe('Completed');
    expect(formatTransactionStatus(ITransactionStatus.Failed)).toBe('Failed');
  });

  it('handles ConsumeTransaction with empty amount string', () => {
    const note: ConsumableNote = {
      id: 'note2',
      faucetId: 'faucet',
      amount: '',
      senderAddress: 'sender',
      type: NoteTypeEnum.Private,
      isBeingClaimed: false
    };
    const tx = new ConsumeTransaction('acc', note);
    expect(tx.amount).toBeUndefined();
    expect(tx.delegateTransaction).toBeUndefined();
  });

  it('creates Transaction with minimal params', () => {
    const tx = new Transaction('acc', new Uint8Array([1]));
    expect(tx.inputNoteIds).toBeUndefined();
    expect(tx.delegateTransaction).toBeUndefined();
    expect(tx.secondaryAccountId).toBeUndefined();
  });

  it('creates SendTransaction with minimal params', () => {
    const tx = new SendTransaction('acc', BigInt(5), 'recip', 'faucet', NoteTypeEnum.Private);
    expect(tx.extraInputs.recallBlocks).toBeUndefined();
    expect(tx.delegateTransaction).toBeUndefined();
  });
});

describe('queuedSeq — FIFO tie-break', () => {
  it('is strictly increasing even when the clock does not advance', () => {
    // The whole point. `initiatedAt` is whole SECONDS, so rows queued in the same
    // second tie and a stable sort then falls back to Dexie's primary-key order over
    // random `uuid()`s -- silently randomizing any deliberate enqueue order. Claim All
    // depends on that order: it queues the native-asset group first so the claim that
    // funds the vault runs before the claims that must pay a fee out of it.
    //
    // `Date.now()` alone is not sufficient, because consecutive Dexie transactions can
    // commit inside one millisecond.
    const frozen = jest.spyOn(Date, 'now').mockReturnValue(1_700_000_000_000);
    try {
      const seqs = [nextQueuedSeq(), nextQueuedSeq(), nextQueuedSeq()];
      expect(seqs[1]!).toBeGreaterThan(seqs[0]!);
      expect(seqs[2]!).toBeGreaterThan(seqs[1]!);
    } finally {
      frozen.mockRestore();
    }
  });

  it('stamps every queued row, in creation order', () => {
    const claimable: ConsumableNote[] = [
      { id: 'n1', faucetId: 'faucet', amount: '1', isBeingClaimed: false } as ConsumableNote
    ];
    const first = new ConsumeTransaction('acc', claimable, false);
    const second = new SendTransaction('acc', BigInt(1), 'recip', 'faucet', NoteTypeEnum.Public);
    const third = new Transaction('acc', new Uint8Array([1]));

    expect(first.queuedSeq).toBeDefined();
    expect(second.queuedSeq!).toBeGreaterThan(first.queuedSeq!);
    expect(third.queuedSeq!).toBeGreaterThan(second.queuedSeq!);
  });

  it('sorts rows that predate the field ahead of stamped ones in the same second', () => {
    // Legacy rows carry no `queuedSeq`; treated as 0 they sort first, which is true of
    // them. Mirrors the comparator in the processing loop.
    const rows = [
      { initiatedAt: 10, queuedSeq: 1_700_000_000_000 },
      { initiatedAt: 10, queuedSeq: undefined },
      { initiatedAt: 9, queuedSeq: undefined }
    ];
    rows.sort((a, b) => a.initiatedAt - b.initiatedAt || (a.queuedSeq ?? 0) - (b.queuedSeq ?? 0));

    expect(rows.map(r => r.initiatedAt)).toEqual([9, 10, 10]);
    expect(rows[1]!.queuedSeq).toBeUndefined();
  });
});
