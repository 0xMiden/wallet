/**
 * @jest-environment node
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { CellDeadlineExceeded, DappCellRunner, deadlineIn, type JourneyRecord } from './dapp-cells';
import { registryOf } from './dapp-known-bugs';
import {
  accountRows,
  readRows,
  rowUnits,
  selectAccount,
  waitForQueueDrained,
  type MobileWallet
} from './dapp-mobile-wallet';
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

describe('account selection convergence', () => {
  beforeEach(() => {
    jest.useFakeTimers({ now: 0 });
  });
  afterEach(() => {
    jest.clearAllTimers();
    jest.useRealTimers();
  });

  function selection(land: (address: string, attempt: number) => void) {
    const accounts = [
      { publicKey: 'second', name: 'Same' },
      { publicKey: 'primary', name: 'Same' }
    ];
    const state = {
      accounts,
      currentAccount: { publicKey: 'primary' },
      updateCurrentAccount: jest.fn(async (address: string): Promise<void> => {
        land(address, state.updateCurrentAccount.mock.calls.length);
      })
    };
    return { state, wallet: walletOver({ __TEST_STORE__: { getState: () => state } }) };
  }

  it('waits for delayed exact-key success with reversed accounts and duplicate names', async () => {
    const { state, wallet } = selection(address => {
      setTimeout(() => {
        state.currentAccount = { publicKey: address };
      }, 100);
    });
    const selected = selectAccount(wallet, 'second', deadlineIn(2_000, 'M1'));
    await jest.advanceTimersByTimeAsync(1_000);
    await expect(selected).resolves.toBeUndefined();
    expect(state.currentAccount.publicKey).toBe('second');
    expect(state.updateCurrentAccount).toHaveBeenCalledTimes(1);
    expect(state.updateCurrentAccount).toHaveBeenCalledWith('second');
  });

  it('reissues selection when a fresh store read still reports the old account', async () => {
    const { state, wallet } = selection((address, attempt) => {
      if (attempt === 2) state.currentAccount = { publicKey: address };
    });
    const selected = selectAccount(wallet, 'second', deadlineIn(2_000, 'M1'));
    await jest.advanceTimersByTimeAsync(1_500);
    await expect(selected).resolves.toBeUndefined();
    expect(state.updateCurrentAccount.mock.calls).toEqual([['second'], ['second']]);
  });

  it('fails a permanent mismatch within the bound with both keys and elapsed time', async () => {
    const { wallet } = selection(() => undefined);
    const started = Date.now();
    let endedAt = -1;
    const outcome = selectAccount(wallet, 'second', deadlineIn(1_200, 'M1')).catch((error: unknown) => {
      endedAt = Date.now();
      return error;
    });
    await jest.advanceTimersByTimeAsync(1_200);
    await expect(outcome).resolves.toBeInstanceOf(CellDeadlineExceeded);
    await expect(outcome).resolves.toMatchObject({
      message: expect.stringContaining('selected primary instead of second after 1200 ms')
    });
    expect(endedAt - started).toBe(1_200);
  });

  it('races the polling wait through the supplied cell deadline and stops issuing commands', async () => {
    const { state, wallet } = selection(() => undefined);
    const deadline = deadlineIn(700, 'M1');
    const raced = jest.spyOn(deadline, 'race');
    const outcome = selectAccount(wallet, 'second', deadline).catch((error: unknown) => error);
    await jest.advanceTimersByTimeAsync(700);
    await expect(outcome).resolves.toBeInstanceOf(CellDeadlineExceeded);
    expect(raced).toHaveBeenCalledWith(expect.any(Promise), 'account selection convergence');
    const calls = state.updateCurrentAccount.mock.calls.length;
    await jest.advanceTimersByTimeAsync(2_000);
    expect(state.updateCurrentAccount).toHaveBeenCalledTimes(calls);
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

  async function recordedRead(win: Record<string, unknown>, wrap = false) {
    const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'balance-read-record-'));
    const runner = new DappCellRunner({
      outDir,
      surface: 'android',
      part: 'balance-read',
      axis: 'offchain',
      journey: 'W',
      testTitle: 'balance read',
      declared: ['W1'],
      registry: registryOf([]),
      hooks: { quiesce: async () => undefined, restore: async () => undefined }
    });
    try {
      const record = await runner.run({
        id: 'W1',
        budget: 'write',
        run: async ({ deadline }) => {
          try {
            await accountRows(walletOver(win), deadline);
          } catch (error) {
            if (wrap) throw new Error('vault check failed: ' + String(error), { cause: error });
            throw error;
          }
        }
      });
      const written: JourneyRecord = JSON.parse(fs.readFileSync(runner.file, 'utf8'));
      expect(written.cells).toEqual([record]);
      return written.cells[0];
    } finally {
      fs.rmSync(outDir, { recursive: true, force: true });
    }
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

  it('persists all 60 realistic attempts through the runner while bounding the dominant-reason error', async () => {
    jest.useFakeTimers();
    jest.setSystemTime(1_792_274_400_000);
    const store = storeLandingOn(Infinity);
    const account = 'a'.repeat(64);
    const initialStamp = Date.now() - 30_000;
    store.state.currentAccount.publicKey = account;
    const cachedRows = store.state.balances.acct;
    if (cachedRows === undefined) throw new Error('the fixture has no cached balance rows');
    store.state.balances[account] = cachedRows;
    store.state.balancesLastFetched[account] = initialStamp;
    const labels = [
      'idle-sync',
      'local-prove',
      'syncState',
      'balances',
      'getAccount',
      'consume-notes',
      'background-sync'
    ];
    const readAt = (attempt: number) => ({
      inFlight: attempt % 6 === 0,
      fused: attempt % 6 === 1,
      fuseUntilMs: attempt % 6 === 1 ? 1_792_274_700_000 : null,
      network: 'testnet:https://rpc.testnet.miden.io',
      lock: { label: labels[attempt % labels.length], pauseCount: attempt % 2, normalCeilingMs: 120_000 }
    });
    store.win.__TEST_BALANCE_READ_STATE__ = () => readAt(store.fetches());
    const fetch = store.state.fetchBalances;
    store.state.fetchBalances = async pk => {
      await fetch(pk);
      await new Promise(resolve => setTimeout(resolve, 10));
    };
    const result = recordedRead(store.win, true);
    await jest.advanceTimersByTimeAsync(70_000);
    const record = await result;
    expect(record?.verdict).toBe('fail-new');
    expect(record?.error?.length).toBeLessThan(2_000);
    expect(record?.error).toContain('no balance read of ' + account + ' landed within 60000 ms');
    expect(record?.error).toContain('account=' + account + ', initialStamp=' + initialStamp);
    expect(record?.error).toContain('finalStamp=' + initialStamp + ', attempts=60, dominant=lock-busy');
    expect(record?.evidence?.balanceRead).toEqual({
      observedAccount: account,
      initialStamp,
      finalStamp: initialStamp,
      initial: { account, stamp: initialStamp, cached: true, read: readAt(0) },
      final: { account, stamp: initialStamp, cached: true, read: readAt(60) },
      attempts: Array.from({ length: 60 }, (_, index) => ({
        number: index + 1,
        startedAt: 1_792_274_400_000 + index * 1_010,
        durationMs: 10,
        outcome: index % 6 === 0 ? 'in-flight' : index % 6 === 1 ? 'fused' : 'lock-busy',
        before: { account, stamp: initialStamp, cached: true, read: readAt(index) },
        after: { account, stamp: initialStamp, cached: true, read: readAt(index + 1) }
      }))
    });
    expect(store.state.balances[account]).toEqual([expect.objectContaining({ balance: 9 })]);
  });

  it.each(['missing', 'throwing', 'unserializable', 'malformed'])(
    'lands fresh rows when the diagnostic hook is %s',
    async hook => {
      jest.useFakeTimers();
      const store = storeLandingOn(2);
      delete store.win.__TEST_BALANCE_READ_STATE__;
      if (hook === 'throwing')
        store.win.__TEST_BALANCE_READ_STATE__ = () => {
          throw new Error('diagnostics broke');
        };
      if (hook === 'unserializable') store.win.__TEST_BALANCE_READ_STATE__ = () => 1n;
      if (hook === 'malformed') store.win.__TEST_BALANCE_READ_STATE__ = () => null;
      await Promise.all([
        expect(accountRows(walletOver(store.win))).resolves.toEqual({
          account: 'acct',
          displayFaucetId: null,
          rows: [{ tokenId: 'mtst1tst', symbol: 'TST', decimals: 8, balance: 5 }]
        }),
        jest.advanceTimersByTimeAsync(5_000)
      ]);
      expect(store.fetches()).toBe(2);
    }
  );

  it('records diagnostics unavailable without accepting a missing-hook stale read', async () => {
    jest.useFakeTimers();
    const store = storeLandingOn(Infinity);
    delete store.win.__TEST_BALANCE_READ_STATE__;
    const result = recordedRead(store.win);
    await jest.advanceTimersByTimeAsync(70_000);
    const record = await result;
    expect(record?.verdict).toBe('fail-new');
    expect(record?.error).toContain(
      'Error: stashAndPoll(__dapp_balances): no balance read of acct landed within 60000 ms'
    );
    expect(record?.error).toContain('attempts=60, dominant=diagnostics unavailable');
    expect(record?.error?.length).toBeLessThan(2_000);
    const diagnostics = record?.evidence?.balanceRead;
    expect(diagnostics?.initial.read).toBe('diagnostics unavailable');
    expect(diagnostics?.final.read).toBe('diagnostics unavailable');
    expect(diagnostics?.attempts).toHaveLength(60);
    expect(diagnostics?.attempts.map(attempt => attempt.outcome)).toEqual(Array(60).fill('diagnostics unavailable'));
    expect(store.state.balances.acct).toEqual([expect.objectContaining({ balance: 9 })]);
  });

  it('preserves the cell deadline error class without the diagnostic hook', async () => {
    jest.useFakeTimers();
    const store = storeLandingOn(Infinity);
    delete store.win.__TEST_BALANCE_READ_STATE__;
    const failure = accountRows(walletOver(store.win), deadlineIn(1_000, 'balance-read')).catch(
      (error: unknown) => error
    );
    await jest.advanceTimersByTimeAsync(2_000);
    expect(await failure).toBeInstanceOf(CellDeadlineExceeded);
    await jest.advanceTimersByTimeAsync(60_000);
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
    const result = recordedRead(store.win);
    await jest.advanceTimersByTimeAsync(70_000);
    const record = await result;
    expect(record?.error).toContain('no balance read of acct landed within 60000 ms');
    expect(record?.error).toContain('initialStamp=1000, finalStamp=1000, attempts=1, dominant=pending');
    expect(record?.evidence?.balanceRead).toMatchObject({
      initialStamp: 1_000,
      finalStamp: 1_000,
      attempts: [{ outcome: 'pending', durationMs: 60_000 }],
      final: { read: { inFlight: true, lock: { label: 'balances' } } }
    });
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
