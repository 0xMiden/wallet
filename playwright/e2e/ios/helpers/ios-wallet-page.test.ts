/**
 * @jest-environment node
 */
import type { CdpSession } from './cdp-bridge';
import { IosWalletPage, routeOf } from './ios-wallet-page';
import type { SimulatorControl } from './simulator-control';
import { readTransactionRowsInPage } from '../../helpers/history';

describe('IosWalletPage.screenshot', () => {
  it('runs the before-capture hook before it shoots', async () => {
    const order: string[] = [];
    const sim = {
      screenshot: jest.fn(async () => {
        order.push('shot');
      })
    } as unknown as SimulatorControl;
    const page = new IosWalletPage({
      cdp: {} as CdpSession,
      sim,
      udid: 'udid',
      bundleId: 'bundle',
      beforeCapture: async () => {
        order.push('gate');
      }
    });

    await page.screenshot({ path: 'shot.png' });

    expect(order).toEqual(['gate', 'shot']);
  });

  it('shoots without a hook', async () => {
    const screenshot = jest.fn(async () => undefined);
    const page = new IosWalletPage({
      cdp: {} as CdpSession,
      sim: { screenshot } as unknown as SimulatorControl,
      udid: 'udid',
      bundleId: 'bundle'
    });

    await page.screenshot({ path: 'shot.png' });

    expect(screenshot).toHaveBeenCalledWith('udid', 'shot.png');
  });
});

describe('IosWalletPage.prepareSendReview', () => {
  it('scopes shared amount controls to the Send flow', async () => {
    const evalJs = jest.fn(async () => true);
    const page = new IosWalletPage({
      cdp: { eval: evalJs } as unknown as CdpSession,
      sim: {} as SimulatorControl,
      udid: 'udid',
      bundleId: 'bundle'
    });
    const pollForSelector = jest.fn(async () => undefined);
    const click = jest.fn(async () => undefined);
    Object.assign(page as unknown as Record<string, unknown>, {
      navigateTo: jest.fn(async () => undefined),
      pollForSelector,
      pollForCondition: jest.fn(async () => undefined),
      fillInput: jest.fn(async () => undefined),
      click,
      clickWhenEnabled: jest.fn(async () => undefined)
    });

    await page.prepareSendReview({
      recipientAddress: 'mtst1recipient',
      amount: '2',
      tokenSymbol: 'TST',
      isPrivate: false
    });

    const sendFlow = '[data-testid="send-flow"]';
    expect(pollForSelector).toHaveBeenCalledWith(`${sendFlow} [data-testid="send-token-selector"]`, 15_000);
    expect(click).toHaveBeenCalledWith(`${sendFlow} [data-testid="send-token-selector"]`);
    expect(pollForSelector).toHaveBeenCalledWith(`${sendFlow} [data-testid="send-amount-input"]`, 30_000);
    expect(pollForSelector).toHaveBeenCalledWith('[data-testid="send-review-submit"]', 45_000);
  });
});

// /bridge/deposit slides over the Home tabs, which stay mounted (inert) earlier in the DOM; their Swap pane reuses the
// bridge form's test ids, so an unscoped lookup clicked the hidden Swap "You Pay" selector (live run 38087775886).
describe('IosWalletPage bridge deposit helpers', () => {
  it('scopes shared amount controls to the bridge page layer', async () => {
    const page = new IosWalletPage({
      cdp: { eval: jest.fn(async () => true) } as unknown as CdpSession,
      sim: {} as SimulatorControl,
      udid: 'udid',
      bundleId: 'bundle'
    });
    const waitFor = jest.fn(async () => undefined);
    const click = jest.fn(async () => undefined);
    const pollForSelector = jest.fn(async () => undefined);
    const fillInput = jest.fn(async () => undefined);
    const clickWhenEnabled = jest.fn(async () => undefined);
    Object.assign(page as unknown as Record<string, unknown>, {
      navigateTo: jest.fn(async () => undefined),
      waitFor,
      click,
      pollForSelector,
      fillInput,
      clickWhenEnabled
    });

    await page.openBridgeDeposit();
    await page.selectBridgeToken('CIRCLE_USDC');
    await page.enterBridgeAmount('0.01');

    const bridge = '[data-page-layer="/bridge/deposit"]';
    expect(waitFor).toHaveBeenCalledWith(`${bridge} [data-testid="send-token-selector"]`, { timeoutMs: 8_000 });
    expect(click).toHaveBeenCalledWith(`${bridge} [data-testid="send-token-selector"]`);
    // The token drawer portals to <body>, outside the layer.
    expect(click).toHaveBeenCalledWith('[data-testid="bridge-token-CIRCLE_USDC"]');
    expect(pollForSelector).toHaveBeenCalledWith(`${bridge} [data-testid="send-amount-input"]`, 15_000);
    expect(fillInput).toHaveBeenCalledWith(`${bridge} [data-testid="send-amount-input"]`, '0.01');
    expect(clickWhenEnabled).toHaveBeenCalledWith(`${bridge} [data-testid="send-amount-confirm"]`, 15_000);
    const unscoped = [...waitFor.mock.calls, ...click.mock.calls, ...pollForSelector.mock.calls]
      .map(call => String((call as unknown[])[0]))
      .filter(
        selector => /send-(token-selector|amount-input|amount-confirm)/.test(selector) && !selector.startsWith(bridge)
      );
    expect(unscoped).toEqual([]);
  });
});

