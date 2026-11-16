import { NoteType, type OutputNote } from '@miden-sdk/miden-sdk/lazy';

import {
  APPLY_RETRY_DELAYS_MS,
  applyAfterSubmit,
  type ApplyAfterSubmitRetry,
  isLandedTailError,
  LandedTailError,
  swapOrderOf
} from './apply-after-submit';
import { extractLanded, extractSdkErrorCode, isApplyAfterSubmitError } from './sdk-error-code';
import type { UserOutputNote } from '../activity/fee-notes';

// A chain whose fee is not known yet, so no output note is set aside as the fee note.
jest.mock('lib/miden-chain/native-asset', () => ({
  getNativeAssetIdSync: () => null,
  getVerificationBaseFeeSync: () => null
}));

const INITIAL = '0xinitial';
const FINAL = '0xfinal';

const withCommitment = (hex: string) => ({ to_commitment: () => ({ toHex: () => hex }) });

const outputNote = (noteType: NoteType) =>
  ({ metadata: () => ({ noteType: () => noteType }) }) as unknown as OutputNote;

const ORDER_NOTE_ID = `0x${'ab'.repeat(32)}`;

const fullNoteWithSerial = () => ({
  recipient: () => ({ serialNum: () => ({ toFelts: () => [0n, 42n, 0n, 0n].map(value => ({ asInt: () => value })) }) })
});

/** A note whose serial's felt 1 is 42, the lineage id a PSWAP order is tracked by. */
const orderNote = (noteType: NoteType, intoFull: () => unknown = fullNoteWithSerial) =>
  ({
    id: () => ({ toString: () => ORDER_NOTE_ID }),
    metadata: () => ({ noteType: () => noteType }),
    intoFull
  }) as unknown as OutputNote;

const resultWithNotes = (notes: OutputNote[], executed: Record<string, unknown> = {}) => ({
  executedTransaction: () => ({
    id: () => ({ toHex: () => '0xtx' }),
    accountId: () => 'acc',
    initialAccountHeader: () => withCommitment(INITIAL),
    outputNotes: () => ({ notes: () => notes }),
    ...executed
  })
});

const failingApply = () =>
  jest.fn(async () => {
    throw new Error('IndexedDB transaction aborted');
  });

/**
 * A transaction on account 'acc' that started at INITIAL, submitted in a hold that stays current,
 * whose store holds `local` (null: no such account) until a test says otherwise.
 */
const arrange = (overrides: Partial<ApplyAfterSubmitRetry<string>> = {}, local: string | null = INITIAL) => {
  const options: ApplyAfterSubmitRetry<string> = {
    apply: jest.fn(async () => {}),
    result: {
      executedTransaction: () => ({
        id: () => ({ toHex: () => '0xtx' }),
        accountId: () => 'acc',
        initialAccountHeader: () => withCommitment(INITIAL),
        finalAccountHeader: () => withCommitment('final-commit'),
        outputNotes: () => ({ notes: () => [] })
      })
    },
    readLocalAccount: jest.fn(async (_accountId: string) => (local === null ? null : withCommitment(local))),
    holdIsCurrent: () => true,
    sleep: jest.fn(async (_ms: number) => {}),
    ...overrides
  };
  return options;
};

