import type { Page } from '@playwright/test';

import { fakeConfirmationApp, type CreateAttemptOutcome } from './confirmation-app-fake';
import { ChromeWalletPage } from './wallet-page';

jest.mock('@playwright/test', () => ({ expect: jest.fn() }));

function makePage(): Page {
  return {
    url: () => 'chrome-extension://test/fullpage.html#/',
    waitForFunction: jest.fn(async () => undefined),
    waitForTimeout: jest.fn(async () => undefined),
    evaluate: jest.fn(async <T>(callback: (arg: T) => unknown, arg: T) => callback(arg))
  } as unknown as Page;
}

/**
 * `appearOnWait` models rows that have not committed when the drawer opens and arrive while the
 * helper waits. That is the real timing the stress driver hits, and the only way to tell a waiting
 * gate from a bare point-in-time count. `waitForError`/`countError` model the OTHER way each read
 * fails - a closed page, a destroyed execution context - which is the only way to prove the reason
 * reaches the caller instead of being swallowed into "found 0".
 */
function makeSendPage(
  tokenIds: string[],
  opts: {
    appearOnWait?: string[];
    waitForError?: string;
    countError?: string;
    tokenSymbols?: string[];
    appearSymbolOnWait?: string[];
    symbolAppearanceTimeoutMs?: number;
  } = {}
): { page: Page; clickedTokenIds: string[]; clickedTokenSymbols: string[]; symbolWaitTimeouts: number[] } {
  const appearOnWait = opts.appearOnWait ?? [];
  const present = new Set(tokenIds);
  const presentSymbols = new Set(opts.tokenSymbols ?? []);
  const clickedTokenIds: string[] = [];
  const clickedTokenSymbols: string[] = [];
  const symbolWaitTimeouts: number[] = [];
  const noopLocator = {
    waitFor: jest.fn(async () => undefined),
    fill: jest.fn(async () => undefined),
    click: jest.fn(async () => undefined),
    textContent: jest.fn(async () => ''),
    count: jest.fn(async () => 0),
    first() {
      return this;
    },
    getByTestId() {
      return this;
    }
  };
  const page = {
    url: () => 'chrome-extension://test/fullpage.html#/',
    goto: jest.fn(async () => undefined),
    waitForFunction: jest.fn(async () => undefined),
    evaluate: jest.fn(async () => undefined),
    getByTestId: jest.fn((testId: string) => {
      if (testId === 'send-token-selector' || testId === 'send-token-search') return noopLocator;
      const symbol = testId.startsWith('send-token-') ? testId.slice('send-token-'.length) : undefined;
      if (symbol === undefined) return noopLocator;
      const waitFor = jest.fn(async (options?: { timeout?: number }) => {
        const timeout = options?.timeout ?? 0;
        symbolWaitTimeouts.push(timeout);
        if (
          opts.appearSymbolOnWait?.includes(symbol) &&
          (opts.symbolAppearanceTimeoutMs === undefined || timeout >= opts.symbolAppearanceTimeoutMs)
        ) {
          presentSymbols.add(symbol);
        }
        if (!presentSymbols.has(symbol)) throw new Error(`token row ${symbol} did not attach`);
      });
      const click = jest.fn(async () => clickedTokenSymbols.push(symbol));
      return {
        waitFor,
        count: jest.fn(async () => (presentSymbols.has(symbol) ? 1 : 0)),
        first: () => ({ waitFor, click }),
        click
      };
    }),
    locator: jest.fn((selector: string) => {
      if (selector === 'body') return noopLocator;
      if (selector === '[data-testid^="send-token-"]') {
        const symbols = () => [...presentSymbols];
        return {
          count: jest.fn(async () => symbols().length),
          nth: (index: number) => {
            const symbol = symbols()[index] ?? '';
            return {
              getAttribute: jest.fn(async () => `send-token-${symbol}`),
              click: jest.fn(async () => clickedTokenSymbols.push(symbol))
            };
          },
          first: () => ({
            click: jest.fn(async () => clickedTokenSymbols.push(symbols()[0] ?? ''))
          })
        };
      }
      const match = selector.match(/^\[data-token-id=(.+)\]$/);
      const tokenId = JSON.parse(match?.[1] ?? '""') as string;
      return {
        count: jest.fn(async () => {
          if (opts.countError !== undefined) throw new Error(opts.countError);
          return present.has(tokenId) ? 1 : 0;
        }),
        first: () => ({
          waitFor: jest.fn(async () => {
            if (opts.waitForError !== undefined) throw new Error(opts.waitForError);
            if (appearOnWait.includes(tokenId)) present.add(tokenId);
          }),
          click: jest.fn(async () => clickedTokenIds.push(tokenId))
        }),
        // The picker row itself carries both data-token-id and its send-token-* test id, so
        // nothing matches beneath it: a nested lookup is the harness looking in the wrong place.
        locator: jest.fn((inner: string) => {
          throw new Error(`nested lookup "${inner}" under the token row finds nothing`);
        })
      };
    })
  } as unknown as Page;

  return { page, clickedTokenIds, clickedTokenSymbols, symbolWaitTimeouts };
}

