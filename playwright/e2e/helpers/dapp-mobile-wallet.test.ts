/**
 * @jest-environment node
 */
import { describeFailure } from './dapp-cells';
import { accountRows, readRows, rowUnits, waitForQueueDrained, type MobileWallet } from './dapp-mobile-wallet';
import { TxStatus, type TransactionRowSnapshot } from './history';
import { CURRENT_ACCOUNT_ROWS_JS, stashAndPoll } from './mobile-store-reads';
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
  function storeLandingOn(landsOn: number) {
    const balances: Record<string, unknown[]> = {
      acct: [{ tokenId: 'mtst1tst', metadata: { symbol: 'TST', decimals: 8 }, balance: 9 }]
    };
    const readState: {
      inFlight: boolean;
      fused: boolean;
      fuseUntilMs: number | null;
      network: string;
      lock: { label: string; pauseCount: number; normalCeilingMs: number } | null;
    } = { inFlight: false, fused: false, fuseUntilMs: null, network: 'testnet:rpc', lock: null };
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
    const win: Record<string, unknown> = {
      __TEST_STORE__: { getState: () => state },
      __TEST_BALANCE_READ_STATE__: () => readState
    };
    return { win, state, readState, fetches: () => fetches };
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

  it('reports never-landing reads with the observed account, stamps, durations and skip state', async () => {
    jest.useFakeTimers();
    const store = storeLandingOn(Infinity);
    const account = `mtst1${'a'.repeat(59)}`;
    store.state.currentAccount = { publicKey: account };
    store.state.balances[account] = store.state.balances.acct ?? [];
    store.state.balancesLastFetched[account] = 1_000;
    store.win.__TEST_BALANCE_READ_STATE__ = () => ({
      inFlight: store.fetches() % 3 === 0,
      fused: store.fetches() % 3 === 1,
      fuseUntilMs: store.fetches() % 3 === 1 ? 99_999 : null,
      network: 'testnet:rpc',
      lock: store.fetches() % 3 === 2 ? { label: 'idle-sync', pauseCount: 0, normalCeilingMs: 120_000 } : null
    });
    const failure = accountRows(walletOver(store.win)).then(
      () => 'unexpected stale rows',
      (error: unknown) => (error instanceof Error ? error.message : String(error))
    );
    await jest.advanceTimersByTimeAsync(70_000);
    const message = await failure;
    expect(message).toContain(`no balance read of ${account} landed within 60000 ms`);
    expect(message).toContain(`"observedAccount":"${account}","initialStamp":1000,"finalStamp":1000`);
    expect(message).toContain(`"account":"${account}","stamp":1000,"cached":true`);
    expect(message).toContain('"outcomeKey":["landed","in-flight","fused","lock-busy"');
    expect(message).toContain('"fuseUntilMs":99999');
    expect(message).toContain('"label":"idle-sync"');
    expect(message).toContain('"durationMs":[0');
    const persisted = describeFailure(new Error(message));
    expect(persisted.length).toBeLessThan(2_000);
    const diagnostics: unknown = JSON.parse(persisted.split('; balanceRead=')[1] ?? 'null');
    expect(diagnostics).toMatchObject({
      attempts: {
        durationMs: Array.from({ length: 60 }, () => 0),
        outcome: Array.from({ length: 60 }, (_, index) => (index % 3) + 1),
        state: Array.from({ length: 60 }, (_, index) => index % 3)
      }
    });
    expect(store.state.balances[account]).toEqual([expect.objectContaining({ balance: 9 })]);
  });

  it('accepts an already in-flight read only once its stamp advances and its fresh rows land', async () => {
    jest.useFakeTimers();
    const store = storeLandingOn(Infinity);
    store.readState.inFlight = true;
    setTimeout(() => {
      store.state.balancesLastFetched.acct = 2_000;
      store.state.balances.acct = [{ tokenId: 'mtst1tst', metadata: { symbol: 'TST', decimals: 8 }, balance: 5 }];
      store.readState.inFlight = false;
    }, 1_500);
    await Promise.all([
      expect(accountRows(walletOver(store.win))).resolves.toEqual({
        account: 'acct',
        displayFaucetId: null,
        rows: [{ tokenId: 'mtst1tst', symbol: 'TST', decimals: 8, balance: 5 }]
      }),
      jest.advanceTimersByTimeAsync(5_000)
    ]);
    expect(store.fetches()).toBe(3);
  });

  it('diagnoses a fetch still pending at 60 seconds without returning cached rows', async () => {
    jest.useFakeTimers();
    const store = storeLandingOn(Infinity);
    store.state.fetchBalances = async () => {
      store.readState.inFlight = true;
      store.readState.lock = { label: 'balances', pauseCount: 0, normalCeilingMs: 120_000 };
      return new Promise<void>(() => undefined);
    };
    const failure = accountRows(walletOver(store.win)).then(
      () => 'unexpected stale rows',
      (error: unknown) => (error instanceof Error ? error.message : String(error))
    );
    await jest.advanceTimersByTimeAsync(70_000);
    const message = await failure;
    expect(message).toContain('no balance read of acct landed within 60000 ms');
    expect(message).toContain('"initialStamp":1000,"finalStamp":1000');
    expect(message).toContain('"outcome":[6]');
    expect(message).toContain('"durationMs":[60000]');
    expect(message).toContain('"inFlight":true');
    expect(message).toContain('"label":"balances"');
  });

  it('rejects an account change during a read even when the original account gets a fresh stamp', async () => {
    jest.useFakeTimers();
    const store = storeLandingOn(Infinity);
    store.state.fetchBalances = async pk => {
      await new Promise(resolve => setTimeout(resolve, 25));
      store.state.balancesLastFetched[pk] = 2_000;
      store.state.currentAccount = { publicKey: 'other' };
    };
    await Promise.all([
      expect(accountRows(walletOver(store.win))).rejects.toThrow(
        'current account changed from acct to other during balance read'
      ),
      jest.advanceTimersByTimeAsync(2_000)
    ]);
  });

  it('rejects an account change between the landed stamp and the row projection', async () => {
    jest.useFakeTimers();
    const store = storeLandingOn(1);
    const wallet = walletOver(store.win);
    const evaluate = wallet.evalJs;
    wallet.evalJs = async <T>(js: string): Promise<T> => {
      if (js === CURRENT_ACCOUNT_ROWS_JS) store.state.currentAccount = { publicKey: 'other' };
      return evaluate<T>(js);
    };
    await Promise.all([
      expect(accountRows(wallet)).rejects.toThrow('current account changed from acct to other after balance read'),
      jest.advanceTimersByTimeAsync(2_000)
    ]);
  });

  it('rejects a late landing when a blocked page lets the deadline timer fire late', async () => {
    jest.useFakeTimers();
    const store = storeLandingOn(Infinity);
    store.state.fetchBalances = async pk => {
      jest.setSystemTime(Date.now() + 60_001);
      store.state.balancesLastFetched[pk] = 2_000;
    };
    await Promise.all([
      expect(accountRows(walletOver(store.win))).rejects.toThrow('no balance read of acct landed within 60000 ms'),
      jest.advanceTimersByTimeAsync(2_000)
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
