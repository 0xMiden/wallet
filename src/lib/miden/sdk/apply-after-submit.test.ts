import { APPLY_RETRY_DELAYS_MS, applyAfterSubmit, type ApplyAfterSubmitRetry } from './apply-after-submit';
import { extractSdkErrorCode, isApplyAfterSubmitError } from './sdk-error-code';

const INITIAL = '0xinitial';
const FINAL = '0xfinal';

const withCommitment = (hex: string) => ({ to_commitment: () => ({ toHex: () => hex }) });

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
        initialAccountHeader: () => withCommitment(INITIAL)
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
    const sleep = jest.fn(async (_ms: number) => {});
    const options = arrange({ apply, sleep }, FINAL);

    const error = await applyAfterSubmit(options).catch((caught: unknown) => caught);

    expect(apply).toHaveBeenCalledTimes(1);
    expect(sleep).not.toHaveBeenCalled();
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
});