function installBalanceState(state: Record<string, unknown>, notes: Array<Record<string, unknown>>): void {
  Object.defineProperty(window, '__TEST_STORE__', {
    configurable: true,
    value: { getState: () => state }
  });
  (jest.spyOn(chrome.storage.local, 'get') as unknown as jest.Mock).mockImplementation(
    (_keys: unknown, callback: (items: Record<string, unknown>) => void) => {
      callback({ miden_sync_data: { notes } });
    }
  );
}

describe('ChromeWalletPage balance scoping', () => {
  afterEach(() => {
    Reflect.deleteProperty(window, '__TEST_STORE__');
    Reflect.deleteProperty(window, '__TEST_BALANCE_READ_STATE__');
    jest.restoreAllMocks();
  });

  it('filters by token symbol while keeping the unscoped aggregate path', async () => {
    const state = {
      currentAccount: { publicKey: 'account-a' },
      assetsMetadata: {
        'tracked-faucet': { symbol: 'TST', decimals: 8 }
      },
      fetchBalances: jest.fn(async () => undefined),
      balances: {
        'account-a': [
          { tokenId: 'tracked-faucet', metadata: { symbol: 'TST' }, balance: 10 },
          { tokenId: 'foreign-vault-faucet', metadata: { symbol: 'FOREIGN' }, balance: 2 }
        ]
      }
    };
    installBalanceState(state, [
      {
        id: 'tracked-note',
        faucetId: 'tracked-faucet',
        amountBaseUnits: '300000000'
      },
      {
        id: 'foreign-note',
        faucetId: 'foreign-note-faucet',
        amountBaseUnits: '400000000',
        metadata: { symbol: 'FOREIGN', decimals: 8 }
      }
    ]);
    const wallet = new ChromeWalletPage(makePage(), 'test');

    await expect(wallet.getBalance('tst')).resolves.toBe(13);
    await expect(wallet.getBalance()).resolves.toBe(19);
  });

  it('uses cached metadata for consumed assets and pending notes in symbol snapshots', async () => {
    const state = {
      assetsMetadata: {
        'tracked-faucet': { symbol: 'TST', decimals: 8 },
        'foreign-faucet': { symbol: 'FOREIGN', decimals: 8 }
      },
      balances: {
        'account-a': [
          { tokenId: 'tracked-faucet', balance: 10 },
          { tokenId: 'foreign-faucet', balance: 2 }
        ]
      },
      transactions: {}
    };
    installBalanceState(state, [
      { id: 'tracked-note', faucetId: 'tracked-faucet', amountBaseUnits: '300000000' },
      { id: 'foreign-note', faucetId: 'foreign-faucet', amountBaseUnits: '400000000' }
    ]);
    const wallet = new ChromeWalletPage(makePage(), 'test');

    const snapshot = await wallet.quickBalanceSnapshot({ symbol: 'tst' });

    expect(snapshot.balance).toBe(10);
    expect(snapshot.pendingSum).toBe(3);
    expect(snapshot.totalReportable).toBe(13);
    expect(snapshot).not.toHaveProperty('unidentified');
  });

  it('refreshes before delegating getBalance to the shared snapshot path', async () => {
    const state = {
      currentAccount: { publicKey: 'account-a' },
      assetsMetadata: { 'tracked-faucet': { symbol: 'TST', decimals: 8 } },
      balances: { 'account-a': [{ tokenId: 'tracked-faucet', balance: 1 }] },
      transactions: {},
      fetchBalances: jest.fn(async () => {
        state.balances['account-a'] = [{ tokenId: 'tracked-faucet', balance: 10 }];
      })
    };
    installBalanceState(state, [{ id: 'tracked-note', faucetId: 'tracked-faucet', amountBaseUnits: '300000000' }]);
    const wallet = new ChromeWalletPage(makePage(), 'test');
    const snapshotSpy = jest.spyOn(wallet, 'quickBalanceSnapshot');

    await expect(wallet.getBalance('tst')).resolves.toBe(13);

    expect(state.fetchBalances).toHaveBeenCalledWith('account-a', state.assetsMetadata);
    expect(snapshotSpy).toHaveBeenCalledWith({ symbol: 'tst' });
    expect(state.fetchBalances.mock.invocationCallOrder[0]!).toBeLessThan(snapshotSpy.mock.invocationCallOrder[0]!);
  });

  it('does not treat a skipped in-flight refresh as a landed post-claim vault', async () => {
    const readState = { inFlight: true };
    const state = {
      currentAccount: { publicKey: 'account-a' },
      assetsMetadata: {},
      balancesLastFetched: { 'account-a': 1 },
      balances: { 'account-a': [{ tokenId: 'native-faucet', balance: 100 }] },
      fetchBalances: jest.fn(async () => {
        if (readState.inFlight) return;
        state.balances['account-a'] = [{ tokenId: 'native-faucet', balance: 10 }];
        state.balancesLastFetched['account-a'] = 2;
      })
    };
    installBalanceState(state, []);
    Object.defineProperty(window, '__TEST_BALANCE_READ_STATE__', {
      configurable: true,
      value: (account: string) => (account === 'account-a' ? readState : { inFlight: false })
    });
    const wallet = new ChromeWalletPage(makePage(), 'test');
    setTimeout(() => {
      readState.inFlight = false;
    }, 0);

    await wallet.refreshBalances();

    expect(state.balances['account-a'][0]?.balance).toBe(10);
  });

  it('rejects when an idle-started refresh returns without landing', async () => {
    const state = {
      currentAccount: { publicKey: 'account-a' },
      assetsMetadata: {},
      balancesLastFetched: { 'account-a': 1 },
      balances: { 'account-a': [{ tokenId: 'native-faucet', balance: 100 }] },
      fetchBalances: jest.fn(async () => undefined)
    };
    installBalanceState(state, []);
    Object.defineProperty(window, '__TEST_BALANCE_READ_STATE__', {
      configurable: true,
      value: (account: string) => (account === 'account-a' ? { inFlight: false } : { inFlight: false })
    });
    const wallet = new ChromeWalletPage(makePage(), 'test');

    await expect(wallet.refreshBalances()).rejects.toThrow();
  });

  it('retries waitForBalanceAbove when a skipped refresh does not land', async () => {
    const wallet = new ChromeWalletPage(makePage(), 'test');
    jest.spyOn(wallet, 'triggerSync').mockResolvedValue(undefined);
    jest
      .spyOn(wallet, 'getBalance')
      .mockRejectedValueOnce(new Error('refreshBalances did not land for account-a'))
      .mockResolvedValueOnce(5);

    await expect(wallet.waitForBalanceAbove(1, 10_000)).resolves.toBe(5);
  });

  it('retries refreshBalancesLanded when an idle-started refresh does not land', async () => {
    let fetches = 0;
    const state = {
      currentAccount: { publicKey: 'account-a' },
      assetsMetadata: {},
      balancesLastFetched: { 'account-a': 1 },
      balances: { 'account-a': [{ tokenId: 'native-faucet', balance: 100 }] },
      fetchBalances: jest.fn(async () => {
        fetches += 1;
        if (fetches === 1) return;
        state.balances['account-a'] = [{ tokenId: 'native-faucet', balance: 10 }];
        state.balancesLastFetched['account-a'] = 2;
      })
    };
    installBalanceState(state, []);
    Object.defineProperty(window, '__TEST_BALANCE_READ_STATE__', {
      configurable: true,
      value: (account: string) => (account === 'account-a' ? { inFlight: false } : { inFlight: false })
    });
    const wallet = new ChromeWalletPage(makePage(), 'test');

    await wallet.refreshBalancesLanded(10_000);

    expect(state.balances['account-a'][0]?.balance).toBe(10);
  });

  it('rejects when a refresh stays in flight past the timeout', async () => {
    const state = {
      currentAccount: { publicKey: 'account-a' },
      assetsMetadata: {},
      balancesLastFetched: { 'account-a': 1 },
      balances: { 'account-a': [{ tokenId: 'native-faucet', balance: 100 }] },
      fetchBalances: jest.fn(async () => undefined)
    };
    installBalanceState(state, []);
    Object.defineProperty(window, '__TEST_BALANCE_READ_STATE__', {
      configurable: true,
      value: (account: string) => (account === 'account-a' ? { inFlight: true } : { inFlight: false })
    });
    const wallet = new ChromeWalletPage(makePage(), 'test');
    const started = Date.now();

    await expect(wallet.refreshBalancesLanded(1_000)).rejects.toThrow('refreshBalances did not land');
    expect(Date.now() - started).toBeLessThan(2_000);
    expect(state.fetchBalances).not.toHaveBeenCalled();
  });

  it('rejects waitForBalanceAbove when a refresh stays in flight past the timeout', async () => {
    const state = {
      currentAccount: { publicKey: 'account-a' },
      assetsMetadata: {},
      balancesLastFetched: { 'account-a': 1 },
      balances: { 'account-a': [{ tokenId: 'native-faucet', balance: 100 }] },
      fetchBalances: jest.fn(async () => undefined)
    };
    installBalanceState(state, []);
    Object.defineProperty(window, '__TEST_BALANCE_READ_STATE__', {
      configurable: true,
      value: (account: string) => (account === 'account-a' ? { inFlight: true } : { inFlight: false })
    });
    const wallet = new ChromeWalletPage(makePage(), 'test');
    jest.spyOn(wallet, 'triggerSync').mockResolvedValue(undefined);
    const started = Date.now();

    await expect(wallet.waitForBalanceAbove(1, 1_000)).rejects.toThrow();
    expect(Date.now() - started).toBeLessThan(2_000);
  });

  it('rejects when an idle-started fetch never settles past the timeout', async () => {
    const state = {
      currentAccount: { publicKey: 'account-a' },
      assetsMetadata: {},
      balancesLastFetched: { 'account-a': 1 },
      balances: { 'account-a': [{ tokenId: 'native-faucet', balance: 100 }] },
      fetchBalances: jest.fn(() => new Promise(() => undefined))
    };
    installBalanceState(state, []);
    Object.defineProperty(window, '__TEST_BALANCE_READ_STATE__', {
      configurable: true,
      value: (account: string) => (account === 'account-a' ? { inFlight: false } : { inFlight: false })
    });
    const wallet = new ChromeWalletPage(makePage(), 'test');
    const started = Date.now();

    await expect(wallet.refreshBalancesLanded(1_000)).rejects.toThrow('refreshBalances did not land');
    expect(Date.now() - started).toBeLessThan(2_000);
  });

  it('rejects when a fetch with no idle hook never settles past the timeout', async () => {
    const state = {
      currentAccount: { publicKey: 'account-a' },
      assetsMetadata: {},
      balancesLastFetched: { 'account-a': 1 },
      balances: { 'account-a': [{ tokenId: 'native-faucet', balance: 100 }] },
      fetchBalances: jest.fn(() => new Promise(() => undefined))
    };
    installBalanceState(state, []);
    const wallet = new ChromeWalletPage(makePage(), 'test');
    const started = Date.now();

    await expect(wallet.refreshBalancesLanded(1_000)).rejects.toThrow('refreshBalances did not land');
    expect(Date.now() - started).toBeLessThan(2_000);
  });

  it('caps waitForBalanceAbove retry sleep to remaining time', async () => {
    const page = makePage();
    (page.waitForTimeout as jest.Mock).mockImplementation(
      (ms: number) => new Promise(resolve => setTimeout(resolve, ms))
    );
    const wallet = new ChromeWalletPage(page, 'test');
    jest.spyOn(wallet, 'triggerSync').mockResolvedValue(undefined);
    jest.spyOn(wallet, 'getBalance').mockImplementation(async () => {
      await new Promise(resolve => setTimeout(resolve, 2_000));
      throw new Error('refreshBalances did not land for account-a');
    });

    await expect(wallet.waitForBalanceAbove(1, 6_000)).rejects.toThrow();
    expect((page.waitForTimeout as jest.Mock).mock.calls[0]?.[0]).toBeLessThan(5_000);
  }, 15_000);

  it('delegates an unscoped getBalance call without inventing a filter', async () => {
    const state = {
      currentAccount: { publicKey: 'account-a' },
      assetsMetadata: {},
      balances: { 'account-a': [] },
      transactions: {},
      fetchBalances: jest.fn(async () => undefined)
    };
    installBalanceState(state, []);
    const wallet = new ChromeWalletPage(makePage(), 'test');
    const snapshotSpy = jest.spyOn(wallet, 'quickBalanceSnapshot');

    await wallet.getBalance();

    expect(snapshotSpy).toHaveBeenCalledWith(undefined);
  });

  it('isolates an exact faucet when another faucet uses the same symbol', async () => {
    const state = {
      balances: {
        'account-a': [
          { tokenId: 'tracked-faucet', metadata: { symbol: 'TST' }, balance: 10 },
          { tokenId: 'same-symbol-foreign-faucet', metadata: { symbol: 'TST' }, balance: 2 }
        ]
      },
      transactions: {}
    };
    installBalanceState(state, [
      {
        id: 'tracked-note',
        faucetId: 'tracked-faucet',
        amountBaseUnits: '300000000',
        metadata: { symbol: 'TST', decimals: 8 }
      },
      {
        id: 'same-symbol-foreign-note',
        faucetId: 'same-symbol-foreign-faucet',
        amountBaseUnits: '400000000',
        metadata: { symbol: 'TST', decimals: 8 }
      }
    ]);
    const wallet = new ChromeWalletPage(makePage(), 'test');

    const snapshot = await wallet.quickBalanceSnapshot({ faucetId: 'tracked-faucet' });
    const allAssets = await wallet.quickBalanceSnapshot();

    expect(snapshot.balance).toBe(10);
    expect(snapshot.pendingSum).toBe(3);
    expect(snapshot.totalReportable).toBe(13);
    expect(allAssets.totalReportable).toBe(19);
  });
});

