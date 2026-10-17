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
import { readTransactionRowsInPage } from '../../helpers/history';
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
  it('opens the network drawer from the bridge layer, picks the chain and waits until the row names it', async () => {
    const bridge = '[data-page-layer="/bridge/deposit"]';
    const bodies: string[] = [];
    // The row's spans: the label, the network, and the line under them.
    const page = pageWith(async js => {
      bodies.push(js);
      return ['NetworkSepolia', 'Network', 'Sepolia', 'Receive on Sepolia, arrives as USDCX'];
    });
    const click = jest.fn(async (_selector: string) => undefined);
    const waitFor = jest.fn(async (_selector: string, _opts: { timeoutMs?: number }) => undefined);
    Object.assign(page as unknown as Record<string, unknown>, { click, waitFor });

    await page.selectBridgeNetwork('sepolia', 'Sepolia');

    expect(click.mock.calls.map(([selector]) => selector)).toEqual([
      `${bridge} [data-testid="bridge-network-selector"]`,
      '[data-testid="bridge-network-sepolia"]'
    ]);
    // The drawer portals to <body>, outside the layer, as the token drawer does.
    expect(waitFor).toHaveBeenCalledWith('[data-testid="bridge-network-sepolia"]', { timeoutMs: 10_000 });
    expect(bodies.some(js => js.includes(JSON.stringify(`${bridge} [data-testid="bridge-network-selector"]`)))).toBe(
      true
    );
  });
});