describe('applyAfterSubmit (#1233)', () => {
  it('applies once and reads nothing when the first apply lands', async () => {
    const executedTransaction = jest.fn(() => ({
      id: () => ({ toHex: () => '0xtx' }),
      accountId: () => 'acc',
      initialAccountHeader: () => withCommitment(INITIAL),
      outputNotes: () => ({ notes: () => [] })
    }));
    const options = arrange({ result: { executedTransaction } });

    await applyAfterSubmit(options);

    expect(options.apply).toHaveBeenCalledTimes(1);
    expect(options.readLocalAccount).not.toHaveBeenCalled();
    expect(executedTransaction).not.toHaveBeenCalled();
  });

  it('a first failure then success does not wrap', async () => {
    const apply = jest.fn(async () => {}).mockRejectedValueOnce(new Error('IndexedDB transaction aborted'));
    const sleep = jest.fn(async (_ms: number) => {});
    const options = arrange({ apply, sleep });

    await expect(applyAfterSubmit(options)).resolves.toBeUndefined();

    expect(apply).toHaveBeenCalledTimes(2);
    expect(options.readLocalAccount).toHaveBeenCalledWith('acc');
    expect(sleep).toHaveBeenCalledWith(APPLY_RETRY_DELAYS_MS[0]);
  });

  it('a local commitment equal to the final one does not re-apply', async () => {
    const noteWrite = new Error('note update failed');
    const apply = jest.fn(async () => {
      throw noteWrite;
    });
    const calls: string[] = [];
    const sleep = jest.fn(async (_ms: number) => {
      calls.push('sleep');
    });
    const readLocalAccount = jest.fn(async (_accountId: string) => {
      calls.push('read');
      return withCommitment(FINAL);
    });
    const options = arrange({ apply, sleep, readLocalAccount });

    const error = await applyAfterSubmit(options).catch((caught: unknown) => caught);

    expect(apply).toHaveBeenCalledTimes(1);
    // The one wait comes before the read, so the compare sits right before the write it guards.
    expect(calls).toEqual(['sleep', 'read']);
    expect(isApplyAfterSubmitError(error)).toBe(true);
    expect(error).toHaveProperty('cause', noteWrite);
  });

  it('an evicted hold does not re-apply and reads nothing', async () => {
    const apply = jest.fn(async () => {
      throw new Error('IndexedDB transaction aborted');
    });
    const options = arrange({ apply, holdIsCurrent: () => false });

    await expect(applyAfterSubmit(options)).rejects.toMatchObject({ code: 'ApplyTransactionAfterSubmitFailed' });

    expect(apply).toHaveBeenCalledTimes(1);
    expect(options.readLocalAccount).not.toHaveBeenCalled();
  });

  it('a hold evicted during the wait does not re-apply', async () => {
    let current = true;
    const apply = jest.fn(async () => {
      throw new Error('IndexedDB transaction aborted');
    });
    const sleep = jest.fn(async (_ms: number) => {
      current = false;
    });
    const options = arrange({ apply, sleep, holdIsCurrent: () => current });

    await expect(applyAfterSubmit(options)).rejects.toMatchObject({ code: 'ApplyTransactionAfterSubmitFailed' });

    expect(sleep).toHaveBeenCalledTimes(1);
    expect(apply).toHaveBeenCalledTimes(1);
  });

  it('a hold evicted during the read does not touch the account it returned', async () => {
    let current = true;
    const apply = jest.fn(async () => {
      throw new Error('IndexedDB transaction aborted');
    });
    // The account is a borrow of the client, which an eviction during the read hands to a successor.
    const toCommitment = jest.fn(() => ({ toHex: () => INITIAL }));
    const readLocalAccount = jest.fn(async (_accountId: string) => {
      current = false;
      return { to_commitment: toCommitment };
    });
    const sleep = jest.fn(async (_ms: number) => {});
    const options = arrange({ apply, readLocalAccount, sleep, holdIsCurrent: () => current });

    const error = await applyAfterSubmit(options).catch((caught: unknown) => caught);

    expect(toCommitment).not.toHaveBeenCalled();
    // The wait before the read, and no second one after the refusal.
    expect(sleep).toHaveBeenCalledTimes(1);
    expect(apply).toHaveBeenCalledTimes(1);
    expect(isApplyAfterSubmitError(error)).toBe(true);
  });

  it('waits 250 ms and then 1 s before the two retries', async () => {
    const apply = jest.fn(async () => {
      throw new Error('IndexedDB transaction aborted');
    });
    const sleep = jest.fn(async (_ms: number) => {});

    await applyAfterSubmit(arrange({ apply, sleep })).catch(() => undefined);

    expect(sleep.mock.calls.map(([ms]) => ms)).toEqual([250, 1000]);
  });

  it('a missing account does not re-apply', async () => {
    const apply = jest.fn(async () => {
      throw new Error('IndexedDB transaction aborted');
    });
    const options = arrange({ apply }, null);

    await expect(applyAfterSubmit(options)).rejects.toMatchObject({ code: 'ApplyTransactionAfterSubmitFailed' });
    expect(apply).toHaveBeenCalledTimes(1);
  });

  it('an unreadable account does not re-apply', async () => {
    const apply = jest.fn(async () => {
      throw new Error('IndexedDB transaction aborted');
    });
    const readLocalAccount = jest.fn(async (_accountId: string) => {
      throw new Error('database closed');
    });
    const options = arrange({ apply, readLocalAccount });

    await expect(applyAfterSubmit(options)).rejects.toMatchObject({ code: 'ApplyTransactionAfterSubmitFailed' });
    expect(apply).toHaveBeenCalledTimes(1);
  });

  it('every attempt failing wraps the last failure with the landed code, and reports each one', async () => {
    const first = new Error('first');
    const second = new Error('second');
    const third = new Error('third');
    const apply = jest
      .fn(async () => {})
      .mockRejectedValueOnce(first)
      .mockRejectedValueOnce(second)
      .mockRejectedValueOnce(third);
    const sleep = jest.fn(async (_ms: number) => {});
    const seen: unknown[] = [];
    const options = arrange({ apply, sleep, onApplyFailed: error => seen.push(error) });

    const error = await applyAfterSubmit(options).catch((caught: unknown) => caught);

    expect(apply).toHaveBeenCalledTimes(3);
    expect(sleep.mock.calls.map(([ms]) => ms)).toEqual([...APPLY_RETRY_DELAYS_MS]);
    expect(extractSdkErrorCode(error)).toBe('ApplyTransactionAfterSubmitFailed');
    expect(error).toHaveProperty('cause', third);
    expect(seen).toEqual([first, second, third]);
  });

  it('a throwing observer does not replace the landed verdict', async () => {
    const apply = jest.fn(async () => {
      throw new Error('IndexedDB transaction aborted');
    });
    const options = arrange(
      {
        apply,
        onApplyFailed: () => {
          throw new Error('breadcrumb failed');
        }
      },
      FINAL
    );

    await expect(applyAfterSubmit(options)).rejects.toMatchObject({ code: 'ApplyTransactionAfterSubmitFailed' });
  });

  it('a bare-string rejection still wraps, with the string as its cause', async () => {
    const apply = jest.fn(async () => {
      // eslint-disable-next-line no-throw-literal
      throw 'QuotaExceededError';
    });
    const options = arrange({ apply }, FINAL);

    const error = await applyAfterSubmit(options).catch((caught: unknown) => caught);

    expect(isApplyAfterSubmitError(error)).toBe(true);
    expect(error).toHaveProperty('cause', 'QuotaExceededError');
  });

  it('the wrap carries the executed transaction id, read while the hold was current (#1233)', async () => {
    const apply = jest.fn(async () => {
      throw new Error('IndexedDB transaction aborted');
    });

    const error = await applyAfterSubmit(arrange({ apply }, FINAL)).catch((caught: unknown) => caught);

    expect(extractLanded(error)).toMatchObject({ transactionId: '0xtx' });
  });

  it("the exhausted retries' wrap carries the executed final account commitment (#1233)", async () => {
    const apply = jest.fn(async () => {
      throw new Error('IndexedDB transaction aborted');
    });

    const error = await applyAfterSubmit(arrange({ apply })).catch((caught: unknown) => caught);

    expect(apply).toHaveBeenCalledTimes(3);
    expect(extractLanded(error)).toEqual({
      transactionId: '0xtx',
      privateOutputNotes: 0,
      finalAccountCommitment: 'final-commit'
    });
  });

  it('an unreadable final account header leaves the commitment unread and still carries the id (#1233)', async () => {
    const apply = jest.fn(async () => {
      throw new Error('IndexedDB transaction aborted');
    });
    const result = {
      executedTransaction: () => ({
        id: () => ({ toHex: () => '0xtx' }),
        accountId: () => 'acc',
        initialAccountHeader: () => withCommitment(INITIAL),
        finalAccountHeader: (): { to_commitment(): { toHex(): string } } => {
          throw new Error('recursive use of an object detected');
        },
        outputNotes: () => ({ notes: () => [] })
      })
    };

    const error = await applyAfterSubmit(arrange({ apply, result }, FINAL)).catch((caught: unknown) => caught);

    expect(isApplyAfterSubmitError(error)).toBe(true);
    expect(extractLanded(error)).toStrictEqual({ transactionId: '0xtx', privateOutputNotes: 0 });
  });

  it('the wrap carries how many private user output notes the transaction produced (#1233)', async () => {
    const apply = jest.fn(async () => {
      throw new Error('IndexedDB transaction aborted');
    });
    const notes = [outputNote(NoteType.Private), outputNote(NoteType.Public), outputNote(NoteType.Private)];
    const result = {
      executedTransaction: () => ({
        id: () => ({ toHex: () => '0xtx' }),
        accountId: () => 'acc',
        initialAccountHeader: () => withCommitment(INITIAL),
        outputNotes: () => ({ notes: () => notes })
      })
    };

    const error = await applyAfterSubmit(arrange({ apply, result }, FINAL)).catch((caught: unknown) => caught);

    expect(extractLanded(error)).toEqual({ transactionId: '0xtx', privateOutputNotes: 2 });
  });

  it('an unreadable output note list leaves the count unread and still carries the id (#1233)', async () => {
    const apply = jest.fn(async () => {
      throw new Error('IndexedDB transaction aborted');
    });
    const result = {
      executedTransaction: () => ({
        id: () => ({ toHex: () => '0xtx' }),
        accountId: () => 'acc',
        initialAccountHeader: () => withCommitment(INITIAL),
        outputNotes: (): { notes: () => OutputNote[] } => {
          throw new Error('recursive use of an object detected');
        }
      })
    };

    const error = await applyAfterSubmit(arrange({ apply, result }, FINAL)).catch((caught: unknown) => caught);

    expect(isApplyAfterSubmitError(error)).toBe(true);
    expect(extractLanded(error)).toEqual({ transactionId: '0xtx' });
  });

  it('a fee check that traps while the landed facts are read leaves the count unread and keeps the landed verdict', async () => {
    const apply = jest.fn(async () => {
      throw new Error('IndexedDB transaction aborted');
    });
    const result = {
      executedTransaction: () => ({
        id: () => ({ toHex: () => '0xtx' }),
        accountId: () => 'acc',
        initialAccountHeader: () => withCommitment(INITIAL),
        blockHeader: (): { verificationBaseFee(): number } => {
          throw new WebAssembly.RuntimeError('unreachable');
        },
        outputNotes: () => ({ notes: () => [outputNote(NoteType.Private), outputNote(NoteType.Public)] })
      })
    };

    const error = await applyAfterSubmit(arrange({ apply, result })).catch((caught: unknown) => caught);

    expect(isApplyAfterSubmitError(error)).toBe(true);
    expect(extractLanded(error)).toEqual({ transactionId: '0xtx' });
  });

  it('the wrap carries the order a public first user output note opens, read while the hold was current', async () => {
    const result = resultWithNotes([orderNote(NoteType.Public)]);

    const error = await applyAfterSubmit(arrange({ apply: failingApply(), result }, FINAL)).catch(
      (caught: unknown) => caught
    );

    const landed = extractLanded(error);
    expect(landed).toEqual({ transactionId: '0xtx', privateOutputNotes: 0, orderId: '42', orderNoteId: ORDER_NOTE_ID });
    // The facts cross a JSON-only reply, which carries no bigint.
    expect(typeof landed.orderId).toBe('string');
  });

  it('a private first user output note never has its serial read into the landed facts', async () => {
    const intoFull = jest.fn(fullNoteWithSerial);
    const result = resultWithNotes([orderNote(NoteType.Private, intoFull)]);

    const error = await applyAfterSubmit(arrange({ apply: failingApply(), result }, FINAL)).catch(
      (caught: unknown) => caught
    );

    expect(extractLanded(error)).toEqual({ transactionId: '0xtx', privateOutputNotes: 1 });
    expect(intoFull).not.toHaveBeenCalled();
  });

  it.each([
    ['an error', new Error('recursive use of an object detected')],
    ['a trap', new WebAssembly.RuntimeError('unreachable')]
  ])(
    'an order read that throws %s leaves it unread and keeps the landed verdict and the other facts',
    async (_, thrown) => {
      const result = resultWithNotes([
        orderNote(NoteType.Public, () => {
          throw thrown;
        })
      ]);

      const error = await applyAfterSubmit(arrange({ apply: failingApply(), result }, FINAL)).catch(
        (caught: unknown) => caught
      );

      expect(isApplyAfterSubmitError(error)).toBe(true);
      expect(extractLanded(error)).toEqual({ transactionId: '0xtx', privateOutputNotes: 0 });
    }
  );

  it('two public output notes on a charging chain whose fee note was not set aside name no order', async () => {
    const result = resultWithNotes([orderNote(NoteType.Public), orderNote(NoteType.Public)], {
      blockHeader: () => ({ verificationBaseFee: () => 10 })
    });

    const error = await applyAfterSubmit(arrange({ apply: failingApply(), result }, FINAL)).catch(
      (caught: unknown) => caught
    );

    expect(extractLanded(error)).toEqual({ transactionId: '0xtx', privateOutputNotes: 0 });
  });

  it('a hold evicted during the retries leaves the id and the count unread', async () => {
    const id = jest.fn(() => ({ toHex: () => '0xtx' }));
    const outputNotes = jest.fn(() => ({ notes: () => [outputNote(NoteType.Private)] }));
    const executed = { id, accountId: () => 'acc', initialAccountHeader: () => withCommitment(INITIAL), outputNotes };
    const holdIsCurrent = jest.fn(() => false).mockReturnValueOnce(true);
    const apply = jest.fn(async () => {
      throw new Error('IndexedDB transaction aborted');
    });
    const options = arrange({ apply, holdIsCurrent, result: { executedTransaction: () => executed } });

    const error = await applyAfterSubmit(options).catch((caught: unknown) => caught);

    expect(isApplyAfterSubmitError(error)).toBe(true);
    expect(extractLanded(error)).toEqual({});
    expect(id).not.toHaveBeenCalled();
    expect(outputNotes).not.toHaveBeenCalled();
  });

  it('an evicted hold leaves the id and the count unread (#1233)', async () => {
    const executedTransaction = jest.fn(() => ({
      id: () => ({ toHex: () => '0xtx' }),
      accountId: () => 'acc',
      initialAccountHeader: () => withCommitment(INITIAL),
      outputNotes: () => ({ notes: () => [outputNote(NoteType.Private)] })
    }));
    const apply = jest.fn(async () => {
      throw new Error('IndexedDB transaction aborted');
    });
    const options = arrange({ apply, holdIsCurrent: () => false, result: { executedTransaction } });

    const error = await applyAfterSubmit(options).catch((caught: unknown) => caught);

    expect(extractLanded(error)).toEqual({});
    expect(executedTransaction).not.toHaveBeenCalled();
  });
});