describe('ChromeWalletPage exact token selection', () => {
  it('waits for the requested symbol row and never selects a different token', async () => {
    const { page, clickedTokenSymbols, symbolWaitTimeouts } = makeSendPage([], {
      tokenSymbols: ['OTHER'],
      appearSymbolOnWait: ['TST'],
      symbolAppearanceTimeoutMs: 25_000
    });
    const wallet = new ChromeWalletPage(page, 'test');

    await wallet.sendTokens({ recipientAddress: 'account-b', amount: '1', isPrivate: false, tokenSymbol: 'TST' });

    expect(symbolWaitTimeouts).toContain(30_000);
    expect(clickedTokenSymbols).toEqual(['TST']);
  });

  it('fails when the requested symbol is absent instead of selecting a different token', async () => {
    const { page, clickedTokenSymbols } = makeSendPage([], { tokenSymbols: ['OTHER'] });
    const wallet = new ChromeWalletPage(page, 'test');

    await expect(
      wallet.sendTokens({ recipientAddress: 'account-b', amount: '1', isPrivate: false, tokenSymbol: 'TST' })
    ).rejects.toThrow('symbol "TST"');
    expect(clickedTokenSymbols).toEqual([]);
  });

  it('selects the requested token id when two rows share a symbol', async () => {
    const { page, clickedTokenIds } = makeSendPage(['faucet-a', 'faucet-b']);
    const wallet = new ChromeWalletPage(page, 'test');

    await wallet.sendTokens({
      recipientAddress: 'account-b',
      amount: '1',
      isPrivate: false,
      tokenId: 'faucet-b'
    });

    expect(clickedTokenIds).toEqual(['faucet-b']);
  });

  it('waits for a row that commits after the drawer opens', async () => {
    const { page, clickedTokenIds } = makeSendPage([], { appearOnWait: ['faucet-late'] });
    const wallet = new ChromeWalletPage(page, 'test');

    await wallet.sendTokens({
      recipientAddress: 'account-b',
      amount: '1',
      isPrivate: false,
      tokenId: 'faucet-late'
    });

    expect(clickedTokenIds).toEqual(['faucet-late']);
  });

  it('names why the wait failed instead of reporting an empty row set', async () => {
    const closed = 'Target page, context or browser has been closed';
    const { page, clickedTokenIds } = makeSendPage([], { waitForError: closed });
    const wallet = new ChromeWalletPage(page, 'test');

    await expect(
      wallet.sendTokens({ recipientAddress: 'account-b', amount: '1', isPrivate: false, tokenId: 'faucet-a' })
    ).rejects.toThrow(closed);
    expect(clickedTokenIds).toEqual([]);
  });

  it('names why the count failed even when the row attached', async () => {
    const destroyed = 'Execution context was destroyed';
    const { page } = makeSendPage(['faucet-a'], { countError: destroyed });
    const wallet = new ChromeWalletPage(page, 'test');

    await expect(
      wallet.sendTokens({ recipientAddress: 'account-b', amount: '1', isPrivate: false, tokenId: 'faucet-a' })
    ).rejects.toThrow(destroyed);
  });

  it('fails instead of falling back when the requested token id is absent', async () => {
    const { page, clickedTokenIds } = makeSendPage(['faucet-a']);
    const wallet = new ChromeWalletPage(page, 'test');

    await expect(
      wallet.sendTokens({
        recipientAddress: 'account-b',
        amount: '1',
        isPrivate: false,
        tokenId: 'missing-faucet'
      })
    ).rejects.toThrow('missing-faucet');
    expect(clickedTokenIds).toEqual([]);
  });
});