describe('IosWalletPage.hexToBech32Faucet', () => {
  it('passes only the hex id to the wallet-owned network-aware hook', async () => {
    const evalJs = jest.fn(async (_script: string) => 'mlcl1tracked');
    const page = new IosWalletPage({
      cdp: { eval: evalJs } as unknown as CdpSession,
      sim: {} as SimulatorControl,
      udid: 'udid',
      bundleId: 'bundle'
    });

    await expect(page.hexToBech32Faucet('0xtracked')).resolves.toBe('mlcl1tracked');

    expect(evalJs).toHaveBeenCalledTimes(1);
    const script = evalJs.mock.calls[0]![0];
    expect(script).toContain('window.__TEST_HEX_TO_BECH32_FAUCET__("0xtracked")');
    expect(script).not.toMatch(/testnet|devnet/);
  });

  it('injects metadata through the same hex-only hook contract', async () => {
    const evalJs = jest.fn(async (script: string) => {
      if (script.includes('typeof window.__TEST_HEX_TO_BECH32_FAUCET__')) return true;
      return { before: [], injected: ['mlcl1tracked'], after: ['mlcl1tracked'] };
    });
    const page = new IosWalletPage({
      cdp: { eval: evalJs } as unknown as CdpSession,
      sim: {} as SimulatorControl,
      udid: 'udid',
      bundleId: 'bundle'
    });

    await (
      page as unknown as { injectTestMetadataForFaucets(ids: string[]): Promise<void> }
    ).injectTestMetadataForFaucets(['0xtracked']);

    const injectionScript = evalJs.mock.calls.find(([script]) => script.includes('var conv'))?.[0];
    expect(injectionScript).toContain('.map(hex => conv(hex))');
    expect(injectionScript).not.toMatch(/testnet|devnet/);
  });
});

function pageWith(evalJs: (js: string) => Promise<unknown>): IosWalletPage {
  return new IosWalletPage({
    cdp: { eval: evalJs } as unknown as CdpSession,
    sim: {} as SimulatorControl,
    udid: 'udid',
    bundleId: 'bundle'
  });
}