describe('networkRowNames', () => {
  // "Sepolia" is part of "Base Sepolia", "Arbitrum Sepolia" and the row's whole text, so only a span equal to it counts.
  it.each([
    [['NetworkSepolia', 'Network', 'Sepolia'], 'Sepolia', true],
    [['NetworkBase Sepolia', 'Network', 'Base Sepolia', 'Receive on Base Sepolia, arrives as USDCX'], 'Sepolia', false],
    [['NetworkArc Testnet', 'Network', 'Arc Testnet'], 'Base Sepolia', false],
    [null, 'Sepolia', false]
  ] satisfies Array<[readonly string[] | null, string, boolean]>)('reads %j as naming %s: %s', (spans, name, names) => {
    expect(networkRowNames(spans, name)).toBe(names);
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

function spikeAnswer(js: string, overrides: { ready?: unknown; outcome?: unknown; pressed?: string } = {}): unknown {
  if (js.includes('aria-pressed')) {
    const pressed = overrides.pressed ?? CHIPS[0];
    return CHIPS.map(testId => ({ testId, pressed: testId === pressed ? 'true' : 'false' }));
  }
  if (js.includes('bridge-route-usdcx')) {
    return {
      checked: 'true',
      cardText: 'USDCx (Circle xReserve)USDCX fees',
      fee: 'Up to 0.1 USDC',
      net: 'At least 9.9 USDC',
      notice: enText('usdcxWithdrawalNotice')
    };
  }
  if (js.includes('location.href')) return { href: HREF, hash: HREF.slice(HREF.indexOf('#')), submit: true };
  if (js.includes('function row(')) {
    return {
      network: 'Arc Testnet',
      networkFee: enText('usdcxSponsorshipFee', { symbol: 'USDCX' }),
      fee: 'Up to 0.1 USDC',
      net: 'At least 9.9 USDC',
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

describe('IosWalletPage.burnUsdcxViaSendFlow', () => {
  // #1404 clicked the hidden Swap selector; here the review slides over a Send layer holding the same payout rows.
  it('drives every step inside the Send flow and the review layer, presses Arc and returns routes without the password', async () => {
    const bodies: string[] = [];
    const page = pageWith(async js => {
      bodies.push(js);
      return spikeAnswer(js);
    });
    const selectors = stubDom(page);

    const result = await page.burnUsdcxViaSendFlow(BURN);

    expect(result).toEqual({
      rowId: 'row-1',
      reviewRoute: HREF.slice(HREF.indexOf('#')),
      generatingRoute: '#/generating-transaction-full/row-1',
      defaultPressed: ['send-network-arc-testnet']
    });
    expect(JSON.stringify(result)).not.toContain('password');
    expect(selectors.filter(selector => !selector.startsWith(SEND) && !selector.startsWith(REVIEW))).toEqual([]);
    expect(selectors.filter(selector => selector.includes('send-network-'))).toEqual([
      `${SEND} [data-testid="send-network-arc-testnet"]`
    ]);
    expect(selectors.filter(selector => selector === SUBMIT)).toHaveLength(1);
    const roots = bodies.flatMap(rootsOf);
    expect(roots.length).toBeGreaterThan(5);
    expect(roots.filter(root => !root.startsWith(SEND) && !root.startsWith(REVIEW))).toEqual([]);
    expect(bodies.join('\n')).not.toMatch(/document\.querySelector(?:All)?\('/);
    // A prefix check passes a review read rooted at the hidden Send copy, which comes first in the DOM.
    const rootsFor = (marker: string) => [...new Set(bodies.filter(js => js.includes(marker)).flatMap(rootsOf))];
    expect(rootsFor('aria-pressed')).toEqual([SEND]);
    expect(rootsFor('bridge-route-usdcx')).toEqual([SEND]);
    expect(rootsFor('location.href')).toEqual([SUBMIT]);
    expect(rootsFor('function row(')).toEqual([REVIEW]);
    expect(rootsFor("state: 'enabled'")).toEqual([REVIEW]);
    expect(rootsFor('loading')).toEqual([REVIEW]);
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
    const page = pageWith(async js => spikeAnswer(js, { ready: { state: 'error', text: 'Not enough USDCX' } }));
    const selectors = stubDom(page);

    await expect(page.burnUsdcxViaSendFlow(BURN)).rejects.toThrow(
      'the review refused the burn before submit: review-error "Not enough USDCX"'
    );
    expect(selectors).not.toContain(SUBMIT);
  }, 15_000);

  // R26: withStepBudget aborts an overrun step's signal, and the step itself runs on after its test failed.
  it('never clicks submit once its step has been aborted', async () => {
    const page = pageWith(async js => spikeAnswer(js));
    const selectors = stubDom(page);
    const controller = new AbortController();
    controller.abort(new Error('burn_via_send exceeded its 240000 ms budget'));

    await expect(page.burnUsdcxViaSendFlow({ ...BURN, signal: controller.signal })).rejects.toThrow(
      'the burn was not submitted: burn_via_send exceeded its 240000 ms budget'
    );
    expect(selectors).not.toContain(SUBMIT);
  }, 15_000);

  it("tells the wallet's failed Arc snapshot apart from a refusal after submit", async () => {
    const outcome = { hash: '#/send/review?amount=10', error: 'HTTP request failed.', loading: false };
    const page = pageWith(async js => spikeAnswer(js, { outcome }));
    stubDom(page);

    await expect(page.burnUsdcxViaSendFlow(BURN)).rejects.toThrow(
      `Arc RPC unavailable for the wallet's balance snapshot (burn.ts:103), infra: review-error "HTTP request failed."`
    );
  }, 15_000);

  it('presses the payout chain it is given and holds the route and the review to that chain', async () => {
    const baseChip = BASE_SEPOLIA_PAYOUT.chip;
    const href = HREF.replace('network=arc-testnet', `network=${BASE_SEPOLIA_PAYOUT.reviewNetwork}`);
    const rows = usdcxPayoutRowsText(BASE_SEPOLIA_PAYOUT.chainId, BURN.amount);
    const page = pageWith(async js => {
      if (js.includes('location.href')) return { href, hash: href.slice(href.indexOf('#')), submit: true };
      if (js.includes('function row(')) {
        return {
          network: BASE_SEPOLIA_PAYOUT.networkName,
          networkFee: enText('usdcxSponsorshipFee', { symbol: 'USDCX' }),
          fee: rows.fee,
          net: rows.net,
          notice: enText('usdcxWithdrawalNotice')
        };
      }
      if (js.includes('bridge-route-usdcx')) {
        return {
          checked: 'true',
          cardText: 'USDCx (Circle xReserve)USDCX fees',
          fee: rows.fee,
          net: rows.net,
          notice: enText('usdcxWithdrawalNotice')
        };
      }
      return spikeAnswer(js, { pressed: baseChip });
    });
    const selectors = stubDom(page);

    const result = await page.burnUsdcxViaSendFlow({ ...BURN, payout: BASE_SEPOLIA_PAYOUT });

    expect(result.reviewRoute).toBe(href.slice(href.indexOf('#')));
    expect(selectors.filter(selector => selector.includes('send-network-'))).toEqual([
      `${SEND} [data-testid="${baseChip}"]`
    ]);
  }, 15_000);

  // The carousel keeps Send mounted with its step and its chip across hash navigations.
  it('backs the persistent Send pane out to the recipient step before it fills the address', async () => {
    const page = pageWith(async js => spikeAnswer(js));
    const selectors = stubDom(page, 2);

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
    const page = pageWith(async js =>
      js.includes('location.href') ? vm.runInNewContext(`(function () { ${js} })()`, webView) : spikeAnswer(js)
    );
    stubDom(page);
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