// A create whose first sync failed sat on Confirmation's failure screen until the 120 s Ready wait ran out, as on iOS.
describe('ChromeWalletPage.waitForCreatedWalletReady', () => {
  afterEach(() => jest.useRealTimers());

  /** A Playwright page over the shared Confirmation fake: `evaluate` runs the page function in its WebView. */
  function confirmationPage(
    outcomes: CreateAttemptOutcome[],
    failRead: () => string | undefined = () => undefined
  ): { page: Page; clicks: number[] } {
    const { evalJs, clicks } = fakeConfirmationApp(outcomes);
    const page = {
      evaluate: jest.fn(async (fn: (arg?: unknown) => unknown, arg?: unknown) => {
        const failure = failRead();
        if (failure !== undefined) throw new Error(failure);
        return evalJs(`return (${fn.toString()})(${JSON.stringify(arg) ?? ''});`);
      }),
      locator: jest.fn((selector: string) => ({
        click: jest.fn(async () => {
          await evalJs(`document.querySelector(${JSON.stringify(selector)}).click();`);
        })
      })),
      waitForTimeout: jest.fn((ms: number) => new Promise(resolve => setTimeout(resolve, ms)))
    } as unknown as Page;
    return { page, clicks };
  }

  async function outcomeOf(page: Page, timeoutMs = 120_000): Promise<{ settled: boolean; outcome: string }> {
    const wallet = new ChromeWalletPage(page, 'test');
    jest.useFakeTimers();
    let settled = false;
    const outcome = (
      wallet as unknown as { waitForCreatedWalletReady(label: string, timeoutMs: number): Promise<void> }
    )
      .waitForCreatedWalletReady('create(offchain)', timeoutMs)
      .then(
        () => 'ready',
        (error: unknown) => (error instanceof Error ? error.message : String(error))
      )
      .finally(() => (settled = true));
    await jest.advanceTimersByTimeAsync(10_000);
    return { settled, outcome: settled ? await outcome : 'pending' };
  }

  it('waits for the home surface without pressing anything when the create succeeds', async () => {
    const { page, clicks } = confirmationPage(['ready']);

    await expect(outcomeOf(page)).resolves.toEqual({ settled: true, outcome: 'ready' });
    expect(clicks).toEqual([]);
  });

  it("presses the app's Retry once on the first failure screen and keeps waiting for the home surface", async () => {
    const { page, clicks } = confirmationPage(['fails', 'ready']);

    await expect(outcomeOf(page)).resolves.toEqual({ settled: true, outcome: 'ready' });
    expect(clicks).toEqual([0]);
  });

  it('fails at once, with the screen text, when the Retry fails too', async () => {
    const { page, clicks } = confirmationPage(['fails', 'fails', 'ready']);

    await expect(outcomeOf(page)).resolves.toEqual({
      settled: true,
      outcome:
        'create(offchain): wallet creation failed again after one Retry: ' +
        'Something went wrong Failed to sync state: RPC deadline exceeded Retry'
    });
    expect(clicks).toEqual([0]);
  });

  it('counts a read that failed as not yet', async () => {
    let failures = 2;
    const { page, clicks } = confirmationPage(['ready'], () =>
      failures-- > 0 ? 'Execution context was destroyed' : undefined
    );

    await expect(outcomeOf(page)).resolves.toEqual({ settled: true, outcome: 'ready' });
    expect(clicks).toEqual([]);
  });

  it('names the last read when it failed and the wait runs out', async () => {
    const { page } = confirmationPage(['ready'], () => 'Target page, context or browser has been closed');

    await expect(outcomeOf(page, 5_000)).resolves.toEqual({
      settled: true,
      outcome:
        'create(offchain): the created wallet was not ready within 5000ms ' +
        '(last read failed: Target page, context or browser has been closed)'
    });
  });

  it('keeps the plain timeout when only an earlier read failed', async () => {
    let failures = 2;
    const { page } = confirmationPage(['creating'], () =>
      failures-- > 0 ? 'Execution context was destroyed' : undefined
    );

    await expect(outcomeOf(page, 5_000)).resolves.toEqual({
      settled: true,
      outcome: 'create(offchain): the created wallet was not ready within 5000ms'
    });
  });
});

