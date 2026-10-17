/**
 * @jest-environment node
 */
import { rowUnits, waitForQueueDrained } from './dapp-mobile-wallet';
import { TxStatus, type TransactionRowSnapshot } from './history';
import { stashAndPoll } from './mobile-store-reads';

// A webview stand-in: each body runs as a function body over one shared `window`.
function windowed(): { win: Record<string, unknown>; evalJs: (js: string) => Promise<unknown> } {
  const win: Record<string, unknown> = {};
  // eslint-disable-next-line no-new-func
  return { win, evalJs: async js => new Function('window', js)(win) };
}

describe('stashAndPoll', () => {
  it('returns what the promise resolved to, and deletes the stash it read', async () => {
    const { win, evalJs } = windowed();
    await expect(stashAndPoll<number>(evalJs, '__t', 'Promise.resolve(41 + 1)', 2_000)).resolves.toBe(42);
    expect(Object.keys(win)).toEqual([]);
  });

  it("rejects with the promise's own message", async () => {
    const { evalJs } = windowed();
    await expect(
      stashAndPoll(evalJs, '__t', 'Promise.reject(new Error("the E2E store hook is missing"))', 2_000)
    ).rejects.toThrow('stashAndPoll(__t): the E2E store hook is missing');
  });

  it('gives up after its timeout', async () => {
    const { evalJs } = windowed();
    await expect(stashAndPoll(evalJs, '__t', 'new Promise(function () {})', 50)).rejects.toThrow(
      'timed out after 50ms'
    );
  });
});

describe('a balance row in base units', () => {
  it('reads a balance under 1e-6, which String would write in exponent form', () => {
    expect(rowUnits({ tokenId: 'mtst1fee', symbol: 'USDCX', decimals: 8, balance: 1e-7 })).toBe(10n);
  });

  it('reads a whole balance', () => {
    expect(rowUnits({ tokenId: 'mtst1tst', symbol: 'TST', decimals: 8, balance: 1000 })).toBe(100_000_000_000n);
  });
});

describe('the queue drain', () => {
  afterEach(() => {
    jest.useRealTimers();
  });

  it('waits for three reads in a row with no row queued, generating or unconfirmed', async () => {
    jest.useFakeTimers();
    const reads: TransactionRowSnapshot[][] = [
      [{ id: 'a', status: TxStatus.GeneratingTransaction }],
      [{ id: 'a', status: TxStatus.Unconfirmed }],
      [{ id: 'a', status: TxStatus.Completed }],
      [{ id: 'a', status: TxStatus.Completed }],
      [{ id: 'a', status: TxStatus.Completed }]
    ];
    let count = 0;
    const drained = waitForQueueDrained(async () => {
      count += 1;
      return reads.shift() ?? [];
    }, 60_000);
    await jest.advanceTimersByTimeAsync(10_000);
    await drained;
    expect(count).toBe(5);
  });

  it('names the rows still in flight when its time runs out', async () => {
    jest.useFakeTimers();
    const stuck = waitForQueueDrained(
      async () => [{ id: 'r5', type: 'execute', status: TxStatus.GeneratingTransaction }],
      2_500
    );
    await Promise.all([
      expect(stuck).rejects.toThrow('the queue did not drain within 2500 ms: r5 type=execute'),
      jest.advanceTimersByTimeAsync(5_000)
    ]);
  });
});