describe('IosWalletPage row reads', () => {
  it('runs the extension projection in the WebView through the stash, and deletes the stash it read', async () => {
    const bodies: string[] = [];
    const page = pageWith(async js => {
      bodies.push(js);
      return bodies.length === 1 ? null : { ok: true, v: [{ id: 'row-1', status: 2 }] };
    });

    await expect(page.readTransactionRows({ type: 'consume' })).resolves.toEqual([{ id: 'row-1', status: 2 }]);

    const query = JSON.stringify({ dbName: 'TridentMain', storeName: 'transactions', type: 'consume' });
    expect(bodies[0]).toContain(`Promise.resolve((${readTransactionRowsInPage.toString()})(${query}))`);
    // A burn row's stash carries about 0.5 MB of result bytes; one left on window per poll grows the WebView.
    expect(bodies[1]).toMatch(/delete window\[/);
  });

  // An inspector reattach, or the bridge's 30 s eval cap while a local prove holds the WebView's JS thread.
  it('asks a failed row read again instead of failing the poll that called it', async () => {
    let calls = 0;
    const page = pageWith(async () => {
      calls += 1;
      if (calls === 1) throw new Error('inspector reattached');
      return calls === 2 ? null : { ok: true, v: [{ id: 'row-1', status: 2 }] };
    });

    await expect(page.readTransactionRows()).resolves.toEqual([{ id: 'row-1', status: 2 }]);
    expect(calls).toBe(3);
  });

  it('types bridged-send rows as the extension harness does', async () => {
    const page = pageWith(async () => null);
    const read = jest.fn(async () => [
      {
        id: 'row-1',
        status: 2,
        extraInputs: {
          provider: 'usdcx',
          usdcxBurn: {
            noteId: '0xab',
            destinationDomain: 26,
            phase: 'confirmed',
            destinationBalanceBefore: { balance: '0', blockNumber: '66645216' }
          }
        }
      }
    ]);
    Object.assign(page as unknown as Record<string, unknown>, { readTransactionRows: read });

    const [row] = await page.readBridgedSendRows(true);

    expect(read).toHaveBeenCalledWith({ type: 'bridged-send', withBytes: true });
    expect(row?.extraInputs?.usdcxBurn?.phase).toBe('confirmed');
    expect(row?.extraInputs?.usdcxBurn?.destinationBalanceBefore).toEqual({ balance: '0', blockNumber: '66645216' });
  });
});

describe('IosWalletPage.nativeAsset', () => {
  const ID = 'mtst1apxtmjhlua0s5vt5sg3ymtnyxclasaf0_qr7qqq9wr6w';
  const SCOPE = 'https://rpc.testnet.miden.io|testnet';
  const STORE = {
    account: 'mtst1azl43d2ms9d68sttlde0zkl52qhzld9r_qr7qqq9wr6w',
    displayFaucetId: ID,
    rows: [{ tokenId: ID, symbol: 'USDCX', decimals: 6, balance: 0 }]
  };
  const CACHE = {
    [`native_asset_id:v4:${SCOPE}`]: ID,
    [`native_asset_fee:v2:${SCOPE}`]: JSON.stringify({ faucetId: ID, baseFee: 7 })
  };

  function nativePage(entries: Record<string, string>, view: unknown): IosWalletPage {
    const page = pageWith(async () => view);
    Object.assign(page as unknown as Record<string, unknown>, { stashAndPoll: jest.fn(async () => entries) });
    return page;
  }

  it('reads the id and base fee the wallet cached and the balance row that shows them (spike run 3)', async () => {
    await expect(nativePage(CACHE, STORE).nativeAsset()).resolves.toEqual({
      tokenId: ID,
      symbol: 'USDCX',
      decimals: 6,
      baseFee: 7
    });
  });

  it('refuses a cache that has seen two chains rather than let key order pick one', async () => {
    const page = nativePage({ ...CACHE, 'native_asset_id:v4:https://rpc.devnet.miden.io|devnet': 'mdev1other' }, STORE);
    await expect(page.nativeAsset(0)).rejects.toThrow(/native_asset_id:v4 cache has 2 entries/);
  });

  it('refuses a store that shows another token as native', async () => {
    const page = nativePage(CACHE, { ...STORE, displayFaucetId: 'mtst1other' });
    await expect(page.nativeAsset(0)).rejects.toThrow(/the store shows mtst1other as the native token/);
  });
});

describe('IosWalletPage vault reads', () => {
  const rowsWith = (balance: number) => ({
    account: 'acct',
    displayFaucetId: 'native',
    rows: [
      { tokenId: 'native', symbol: 'USDCX', decimals: 6, balance },
      { tokenId: 'other', symbol: 'TST', decimals: 8, balance: 5 }
    ]
  });

  it('reads exact base units of one faucet in the current account', async () => {
    await expect(pageWith(async () => rowsWith(99.999867)).readVaultBaseUnits('native')).resolves.toBe(99999867n);
  });

  it('refuses a store balance that does not round-trip at its decimals', async () => {
    await expect(pageWith(async () => rowsWith(0.1234567)).readVaultBaseUnits('native')).rejects.toThrow(
      /more precision than 6 decimals/
    );
  });

  it('asks again after a failed eval and fails only on the third in a row', async () => {
    let calls = 0;
    const once = pageWith(async () => {
      calls += 1;
      if (calls === 1) throw new Error('inspector reattached');
      return rowsWith(99.999867);
    });
    await expect(once.readVaultBaseUnits('native')).resolves.toBe(99999867n);

    const never = pageWith(async () => {
      throw new Error('eval: timed out after 30000ms');
    });
    await expect(never.readVaultBaseUnits('native')).rejects.toThrow('eval: timed out after 30000ms');
  }, 15_000);

  // Only Home runs the balance poll: off it the spike's store held the pre-burn balance 60 s after the burn.
  it('navigates Home before it reads and waits out the stale store', async () => {
    const order: string[] = [];
    const reads = [99999867n, 89999615n];
    const page = pageWith(async () => null);
    Object.assign(page as unknown as Record<string, unknown>, {
      navigateHome: jest.fn(async () => {
        order.push('home');
      }),
      readVaultBaseUnits: jest.fn(async () => {
        order.push('read');
        return reads.shift();
      })
    });

    await expect(page.homeVaultBaseUnits('native', units => units === 89999615n, 10_000, '89999615')).resolves.toBe(
      89999615n
    );
    expect(order).toEqual(['home', 'read', 'read']);
  });

  it('names Home, the wanted value and the last read when the vault never gets there', async () => {
    const page = pageWith(async () => null);
    Object.assign(page as unknown as Record<string, unknown>, {
      navigateHome: jest.fn(async () => undefined),
      readVaultBaseUnits: jest.fn(async () => 5n)
    });

    await expect(page.homeVaultBaseUnits('native', units => units === 7n, 0, '7')).rejects.toThrow(
      'the vault of native on Home never read 7 within 0 ms; last 5'
    );
  });
});

describe('routeOf', () => {
  it('keeps the hash route and drops the onboarding bypass search, password included', () => {
    expect(
      routeOf(
        'capacitor://localhost/?__test_skip_onboarding=1&password=123456&walletType=guardian#/send/review?amount=10&network=arc-testnet'
      )
    ).toBe('#/send/review?amount=10&network=arc-testnet');
  });
});