describe('ChromeWalletPage create paths', () => {
  const SUBMIT_CLICK = 'click [data-testid="onboarding-confirmation-submit"]';
  const ACCOUNT = { publicKey: 'mtst1qcreated' };
  const KEY_PAIR = `${'1'.padStart(64, '0')}:${'2'.padStart(64, '0')}`;

  /** What a Ready check reads: the store's state, and whether the home page is in the document. */
  type ReadyFixture = { store?: Record<string, unknown>; home?: boolean };

  afterEach(() => {
    Reflect.deleteProperty(window, '__TEST_STORE__');
    document.body.innerHTML = '';
  });

  /** Every step before Confirmation passes; the log keeps each click and the poll, in order. */
  function createPathPage(log: string[]): Page {
    const locator = (selector: string): Record<string, unknown> => {
      const self: Record<string, unknown> = {
        waitFor: jest.fn(async () => undefined),
        fill: jest.fn(async () => undefined),
        setInputFiles: jest.fn(async () => undefined),
        textContent: jest.fn(async () => ''),
        click: jest.fn(async () => {
          log.push(`click ${selector}`);
        }),
        isVisible: jest.fn(async () => document.querySelector(selector) !== null),
        or: () => self,
        first: () => self
      };
      return self;
    };
    return {
      url: () => 'chrome-extension://test/fullpage.html#/',
      isClosed: () => false,
      goto: jest.fn(async () => undefined),
      evaluate: jest.fn(async <T>(callback: (arg: T) => unknown, arg: T) => callback(arg)),
      getByTestId: jest.fn((id: string) => locator(`[data-testid="${id}"]`)),
      getByRole: jest.fn((role: string) => locator(role)),
      locator: jest.fn((selector: string) => locator(selector))
    } as unknown as Page;
  }

  async function readsReady(isReady: () => Promise<boolean>, fixture: ReadyFixture): Promise<boolean> {
    if (fixture.store) {
      const state = fixture.store;
      Object.defineProperty(window, '__TEST_STORE__', { configurable: true, value: { getState: () => state } });
    }
    document.body.innerHTML = fixture.home ? '<div data-testid="explore-page"></div>' : '';
    try {
      return await isReady();
    } finally {
      Reflect.deleteProperty(window, '__TEST_STORE__');
      document.body.innerHTML = '';
    }
  }

  it.each([
    {
      path: 'createWalletViaBypass',
      run: (wallet: ChromeWalletPage) => wallet.createNewWallet('Test1234!'),
      label: 'ChromeWalletPage.createWalletViaBypass(offchain)',
      ready: [{ store: { currentAccount: ACCOUNT } }, { home: true }],
      notReady: [{}, { store: { currentAccount: null } }]
    },
    {
      path: 'recoverGuardianFromHotKey',
      run: (wallet: ChromeWalletPage) => wallet.recoverGuardianFromHotKey(KEY_PAIR),
      label: 'ChromeWalletPage.recoverGuardianFromHotKey',
      ready: [{ store: { currentAccount: ACCOUNT } }, { home: true }],
      notReady: [{}, { store: { currentAccount: null } }]
    },
    {
      path: 'createGuardianWalletViaUi',
      run: (wallet: ChromeWalletPage) => wallet.createGuardianWalletViaUi('Test1234!', 'http://guardian.test'),
      label: 'ChromeWalletPage.createGuardianWalletViaUi',
      ready: [{ home: true }],
      notReady: [{}, { store: { currentAccount: ACCOUNT, accounts: [ACCOUNT] } }]
    },
    {
      path: 'restoreEncryptedWalletFile',
      run: (wallet: ChromeWalletPage) =>
        wallet.restoreEncryptedWalletFile({
          backupPath: 'backup.json',
          filePassword: 'file',
          newWalletPassword: 'new'
        }),
      label: 'ChromeWalletPage.restoreEncryptedWalletFile',
      ready: [{ store: { currentAccount: ACCOUNT, accounts: [ACCOUNT] } }],
      notReady: [{}, { store: { currentAccount: ACCOUNT, accounts: [] } }, { home: true }]
    }
  ])(
    "$path runs the Retry-aware wait after Confirmation's button, with its own Ready check",
    async ({ run, label, ready, notReady }) => {
      const log: string[] = [];
      const wallet = new ChromeWalletPage(createPathPage(log), 'test');
      const waitForCreatedWalletReady = jest.spyOn(
        wallet as unknown as { waitForCreatedWalletReady(label: string, timeoutMs: number): Promise<void> },
        'waitForCreatedWalletReady'
      );
      const pollCreatedWalletState = jest.fn(async (..._args: unknown[]) => {
        log.push('poll');
        throw new Error('stopped at the poll');
      });
      Object.assign(wallet as unknown as Record<string, unknown>, { pollCreatedWalletState });

      await expect(run(wallet)).rejects.toThrow('stopped at the poll');

      expect(log.slice(-2)).toEqual([SUBMIT_CLICK, 'poll']);
      expect(waitForCreatedWalletReady).toHaveBeenCalledTimes(1);
      expect(waitForCreatedWalletReady.mock.calls[0]?.slice(0, 2)).toEqual([label, 120_000]);
      const [polledLabel, isReady, timeoutMs] = pollCreatedWalletState.mock.calls[0] as [
        string,
        () => Promise<boolean>,
        number
      ];
      expect([polledLabel, timeoutMs]).toEqual([label, 120_000]);
      for (const fixture of ready as ReadyFixture[]) {
        await expect(readsReady(isReady, fixture)).resolves.toBe(true);
      }
      for (const fixture of notReady as ReadyFixture[]) {
        await expect(readsReady(isReady, fixture)).resolves.toBe(false);
      }
    }
  );
});

