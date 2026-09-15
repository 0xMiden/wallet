import type { IntentTransactionStatus } from '@epoch-protocol/epoch-intents-sdk';

import { EPOCH_INTENT_STATUS_TIMEOUT_MS, readEpochIntentStatus } from './intent-status';

const reader = (answer: Promise<IntentTransactionStatus[]>) => ({ getIntentStatus: jest.fn(() => answer) });

beforeEach(() => jest.useFakeTimers());
afterEach(() => jest.useRealTimers());

describe('readEpochIntentStatus', () => {
  it('rejects a read that never answers, and only once the timeout has passed', async () => {
    const hung = reader(new Promise(() => {}));
    let settled = false;
    const read = readEpochIntentStatus(hung, '0xowner', 'nonce-1');
    const outcome = read.then(
      () => undefined,
      (error: unknown) => {
        settled = true;
        return error;
      }
    );

    await jest.advanceTimersByTimeAsync(EPOCH_INTENT_STATUS_TIMEOUT_MS - 1);
    expect(settled).toBe(false);

    await jest.advanceTimersByTimeAsync(1);
    expect(await outcome).toEqual(
      new Error(`Epoch intent status for 0xowner nonce nonce-1 timed out after ${EPOCH_INTENT_STATUS_TIMEOUT_MS} ms`)
    );
    expect(hung.getIntentStatus).toHaveBeenCalledWith('0xowner', 'nonce-1', expect.any(AbortSignal));
  });

  it('aborts the request it gave up on, and only that one', async () => {
    const signals: AbortSignal[] = [];
    const recording = (answer: Promise<IntentTransactionStatus[]>) => ({
      getIntentStatus: (_address: string, _nonce: string, signal?: AbortSignal) => {
        if (signal) signals.push(signal);
        return answer;
      }
    });

    await expect(readEpochIntentStatus(recording(Promise.resolve([])), '0xowner', 'nonce-1')).resolves.toEqual([]);
    const late = readEpochIntentStatus(recording(new Promise(() => {})), '0xowner', 'nonce-2').catch(() => undefined);
    await jest.advanceTimersByTimeAsync(EPOCH_INTENT_STATUS_TIMEOUT_MS);
    await late;

    expect(signals.map(signal => signal.aborted)).toEqual([false, true]);
  });

  it('passes an answer and a failure through and clears its timer', async () => {
    await expect(readEpochIntentStatus(reader(Promise.resolve([])), '0xowner', 'nonce-1')).resolves.toEqual([]);
    expect(jest.getTimerCount()).toBe(0);

    const failure = new Error('allocator down');
    await expect(readEpochIntentStatus(reader(Promise.reject(failure)), '0xowner', 'nonce-1')).rejects.toBe(failure);
    expect(jest.getTimerCount()).toBe(0);
  });
});
