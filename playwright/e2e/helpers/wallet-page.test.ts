import type { Page } from '@playwright/test';

import { ChromeWalletPage } from './wallet-page';

jest.mock('@playwright/test', () => ({ expect: jest.fn() }));

function makePage(): Page {
  return {
    url: () => 'chrome-extension://test/fullpage.html#/',
    waitForFunction: jest.fn(async () => undefined),
    evaluate: jest.fn(async <T>(callback: (arg: T) => unknown, arg: T) => callback(arg))
  } as unknown as Page;
}

/**
 * `appearOnWait` models rows that have not committed when the drawer opens and arrive while the
 * helper waits. That is the real timing the stress driver hits, and the only way to tell a waiting
 * gate from a bare point-in-time count.
 */
function makeSendPage(tokenIds: string[], appearOnWait: string[] = []): { page: Page; clickedTokenIds: string[] } {
  const present = new Set(tokenIds);
  const clickedTokenIds: string[] = [];
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
    getByTestId: jest.fn(() => noopLocator),
    locator: jest.fn((selector: string) => {
      if (selector === 'body') return noopLocator;
      const match = selector.match(/^\[data-token-id=(.+)\]$/);
      const tokenId = JSON.parse(match?.[1] ?? '""') as string;
      return {
        count: jest.fn(async () => (present.has(tokenId) ? 1 : 0)),
        first: () => ({
          waitFor: jest.fn(async () => {
            if (appearOnWait.includes(tokenId)) present.add(tokenId);
          })
        }),
        locator: jest.fn(() => ({
          first: () => ({ click: jest.fn(async () => clickedTokenIds.push(tokenId)) })
        }))
      };
    })
  } as unknown as Page;

  return { page, clickedTokenIds };
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
    const { page, clickedTokenIds } = makeSendPage([], ['faucet-late']);
    const wallet = new ChromeWalletPage(page, 'test');

    await wallet.sendTokens({
      recipientAddress: 'account-b',
      amount: '1',
      isPrivate: false,
      tokenId: 'faucet-late'
    });

    expect(clickedTokenIds).toEqual(['faucet-late']);
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