describe('ChromeWalletPage.openImportSeedPhraseScreen', () => {
  afterEach(() => {
    document.body.innerHTML = '';
  });

  interface RecordedControl {
    waitFor: jest.Mock;
    click: jest.Mock;
    isVisible: jest.Mock;
    or(other: { isVisible(): Promise<boolean> }): RecordedUnion;
  }

  interface RecordedUnion extends RecordedControl {
    first(): RecordedUnion;
  }

  /**
   * Records clicks. A control that is not in the document cannot be waited on or clicked, and
   * `or` is visible when either side is. A mainnet Welcome has no `#import-link`, so a helper
   * that only waits for that link fails here. Selectors in `hang` append themselves to `pending`
   * and never settle their own `waitFor`; `isVisible` still reports the document. `or().first()`
   * is that same combined locator, and its `waitFor` resolves when either side is visible without
   * calling either side's `waitFor`.
   */
  function pageRecording(log: string[], hang: ReadonlySet<string> = new Set(), pending: string[] = []): Page {
    const locator = (selector: string): RecordedControl => {
      const present = () => document.querySelector(selector) !== null;
      const api: RecordedControl = {
        waitFor: jest.fn(async () => {
          if (hang.has(selector)) {
            pending.push(selector);
            await new Promise<void>(() => undefined);
            return;
          }
          if (!present()) throw new Error(`not visible: ${selector}`);
        }),
        click: jest.fn(async () => {
          if (!present()) throw new Error(`not clickable: ${selector}`);
          log.push(`click ${selector}`);
        }),
        isVisible: jest.fn(async () => present()),
        or(other) {
          const combined: RecordedUnion = {
            waitFor: jest.fn(async () => {
              if (present() || (await other.isVisible())) return;
              throw new Error(`not visible: ${selector}`);
            }),
            isVisible: jest.fn(async () => present() || (await other.isVisible())),
            click: api.click,
            or(otherControl) {
              return api.or(otherControl);
            },
            first() {
              return this;
            }
          };
          return combined;
        }
      };
      return api;
    };
    return {
      goto: jest.fn(async () => undefined),
      getByTestId: jest.fn((id: string) => locator(`[data-testid="${id}"]`)),
      locator: jest.fn((selector: string) => locator(selector))
    } as unknown as Page;
  }

  it('recovers from the test-network Welcome and acknowledges the network notice', async () => {
    document.body.innerHTML = [
      '<div data-testid="onboarding-welcome"></div>',
      '<a id="import-link"></a>',
      '<button data-testid="onboarding-network-notice-acknowledge"></button>',
      '<div data-testid="import-select-type"></div>',
      '<button data-testid="import-type-seed-phrase"></button>',
      '<div data-testid="import-seed-phrase"></div>'
    ].join('');
    const log: string[] = [];
    await new ChromeWalletPage(pageRecording(log), 'test').openImportSeedPhraseScreen();
    expect(log).toEqual([
      'click #import-link',
      'click [data-testid="onboarding-network-notice-acknowledge"]',
      'click [data-testid="import-type-seed-phrase"]'
    ]);
  });

  it('recovers a mainnet account from Welcome, with no network notice', async () => {
    document.body.innerHTML = [
      '<div data-testid="onboarding-welcome"></div>',
      '<button data-testid="onboarding-no-code"></button>',
      '<button id="import-link"></button>',
      '<div data-testid="import-select-type"></div>',
      '<button data-testid="import-type-seed-phrase"></button>',
      '<div data-testid="import-seed-phrase"></div>'
    ].join('');
    const log: string[] = [];
    await new ChromeWalletPage(pageRecording(log), 'test').openImportSeedPhraseScreen();
    expect(log).toEqual(['click #import-link', 'click [data-testid="import-type-seed-phrase"]']);
  });

  it('does not leave the unselected import control waiting', async () => {
    document.body.innerHTML = [
      '<div data-testid="onboarding-welcome"></div>',
      '<button data-testid="onboarding-no-code"></button>',
      '<button id="import-link"></button>',
      '<div data-testid="import-select-type"></div>',
      '<button data-testid="import-type-seed-phrase"></button>',
      '<div data-testid="import-seed-phrase"></div>'
    ].join('');
    const log: string[] = [];
    const pending: string[] = [];
    await new ChromeWalletPage(
      pageRecording(
        log,
        new Set(['[data-testid="onboarding-no-code"]', '[data-testid="onboarding-network-notice-acknowledge"]']),
        pending
      ),
      'test'
    ).openImportSeedPhraseScreen();
    expect(pending).toEqual([]);
    expect(log).toEqual(['click #import-link', 'click [data-testid="import-type-seed-phrase"]']);
  });
});
