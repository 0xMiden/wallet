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
