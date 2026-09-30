import { NoteType, type OutputNote } from '@miden-sdk/miden-sdk/lazy';

import { APPLY_RETRY_DELAYS_MS, applyAfterSubmit, type ApplyAfterSubmitRetry } from './apply-after-submit';
import { extractLanded, extractSdkErrorCode, isApplyAfterSubmitError } from './sdk-error-code';

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
    const options = arrange();

    await applyAfterSubmit(options);

    expect(options.apply).toHaveBeenCalledTimes(1);
    expect(options.readLocalAccount).not.toHaveBeenCalled();
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