describe('LandedTailError (PR #2183)', () => {
  it('carries what left the tail as its cause, and the id read after it', () => {
    const cause = new Error('fee read');
    const error = new LandedTailError(cause, { transactionId: 'landed-id' });

    expect(error.cause).toBe(cause);
    expect(error.transactionId).toBe('landed-id');
    expect(isLandedTailError(error)).toBe(true);
  });

  // Text never classifies it: the wrap is made only after the leaf resolved.
  it('carries the order read after it and the note it was read off', () => {
    const error = new LandedTailError(new Error('fee read'), { orderId: 42n, orderNoteId: ORDER_NOTE_ID });

    expect(error.orderId).toBe(42n);
    expect(error.orderNoteId).toBe(ORDER_NOTE_ID);
  });

  it('is not an apply-after-submit error, and an error that is not one is not landed', () => {
    expect(isApplyAfterSubmitError(new LandedTailError(new Error('fee read')))).toBe(false);
    expect(isLandedTailError(new Error('fee read'))).toBe(false);
    expect(isLandedTailError(undefined)).toBe(false);
  });

  it('is found one cause deeper, so a caller wrapping it does not turn a landed row into a failed one', () => {
    const wrapped = new Error('pipeline failed', { cause: new LandedTailError(new Error('fee read')) });

    expect(isLandedTailError(wrapped)).toBe(true);
  });
});

describe('swapOrderOf', () => {
  const asUserNotes = (notes: OutputNote[]) => notes as unknown as UserOutputNote[];

  it("a split that set the fee note aside names the first user note's order beside another note", () => {
    const split = {
      feeNote: outputNote(NoteType.Public),
      userNotes: asUserNotes([orderNote(NoteType.Public), outputNote(NoteType.Private)])
    };

    expect(swapOrderOf(split)).toEqual({ orderId: 42n, orderNoteId: ORDER_NOTE_ID });
  });

  it('a lone note is the order note, and two notes with no fee note set aside name none', () => {
    expect(swapOrderOf({ feeNote: undefined, userNotes: asUserNotes([orderNote(NoteType.Public)]) })).toEqual({
      orderId: 42n,
      orderNoteId: ORDER_NOTE_ID
    });
    expect(
      swapOrderOf({
        feeNote: undefined,
        userNotes: asUserNotes([orderNote(NoteType.Public), orderNote(NoteType.Public)])
      })
    ).toBeUndefined();
    expect(swapOrderOf({ feeNote: outputNote(NoteType.Public), userNotes: [] })).toBeUndefined();
  });
});
