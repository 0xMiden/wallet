/**
 * @jest-environment node
 */
import os from 'os';
import path from 'path';
import vm from 'vm';

import type { CdpSession } from './cdp-bridge';
import { IosWalletPage, networkRowNames, routeOf } from './ios-wallet-page';
import type { SimulatorControl } from './simulator-control';
import { enText, usdcxPayoutRowsText, type BridgedSendRow } from '../../helpers/bridge';
import { fakeConfirmationApp, type CreateAttemptOutcome } from '../../helpers/confirmation-app-fake';
import { readTransactionRowsInPage } from '../../helpers/history';
import { BRIDGE_SOURCE_NETWORK_JS } from '../../helpers/send-flow-scripts';
import { BASE_SEPOLIA_PAYOUT } from '../../helpers/usdcx-constants';

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

describe('IosWalletPage app switching', () => {
  it('starts watching for the hidden document before it leaves, and reports it on return', async () => {
    const order: string[] = [];
    const evalJs = jest.fn(async (body: string) => {
      order.push(body.includes('addEventListener') ? 'watch' : 'read');
      return true;
    });
    const page = new IosWalletPage({
      cdp: { eval: evalJs } as unknown as CdpSession,
      sim: {
        background: jest.fn(async () => order.push('background')),
        foreground: jest.fn(async () => order.push('foreground'))
      } as unknown as SimulatorControl,
      udid: 'udid',
      bundleId: 'bundle'
    });

    await page.leaveForeground();
    const wentHidden = await page.returnToForeground();

    expect(order).toEqual(['watch', 'background', 'foreground', 'read']);
    expect(wentHidden).toBe(true);
  });

  it('rides out a bridge eval cut off at 30 s while the attempt holds the JS thread, and still leaves', async () => {
    let evals = 0;
    const background = jest.fn(async () => undefined);
    const page = new IosWalletPage({
      cdp: {
        eval: async () => {
          evals += 1;
          if (evals === 1) throw new Error('eval: CDP call did not return within 30000ms');
          return null;
        }
      } as unknown as CdpSession,
      sim: { background } as unknown as SimulatorControl,
      udid: 'udid',
      bundleId: 'bundle'
    });

    await page.leaveForeground();

    expect(evals).toBe(2);
    expect(background).toHaveBeenCalledTimes(1);
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

describe('IosWalletPage.selectBridgeNetwork', () => {
  it("opens the network drawer from the bridge layer's From row, picks the chain and waits until the row names it", async () => {
    const bridge = '[data-page-layer="/bridge/deposit"]';
    const bodies: string[] = [];
    // The From row's value: the network logo, which has no text, and the network's name.
    const page = pageWith(async js => {
      bodies.push(js);
      return 'Sepolia';
    });
    const click = jest.fn(async (_selector: string) => undefined);
    const waitFor = jest.fn(async (_selector: string, _opts: { timeoutMs?: number }) => undefined);
    Object.assign(page as unknown as Record<string, unknown>, { click, waitFor });

    await page.selectBridgeNetwork('sepolia', 'Sepolia');

    expect(click.mock.calls.map(([selector]) => selector)).toEqual([
      `${bridge} [data-testid="bridge-source-network"]`,
      '[data-testid="bridge-network-sepolia"]'
    ]);
    // The drawer portals to <body>, outside the layer, as the token drawer does.
    expect(waitFor).toHaveBeenCalledWith('[data-testid="bridge-network-sepolia"]', { timeoutMs: 10_000 });
    expect(bodies).toEqual([BRIDGE_SOURCE_NETWORK_JS]);
    expect(rootsOf(BRIDGE_SOURCE_NETWORK_JS)).toEqual([bridge]);
  });
});

describe('networkRowNames', () => {
  // "Sepolia" is part of "Base Sepolia" and "Arbitrum Sepolia", so only a value equal to it counts.
  it.each([
    ['Sepolia', 'Sepolia', true],
    ['Base Sepolia', 'Sepolia', false],
    ['Arc Testnet', 'Base Sepolia', false],
    [null, 'Sepolia', false]
  ] satisfies Array<[string | null, string, boolean]>)('reads %j as naming %s: %s', (value, name, names) => {
    expect(networkRowNames(value, name)).toBe(names);
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

    let failed = 0;
    const never = pageWith(async () => {
      failed += 1;
      throw new Error('inspector detached');
    });
    await expect(never.readTransactionRows()).rejects.toThrow('inspector detached');
    expect(failed).toBe(3);
  }, 15_000);

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

  // Both ids are strings, so tsc cannot tell them apart, and a hex id reads 0n until the caller's timeout.
  it('refuses a CLI hex id, which keys no store row, before it reads', async () => {
    const evalJs = jest.fn(async () => rowsWith(1));
    await expect(pageWith(evalJs).readVaultBaseUnits('0xc7a5ae7ed377401147b2427377e193')).rejects.toThrow(
      /hexToBech32Faucet/
    );
    expect(evalJs).not.toHaveBeenCalled();
  });

  it('asks again after a failed eval and fails only on the third in a row', async () => {
    let calls = 0;
    const once = pageWith(async () => {
      calls += 1;
      if (calls === 1) throw new Error('inspector reattached');
      return rowsWith(99.999867);
    });
    await expect(once.readVaultBaseUnits('native')).resolves.toBe(99999867n);

    let failed = 0;
    const never = pageWith(async () => {
      failed += 1;
      throw new Error('eval: timed out after 30000ms');
    });
    await expect(never.readVaultBaseUnits('native')).rejects.toThrow('eval: timed out after 30000ms');
    expect(failed).toBe(3);
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

// What the spike's DOM answered at each read of the burn (ios-spike-evidence.json, run 3).
const SEND = '[data-testid="send-flow"]';
const REVIEW = '[data-page-layer="/send/review"]';
const SUBMIT = `${REVIEW} [data-testid="send-review-submit"]`;
// The network sheet portals to <body>, outside the Send flow.
const SHEET = '[role="dialog"][data-state="open"]';
const PICKER = `${SEND} [data-testid="send-network-picker"]`;
const ARC_ROW = `${SHEET} [data-testid="send-network-arc-testnet"]`;
const NATIVE = 'mtst1apxtmjhlua0s5vt5sg3ymtnyxclasaf0_qr7qqq9wr6w';
const KEY = '0xd07e6586a66ddA1Bad34aF529c1f07156b167861';
const CHIPS = [
  'send-network-arc-testnet',
  'send-network-sepolia',
  'send-network-base-sepolia',
  'send-network-arbitrum-sepolia'
];
const HREF =
  'capacitor://localhost/?__test_skip_onboarding=1&password=123456&walletType=guardian' +
  `#/send/review?amount=10&to=${KEY}&tokenId=${NATIVE}&network=arc-testnet&route=usdcx`;
const BURN = {
  destAddress: KEY,
  amount: '10',
  nativeTokenId: NATIVE,
  nativeSymbol: 'USDCX',
  screenshotDir: path.join(os.tmpdir(), 'ios-wallet-page-burn-test')
} as const;

// RouteCard's text: its label, then the fee and arrival metrics, each a caption over its value.
const ROUTE_CARD_TEXT = [
  enText('usdcxRouteLabel'),
  enText('networkFee'),
  enText('usdcxMidenFees', { symbol: 'USDCX' }),
  enText('bridgeArrivalEstimate'),
  enText('bridgePayoutTiming')
].join('');

interface SpikeOverrides {
  ready?: unknown;
  outcome?: unknown;
  /** NetworkField renders the four rows only while its sheet is open. */
  sheetOpen?: boolean;
  /** What the closed field names: Arc Testnet, the default, until another row is picked. */
  summary?: string;
}

// Each reader is answered by its own root test id: the route card and the sheet rows both carry aria-pressed.
function spikeAnswer(js: string, overrides: SpikeOverrides = {}): unknown {
  if (js.includes('send-network-picker')) {
    return {
      summary: overrides.summary ?? 'Arc Testnet',
      rows: overrides.sheetOpen
        ? CHIPS.map(testId => ({ testId, pressed: testId === CHIPS[0] ? 'true' : 'false' }))
        : []
    };
  }
  if (js.includes('bridge-route-usdcx')) {
    return {
      pressed: 'true',
      cardText: ROUTE_CARD_TEXT,
      fee: enText('usdcxPayoutFeeVaries'),
      notice: enText('usdcxWithdrawalNotice')
    };
  }
  if (js.includes('location.href')) return { href: HREF, hash: HREF.slice(HREF.indexOf('#')), submit: true };
  if (js.includes('function row(')) {
    return {
      network: 'Arc Testnet',
      networkFee: enText('usdcxSponsorshipFee', { symbol: 'USDCX' }),
      fee: enText('usdcxPayoutFeeVaries'),
      notice: enText('usdcxWithdrawalNotice')
    };
  }
  if (js.includes("state: 'enabled'")) return overrides.ready ?? { state: 'enabled' };
  if (js.includes('loading')) {
    return overrides.outcome ?? { hash: '#/generating-transaction-full/row-1', error: null, loading: false };
  }
  return null;
}

function rootsOf(js: string): string[] {
  return [...js.matchAll(/document\.querySelector(?:All)?\(("(?:[^"\\]|\\.)*")\)/g)].map(match =>
    String(JSON.parse(match[1] ?? '""'))
  );
}

/** Stubs the DOM primitives the driver calls with a selector, records each selector, and backs out `backs` times. */
function stubDom(page: IosWalletPage, backs = 0): string[] {
  const selectors: string[] = [];
  let left = backs;
  const record = async (selector: string) => {
    selectors.push(selector);
  };
  Object.assign(page as unknown as Record<string, unknown>, {
    navigateTo: jest.fn(async () => undefined),
    waitFor: jest.fn(record),
    click: jest.fn(record),
    clickWhenEnabled: jest.fn(record),
    fillInput: jest.fn(record),
    exists: jest.fn(async (selector: string) => {
      selectors.push(selector);
      return left-- > 0;
    }),
    screenshot: jest.fn(async () => undefined),
    readBridgedSendRows: jest.fn(async () => [])
  });
  return selectors;
}

/** A burn page answering as the spike's DOM did, its network sheet open from a picker click until a row click. */
function burnPage(
  answer: (js: string, sheetOpen: boolean) => unknown = (js, sheetOpen) => spikeAnswer(js, { sheetOpen }),
  backs = 0
) {
  const bodies: string[] = [];
  const page = pageWith(async js => {
    bodies.push(js);
    const clicks = (page as unknown as { click: jest.Mock }).click.mock.calls.map(call => String(call[0]));
    return answer(js, clicks.lastIndexOf(PICKER) > clicks.findLastIndex(selector => selector.startsWith(`${SHEET} `)));
  });
  const selectors = stubDom(page, backs);
  return { page, selectors, bodies };
}

describe('IosWalletPage.burnUsdcxViaSendFlow', () => {
  // #1404 clicked the hidden Swap selector; here the review slides over a Send layer holding the same payout row.
  it('drives every step inside the Send flow, its network sheet and the review layer, picks Arc and returns routes without the password', async () => {
    const { page, selectors, bodies } = burnPage();

    const result = await page.burnUsdcxViaSendFlow(BURN);

    expect(result).toEqual({
      rowId: 'row-1',
      reviewRoute: HREF.slice(HREF.indexOf('#')),
      generatingRoute: '#/generating-transaction-full/row-1',
      defaultPressed: ['send-network-arc-testnet']
    });
    expect(JSON.stringify(result)).not.toContain('password');
    expect(selectors.filter(selector => !selector.startsWith(SEND) && !selector.startsWith(REVIEW))).toEqual([ARC_ROW]);
    expect(selectors.filter(selector => selector.includes('send-network-'))).toEqual([PICKER, PICKER, ARC_ROW]);
    expect(selectors.filter(selector => selector === SUBMIT)).toHaveLength(1);
    const roots = bodies.flatMap(rootsOf);
    expect(roots.length).toBeGreaterThan(5);
    expect([...new Set(roots.filter(root => !root.startsWith(SEND) && !root.startsWith(REVIEW)))]).toEqual([SHEET]);
    expect(bodies.join('\n')).not.toMatch(/document\.querySelector(?:All)?\('/);
    // A prefix check passes a review read rooted at the hidden Send copy, which comes first in the DOM.
    const rootsFor = (marker: string) => [...new Set(bodies.filter(js => js.includes(marker)).flatMap(rootsOf))];
    expect(rootsFor('send-network-picker')).toEqual([SEND, SHEET]);
    expect(rootsFor('bridge-route-usdcx')).toEqual([SEND]);
    expect(rootsFor('location.href')).toEqual([SUBMIT]);
    expect(rootsFor('function row(')).toEqual([REVIEW]);
    expect(rootsFor("state: 'enabled'")).toEqual([REVIEW]);
    expect(rootsFor('loading')).toEqual([REVIEW]);
    // The wallet draws one payout row, the fee, on the route and the review.
    expect(bodies.filter(js => js.includes('usdcx-payout-fee'))).toHaveLength(2);
    expect(bodies.join('\n')).not.toContain('usdcx-payout-net');
  }, 15_000);

  it("refuses an amount that does not exceed Arc's payout fee allowance before it touches the UI", async () => {
    const page = pageWith(async js => spikeAnswer(js));
    stubDom(page);

    await expect(page.burnUsdcxViaSendFlow({ ...BURN, amount: '0.1' })).rejects.toThrow(
      /does not exceed the 0\.1 USDC payout fee allowance on Arc Testnet/
    );
    expect((page as unknown as { navigateTo: jest.Mock }).navigateTo).not.toHaveBeenCalled();
  });

  it("names the review's refusal and never submits", async () => {
    const { page, selectors } = burnPage((js, sheetOpen) =>
      spikeAnswer(js, { sheetOpen, ready: { state: 'error', text: 'Not enough USDCX' } })
    );

    await expect(page.burnUsdcxViaSendFlow(BURN)).rejects.toThrow(
      'the review refused the burn before submit: review-error "Not enough USDCX"'
    );
    expect(selectors).not.toContain(SUBMIT);
  }, 15_000);

  // R26: withStepBudget aborts an overrun step's signal, and the step itself runs on after its test failed.
  it('never clicks submit once its step has been aborted', async () => {
    const { page, selectors } = burnPage();
    const controller = new AbortController();
    controller.abort(new Error('burn_via_send exceeded its 240000 ms budget'));

    await expect(page.burnUsdcxViaSendFlow({ ...BURN, signal: controller.signal })).rejects.toThrow(
      'the burn was not submitted: burn_via_send exceeded its 240000 ms budget'
    );
    expect(selectors).not.toContain(SUBMIT);
  }, 15_000);

  it("tells the wallet's failed Arc snapshot apart from a refusal after submit", async () => {
    const outcome = { hash: '#/send/review?amount=10', error: 'HTTP request failed.', loading: false };
    const { page } = burnPage((js, sheetOpen) => spikeAnswer(js, { sheetOpen, outcome }));

    await expect(page.burnUsdcxViaSendFlow(BURN)).rejects.toThrow(
      `Arc RPC unavailable for the wallet's balance snapshot (burn.ts:103), infra: review-error "HTTP request failed."`
    );
  }, 15_000);

  it('picks the payout chain it is given and holds the route and the review to that chain', async () => {
    const baseRow = `${SHEET} [data-testid="send-network-${BASE_SEPOLIA_PAYOUT.reviewNetwork}"]`;
    const href = HREF.replace('network=arc-testnet', `network=${BASE_SEPOLIA_PAYOUT.reviewNetwork}`);
    const rows = usdcxPayoutRowsText(BASE_SEPOLIA_PAYOUT.chainId, BURN.amount);
    const { page, selectors } = burnPage((js, sheetOpen) => {
      if (js.includes('location.href')) return { href, hash: href.slice(href.indexOf('#')), submit: true };
      if (js.includes('function row(')) {
        return {
          network: BASE_SEPOLIA_PAYOUT.networkName,
          networkFee: enText('usdcxSponsorshipFee', { symbol: 'USDCX' }),
          fee: rows.fee,
          notice: enText('usdcxWithdrawalNotice')
        };
      }
      if (js.includes('bridge-route-usdcx')) {
        return {
          pressed: 'true',
          cardText: ROUTE_CARD_TEXT,
          fee: rows.fee,
          notice: enText('usdcxWithdrawalNotice')
        };
      }
      return spikeAnswer(js, { sheetOpen, summary: BASE_SEPOLIA_PAYOUT.networkName });
    });

    const result = await page.burnUsdcxViaSendFlow({ ...BURN, payout: BASE_SEPOLIA_PAYOUT });

    expect(result.reviewRoute).toBe(href.slice(href.indexOf('#')));
    expect(result.defaultPressed).toEqual(['send-network-arc-testnet']);
    expect(selectors.filter(selector => selector.includes('send-network-'))).toEqual([PICKER, PICKER, baseRow]);
  }, 15_000);

  // The carousel keeps Send mounted with its step and its network across hash navigations.
  it('backs the persistent Send pane out to the recipient step before it fills the address', async () => {
    const { page, selectors } = burnPage(undefined, 2);

    await page.burnUsdcxViaSendFlow(BURN);

    const back = `${SEND} [data-testid="flow-back"]`;
    const clicks = (page as unknown as { click: jest.Mock }).click.mock.calls.map(call => String(call[0]));
    expect(clicks.filter(selector => selector === back)).toHaveLength(2);
    expect(selectors.lastIndexOf(back)).toBeLessThan(selectors.indexOf(`${SEND} [data-testid="send-recipient-input"]`));
  }, 15_000);
});

describe('IosWalletPage.burnUsdcxViaSendFlow review landing', () => {
  afterEach(() => jest.useRealTimers());

  // location.href keeps the onboarding bypass's ?password= all session, and a timed-out poll prints its last read.
  it("keeps the onboarding password out of the timed-out review poll's failure", async () => {
    // The landing read runs as the WebView runs it; no submit button renders, so the poll runs out.
    const webView = { location: new URL(HREF), document: { querySelector: () => null } };
    const { page } = burnPage((js, sheetOpen) =>
      js.includes('location.href')
        ? vm.runInNewContext(`(function () { ${js} })()`, webView)
        : spikeAnswer(js, { sheetOpen })
    );
    jest.useFakeTimers();

    const failure = page.burnUsdcxViaSendFlow(BURN).then(
      () => 'resolved',
      (error: unknown) => (error instanceof Error ? error.message : String(error))
    );
    await jest.advanceTimersByTimeAsync(31_000);
    const message = await failure;

    expect(message).toContain('the burn review: not met within 30000 ms; last read');
    expect(message).toContain('"hash":"#/send/review?amount=10');
    expect(message).not.toContain('password');
  });
});

describe('IosWalletPage.pollEval', () => {
  afterEach(() => jest.useRealTimers());

  // A detached inspector or the bridge's 30 s eval cap fails every read; "last read none" alone named no cause.
  it('names the last failed eval when every read rejects, with no URL query in it', async () => {
    let calls = 0;
    const page = pageWith(async () => {
      calls += 1;
      throw new Error(calls === 1 ? 'inspector reattached' : `eval: no page at ${HREF}`);
    });
    jest.useFakeTimers();

    const failure = (
      page as unknown as {
        pollEval(label: string, js: string, done: () => boolean, timeoutMs: number): Promise<unknown>;
      }
    )
      .pollEval('the burn review', 'return null;', () => true, 1_000)
      .then(
        () => 'resolved',
        (error: unknown) => (error instanceof Error ? error.message : String(error))
      );
    await jest.advanceTimersByTimeAsync(1_100);
    const message = await failure;

    expect(calls).toBeGreaterThan(1);
    expect(message).toBe(
      'the burn review: not met within 1000 ms; last read none; last failed eval eval: no page at capacitor://localhost/#/send/review'
    );
  });
});

describe('IosWalletPage.waitForBurnCompleted', () => {
  const ON_PAGE = '#/generating-transaction-full/row-1';

  function burnPage(
    hash: string | (() => Promise<string>),
    rounds: BridgedSendRow[][]
  ): { page: IosWalletPage; calls: boolean[] } {
    const page = pageWith(async () => (typeof hash === 'string' ? hash : hash()));
    const calls: boolean[] = [];
    const withBytes: BridgedSendRow = { id: 'row-1', status: 2, stage: 'complete', resultBytes: 'AAAA' };
    Object.assign(page as unknown as Record<string, unknown>, {
      readBridgedSendRows: jest.fn(async (bytes = false) => {
        calls.push(bytes);
        return bytes ? [withBytes] : (rounds.shift() ?? []);
      })
    });
    return { page, calls };
  }

  // On mobile the generating page drives the transaction loop; the reaper releases resultBytes 10 min after completion.
  it('stays on the generating page through Unconfirmed until Completed, then reads the bytes once', async () => {
    const { page, calls } = burnPage(ON_PAGE, [
      [{ id: 'row-1', status: 1, stage: 'proving' }],
      [{ id: 'row-1', status: 4, stage: 'submitting' }],
      [{ id: 'row-1', status: 2, stage: 'complete' }]
    ]);

    const done = await page.waitForBurnCompleted('row-1', 60_000, 0);

    expect(done.row.resultBytes).toBe('AAAA');
    expect(done.stages.map(sample => sample.status)).toEqual([1, 4, 2]);
    expect(calls).toEqual([false, false, false, true]);
  });

  it('fails a Failed row with the Guardian settle hint a 409 earns', async () => {
    const { page } = burnPage(ON_PAGE, [
      [{ id: 'row-1', status: 3, stage: 'submitting', rawError: 'HTTP 409 ConflictPendingDelta' }]
    ]);

    await expect(page.waitForBurnCompleted('row-1', 60_000, 0)).rejects.toThrow(
      'the prior Guardian candidate had not settled'
    );
  });

  it('fails when the page left the generating route before the row completed', async () => {
    const { page } = burnPage('#/', [[{ id: 'row-1', status: 0 }]]);

    await expect(page.waitForBurnCompleted('row-1', 1_000, 0)).rejects.toThrow(
      'left the generating page for #/ before burn row row-1 completed'
    );
  });

  it('asks a failed location read again instead of failing the burn', async () => {
    let reads = 0;
    const { page } = burnPage(async () => {
      reads += 1;
      if (reads === 1) throw new Error('inspector reattached');
      return ON_PAGE;
    }, [[{ id: 'row-1', status: 2, stage: 'complete' }]]);

    await expect(page.waitForBurnCompleted('row-1', 60_000, 0)).resolves.toMatchObject({ row: { id: 'row-1' } });
    expect(reads).toBe(2);
  });
});

describe('IosWalletPage transaction details', () => {
  const LAYER = '[data-page-layer="/history-details/row-1"]';

  it('opens the details route and waits for the pill inside its own layer', async () => {
    const page = pageWith(async () => null);
    const navigateTo = jest.fn(async () => undefined);
    const waitFor = jest.fn(async () => undefined);
    Object.assign(page as unknown as Record<string, unknown>, { navigateTo, waitFor });

    await page.openTransactionDetails('row-1');

    expect(navigateTo).toHaveBeenCalledWith('/history-details/row-1');
    expect(waitFor).toHaveBeenCalledWith(`${LAYER} [data-testid="history-status-pill"]`, { timeoutMs: 30_000 });
  });

  it('reads the pill and the Arc explorer links from the details layer only', async () => {
    const bodies: string[] = [];
    const view = { pill: 'Confirmed', txLinks: ['https://explorer.testnet.arc.io/tx/0xde87'] };
    const page = pageWith(async js => {
      bodies.push(js);
      return view;
    });

    await expect(page.transactionDetailsView('row-1')).resolves.toEqual(view);
    expect(bodies[0]).toContain(`document.querySelector(${JSON.stringify(LAYER)})`);
    expect(bodies[0]).toContain(JSON.stringify('https://explorer.testnet.arc.io/tx/'));
  });

  it("reads the links to the payout chain's explorer it is given", async () => {
    const bodies: string[] = [];
    const page = pageWith(async js => {
      bodies.push(js);
      return null;
    });

    await expect(page.transactionDetailsView('row-1', BASE_SEPOLIA_PAYOUT.explorer)).resolves.toEqual({
      pill: null,
      txLinks: []
    });
    expect(bodies[0]).toContain(JSON.stringify(`${BASE_SEPOLIA_PAYOUT.explorer}/tx/`));
  });
});

describe('IosWalletPage poll attribution', () => {
  afterEach(() => jest.useRealTimers());

  const WELCOME = '[data-testid="onboarding-welcome"]';
  const WEDGED = `eval: CDP call did not return within 30000ms (WebView/RWI wedged) at ${HREF}`;

  interface Polls {
    pollForSelector(selector: string, timeoutMs: number): Promise<void>;
    pollForCondition(jsBody: string, timeoutMs: number): Promise<void>;
  }

  async function outcomeOf(poll: (polls: Polls) => Promise<void>, reads: Array<() => unknown>): Promise<string> {
    let call = 0;
    const page = pageWith(async () => reads[Math.min(call++, reads.length - 1)]!());
    jest.useFakeTimers();
    const outcome = poll(page as unknown as Polls).then(
      () => 'resolved',
      (error: unknown) => (error instanceof Error ? error.message : String(error))
    );
    await jest.advanceTimersByTimeAsync(1_100);
    return outcome;
  }

  const wedged = (): never => {
    throw new Error(WEDGED);
  };

  // A session that died at attach failed its first poll as "onboarding-welcome did not appear" (run 39034367703).
  it('names a dead session when no selector eval returned, with no URL query in it', async () => {
    const message = await outcomeOf(polls => polls.pollForSelector(WELCOME, 1_000), [wedged]);

    expect(message).toBe(
      `pollForSelector: could not check ${WELCOME}: no CDP eval returned in 1000ms ` +
        '(last error: eval: CDP call did not return within 30000ms (WebView/RWI wedged) at capacitor://localhost/#/send/review)'
    );
  });

  it('keeps the old message once an eval returned and the selector was absent', async () => {
    const message = await outcomeOf(polls => polls.pollForSelector(WELCOME, 1_000), [wedged, () => false]);

    expect(message).toBe(`pollForSelector: ${WELCOME} did not appear within 1000ms`);
  });

  it('names a dead session when no condition eval returned', async () => {
    const message = await outcomeOf(polls => polls.pollForCondition('return window.ready === true;', 1_000), [wedged]);

    expect(message).toMatch(
      /^pollForCondition: could not check return window\.ready === true;: no CDP eval returned in 1000ms \(last error: eval: CDP call did not return/
    );
  });

  it('keeps the old message once a condition eval returned false', async () => {
    const message = await outcomeOf(polls => polls.pollForCondition('return false;', 1_000), [() => false]);

    expect(message).toMatch(/^pollForCondition: condition not met within 1000ms \S return false;$/);
  });

  it('still passes when a check holds after failed evals', async () => {
    await expect(outcomeOf(polls => polls.pollForSelector(WELCOME, 1_000), [wedged, () => true])).resolves.toBe(
      'resolved'
    );
    await expect(outcomeOf(polls => polls.pollForCondition('return true;', 1_000), [wedged, () => true])).resolves.toBe(
      'resolved'
    );
  });
});

// A create whose first sync failed sat on Confirmation's failure screen until the 120 s Ready wait ran out
// (run 39025104169, attempt 2).
describe('IosWalletPage.waitForCreatedWalletReady', () => {
  afterEach(() => jest.useRealTimers());

  function confirmationApp(outcomes: CreateAttemptOutcome[], opts: { lagReads?: number; retryButton?: boolean } = {}) {
    const { evalJs, clicks } = fakeConfirmationApp(outcomes, opts);
    return { page: pageWith(evalJs), clicks };
  }

  async function outcomeOf(page: IosWalletPage, timeoutMs = 120_000): Promise<{ settled: boolean; outcome: string }> {
    jest.useFakeTimers();
    let settled = false;
    const outcome = (page as unknown as { waitForCreatedWalletReady(label: string, timeoutMs: number): Promise<void> })
      .waitForCreatedWalletReady('create(private)', timeoutMs)
      .then(
        () => 'ready',
        (error: unknown) => (error instanceof Error ? error.message : String(error))
      )
      .finally(() => (settled = true));
    await jest.advanceTimersByTimeAsync(10_000);
    return { settled, outcome: settled ? await outcome : 'pending' };
  }

  it("is the wait a create runs after pressing Confirmation's button", async () => {
    // The address read answers the account; the consent dismissal sees the home surface already up.
    const page = pageWith(async js => (js.includes('publicKey') ? 'mtst1qcreated' : js.includes('explore-page')));
    const waitForCreatedWalletReady = jest.fn(async () => undefined);
    const click = jest.fn(async () => undefined);
    Object.assign(page as unknown as Record<string, unknown>, {
      pollForSelector: jest.fn(async () => undefined),
      click,
      waitForCreatedWalletReady
    });
    jest.useFakeTimers();

    const created = page.createGuardianWallet('Password123!');
    await jest.advanceTimersByTimeAsync(3_000);

    await expect(created).resolves.toEqual({ address: 'mtst1qcreated', seedPhrase: [] });
    expect(click).toHaveBeenCalledWith('[data-testid="onboarding-confirmation-submit"]');
    expect(waitForCreatedWalletReady).toHaveBeenCalledWith('IosWalletPage.createWalletViaBypass(guardian)', 180_000);
  });

  it('waits for Ready without pressing anything when the create succeeds', async () => {
    const { page, clicks } = confirmationApp(['ready']);

    await expect(outcomeOf(page)).resolves.toEqual({ settled: true, outcome: 'ready' });
    expect(clicks).toEqual([]);
  });

  it("presses the app's Retry once on the first failure screen and keeps waiting for Ready", async () => {
    const { page, clicks } = confirmationApp(['fails', 'ready']);

    await expect(outcomeOf(page)).resolves.toEqual({ settled: true, outcome: 'ready' });
    expect(clicks).toEqual([0]);
  });

  it('fails at once, with the screen text, when the Retry fails too', async () => {
    const { page, clicks } = confirmationApp(['fails', 'fails', 'ready']);

    await expect(outcomeOf(page)).resolves.toEqual({
      settled: true,
      outcome:
        'create(private): wallet creation failed again after one Retry: ' +
        'Something went wrong Failed to sync state: RPC deadline exceeded Retry'
    });
    expect(clicks).toEqual([0]);
  });

  it('does not count the first failure twice while the screen still shows it after the Retry', async () => {
    const { page, clicks } = confirmationApp(['fails', 'ready'], { lagReads: 2 });

    await expect(outcomeOf(page)).resolves.toEqual({ settled: true, outcome: 'ready' });
    expect(clicks).toEqual([0]);
  });

  // walletSetupDidNotComplete: the store turns Ready while the Notice from the timed-out wait is still up.
  it('takes a Ready wallet as created while the failure screen still shows', async () => {
    const { page, clicks } = confirmationApp(['ready-under-failure']);

    await expect(outcomeOf(page)).resolves.toEqual({ settled: true, outcome: 'ready' });
    expect(clicks).toEqual([]);
  });

  // A Retry that failed before any read saw it start, or a press that did nothing, leaves the screen unchanged.
  it('fails at the deadline with the screen text when the failure screen never clears after the Retry', async () => {
    const { page, clicks } = confirmationApp(['fails', 'fails'], { lagReads: Infinity });

    await expect(outcomeOf(page, 5_000)).resolves.toEqual({
      settled: true,
      outcome:
        'create(private): wallet creation still shows its failure screen after one Retry: ' +
        'Something went wrong Failed to sync state: RPC deadline exceeded Retry'
    });
    expect(clicks).toEqual([0]);
  });

  it('keeps the plain timeout when the screen cleared after the Retry and the wallet never turned Ready', async () => {
    const { page, clicks } = confirmationApp(['fails', 'creating'], { lagReads: 2 });

    const { outcome } = await outcomeOf(page, 5_000);

    expect(outcome).toMatch(/^pollForCondition: condition not met within 5000ms /);
    expect(clicks).toEqual([0]);
  });

  it('fails at once with the screen text when the failure screen has no Retry to press', async () => {
    const { page } = confirmationApp(['fails'], { retryButton: false });

    const { outcome } = await outcomeOf(page);

    expect(outcome).toBe(
      'create(private): wallet creation failed and its Retry could not be pressed ' +
        '(IosWalletPage.click: no element matched [data-testid="onboarding-confirmation-submit"]): ' +
        'Something went wrong Failed to sync state: RPC deadline exceeded Retry'
    );
  });
});
