/**
 * @jest-environment node
 */
import { accountRows, readRows, rowUnits, waitForQueueDrained, type MobileWallet } from './dapp-mobile-wallet';
import { TxStatus, type TransactionRowSnapshot } from './history';
import { stashAndPoll } from './mobile-store-reads';
import { db } from '../../../src/lib/miden/repo';

// A wallet whose webview runs each body as a function body over `win`; its first `failures` evals fail as a bridge
// reattach does.
function walletOver(win: Record<string, unknown>, failures = 0): MobileWallet {
  let left = failures;
  const unused = async (): Promise<never> => {
    throw new Error('not used by these reads');
  };
  return {
    evalJs: async <T>(js: string): Promise<T> => {
      if (left > 0) {
        left -= 1;
        throw new Error('inspector reattached');
      }
      // eslint-disable-next-line no-new-func
      return new Function('window', js)(win);
    },
    click: unused,
    waitFor: unused,
    screenshot: unused,
    navigateTo: unused,
    delay: unused,
    createNewWallet: unused,
    createGuardianWallet: unused,
    claimAllNotes: unused,
    getGuardianAuthInfo: unused
  };
}

function windowed(): { win: Record<string, unknown>; evalJs: (js: string) => Promise<unknown> } {
  const win: Record<string, unknown> = {};
  return { win, evalJs: walletOver(win).evalJs };
}

// One read per poll; an Error is a read the bridge failed. Past the script the queue reads empty.
function scripted(reads: Array<TransactionRowSnapshot[] | Error>): {
  read: () => Promise<TransactionRowSnapshot[]>;
  count: () => number;
} {
  let count = 0;
  return {
    read: async () => {
      const next = reads[count];
      count += 1;
      if (next instanceof Error) throw next;
      return next ?? [];
    },
    count: () => count
  };
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

describe('the balance rows', () => {
  afterEach(() => {
    jest.useRealTimers();
  });

  // The store's own contract: a landed read writes the rows and stamps balancesLastFetched; a skipped one (a read in
  // flight, the lock busy, the balance fuse lit) returns having written nothing.
  function storeLandingOn(landsOn: number): { win: Record<string, unknown>; fetches: () => number } {
    const balances: Record<string, unknown[]> = {};
    const balancesLastFetched: Record<string, number> = { acct: 1_000 };
    let fetches = 0;
    const state = {
      currentAccount: { publicKey: 'acct' },
      assetsMetadata: {},
      balances,
      balancesLastFetched,
      fetchBalances: async (pk: string) => {
        fetches += 1;
        if (fetches < landsOn) return;
        balances[pk] = [{ tokenId: 'mtst1tst', metadata: { symbol: 'TST', decimals: 8 }, balance: 5 }];
        balancesLastFetched[pk] = 2_000;
      }
    };
    return { win: { __TEST_STORE__: { getState: () => state } }, fetches: () => fetches };
  }

  it('asks the store again until a balance read of the current account has landed', async () => {
    jest.useFakeTimers();
    const store = storeLandingOn(2);
    await Promise.all([
      expect(accountRows(walletOver(store.win))).resolves.toEqual({
        account: 'acct',
        displayFaucetId: null,
        rows: [{ tokenId: 'mtst1tst', symbol: 'TST', decimals: 8, balance: 5 }]
      }),
      jest.advanceTimersByTimeAsync(5_000)
    ]);
    expect(store.fetches()).toBe(2);
  });

  it('names the account whose balance read never landed', async () => {
    jest.useFakeTimers();
    await Promise.all([
      expect(accountRows(walletOver(storeLandingOn(Infinity).win))).rejects.toThrow(
        'no balance read of acct landed within 60000 ms'
      ),
      jest.advanceTimersByTimeAsync(70_000)
    ]);
  });
});

describe('the transaction rows', () => {
  it('asks a failed row read again instead of failing the read', async () => {
    await db.table('transactions').put({ id: 'tx-1', type: 'send', status: TxStatus.Completed });
    await expect(readRows(walletOver({}, 1))).resolves.toEqual([
      expect.objectContaining({ id: 'tx-1', type: 'send', status: TxStatus.Completed })
    ]);
  });

  it('fails on the third failed read in a row', async () => {
    await expect(readRows(walletOver({}, 3))).rejects.toThrow('inspector reattached');
  });
});

describe('the queue drain', () => {
  afterEach(() => {
    jest.useRealTimers();
  });

  it('waits for three reads in a row with no row queued, generating or unconfirmed', async () => {
    jest.useFakeTimers();
    const reads = scripted([
      [{ id: 'a', status: TxStatus.GeneratingTransaction }],
      [{ id: 'a', status: TxStatus.Unconfirmed }],
      [{ id: 'a', status: TxStatus.Completed }],
      [{ id: 'a', status: TxStatus.Completed }],
      [{ id: 'a', status: TxStatus.Completed }]
    ]);
    const drained = waitForQueueDrained(reads.read, 60_000);
    await jest.advanceTimersByTimeAsync(10_000);
    await drained;
    expect(reads.count()).toBe(5);
  });

  it('holds a queued row as in flight', async () => {
    jest.useFakeTimers();
    const reads = scripted([
      [{ id: 'a', status: TxStatus.Queued }],
      [{ id: 'a', status: TxStatus.Completed }],
      [{ id: 'a', status: TxStatus.Completed }],
      [{ id: 'a', status: TxStatus.Completed }]
    ]);
    const drained = waitForQueueDrained(reads.read, 60_000);
    await jest.advanceTimersByTimeAsync(10_000);
    await drained;
    expect(reads.count()).toBe(4);
  });

  it('counts a failed read as not drained, and starts the clean reads again', async () => {
    jest.useFakeTimers();
    const reads = scripted([
      [{ id: 'a', status: TxStatus.Completed }],
      new Error('inspector reattached'),
      [{ id: 'a', status: TxStatus.Completed }],
      [{ id: 'a', status: TxStatus.Completed }],
      [{ id: 'a', status: TxStatus.Completed }]
    ]);
    const drained = waitForQueueDrained(reads.read, 60_000);
    await jest.advanceTimersByTimeAsync(10_000);
    await drained;
    expect(reads.count()).toBe(5);
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

  it('names the failed read when reads keep failing past its deadline', async () => {
    jest.useFakeTimers();
    const failing = waitForQueueDrained(async () => {
      throw new Error('inspector detached');
    }, 2_500);
    await Promise.all([
      expect(failing).rejects.toThrow(
        'the queue did not drain within 2500 ms: nothing, but not three reads in a row; the last failed read: inspector detached'
      ),
      jest.advanceTimersByTimeAsync(5_000)
    ]);
  });
});
