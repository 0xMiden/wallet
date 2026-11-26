import type { BrowserContext, Page, Route } from '@playwright/test';

import { IMPORTED_WALLET_PASSWORD, importWallet } from '../e2e/helpers/import-wallet';
import { expect, test } from '../fixtures/extension';
import {
  TEST_TOKEN_IBTC,
  TEST_TOKEN_IETH,
  TEST_TOKEN_IMIDEN,
  TEST_TOKEN_IUSDT
} from '../../src/lib/miden/swap/testing/registry';
import type { SyncData } from '../../src/lib/shared/types';

/**
 * The balance shows a dash only when nothing can be valued. Each Sidebar open and each Command load is a fresh
 * document, so this records every painted frame and every DOM change from document start while the price feed is held
 * open (as a real open waits on Binance), then after the feed lands. The vault mirrors an installed mainnet wallet:
 * USDCx (fixed $1) beside a token no list prices (MICO), with no cached quote for either.
 */

type Surface = 'sidepanel' | 'command';
type Frame = { t: number; text: string };
declare global {
  interface Window {
    __balanceFrames?: Frame[];
    __syncReads?: number;
  }
}

const FEED = /https:\/\/(data-api\.binance\.vision|api\.kraken\.com)\//;
const CORS = { 'access-control-allow-origin': '*' };
// Listed without a binanceAsset, as mainnet lists USDCx, so its price asset is 'USDCX' and its quote is the fixed $1.
const USDCX_LIKE = {
  faucetId: TEST_TOKEN_IUSDT.faucetId,
  amountBaseUnits: '7250000',
  metadata: { symbol: 'USDCX', name: 'USDCx', decimals: 6 }
};
// Absent from the list, as MICO is on mainnet: no feed answer can price it.
const MICO_LIKE = {
  faucetId: TEST_TOKEN_IBTC.faucetId,
  amountBaseUnits: '30000',
  metadata: { symbol: 'MICO', name: 'Mico', decimals: 4 }
};

// Listed, as Gamecoin is on mainnet, but quoted by no exchange.
const GC_LIKE = {
  faucetId: TEST_TOKEN_IMIDEN.faucetId,
  amountBaseUnits: '40000000',
  metadata: { symbol: 'GC', name: 'Gamecoin', decimals: 6 }
};

// Binance quotes ETH, a listed token the wallet does not hold; Kraken lists only ETH, so it rules GC out too.
function answerFeed(route: Route) {
  const url = new URL(route.request().url());
  if (url.hostname === 'api.kraken.com' && url.pathname.endsWith('/AssetPairs')) {
    return route.fulfill({
      headers: CORS,
      json: { error: [], result: { XETHZUSD: { status: 'online', quote: 'ZUSD', wsname: 'ETH/USD' } } }
    });
  }
  if (url.hostname !== 'data-api.binance.vision') return route.abort();
  if (url.pathname.endsWith('/exchangeInfo')) {
    return route.fulfill({
      headers: CORS,
      json: { symbols: [{ symbol: 'ETHUSDT', status: 'TRADING', baseAsset: 'ETH', quoteAsset: 'USDT' }] }
    });
  }
  if (url.pathname.endsWith('/ticker/24hr')) {
    const tickers = [
      { symbol: 'USDTUSD', lastPrice: '1', priceChange: '0' },
      { symbol: 'USDCUSD', lastPrice: '1', priceChange: '0' },
      { symbol: 'ETHUSDT', lastPrice: '2000', priceChange: '10' }
    ];
    const one = url.searchParams.get('symbol');
    const many: string[] = JSON.parse(url.searchParams.get('symbols') ?? '[]');
    return route.fulfill({
      headers: CORS,
      json: one ? tickers.find(t => t.symbol === one) : tickers.filter(t => many.includes(t.symbol))
    });
  }
  return route.abort();
}

/** Holds every feed request open until `release()`. */
async function holdPriceFeed(context: BrowserContext) {
  await context.unroute(FEED);
  const held: Route[] = [];
  const answered: string[] = [];
  let released = false;
  const answer = async (route: Route) => {
    answered.push(new URL(route.request().url()).pathname);
    await answerFeed(route);
  };
  await context.route(FEED, async route => {
    if (!released) return void held.push(route);
    await answer(route);
  });
  return {
    held: () => held.length,
    tickerAnswered: () => answered.some(path => path.endsWith('/ticker/24hr')),
    release: async () => {
      released = true;
      await Promise.all(held.splice(0).map(answer));
    }
  };
}

async function openWithTimeline(
  context: BrowserContext,
  extensionId: string,
  surface: Surface,
  syncData: SyncData
): Promise<Page> {
  const page = await context.newPage();
  if (surface === 'sidepanel') await page.setViewportSize({ width: 360, height: 600 });
  await page.addInitScript(
    ({ data, kind }) => {
      const storage = chrome.storage.local;
      storage.get = new Proxy(storage.get, {
        apply: (target, receiver, args) => {
          if (args[0] !== 'miden_sync_data' || typeof args[1] !== 'function') {
            return Reflect.apply(target, receiver, args);
          }
          // On the next task, like a real storage read, and steady while the service worker syncs its own vault.
          window.__syncReads = (window.__syncReads ?? 0) + 1;
          setTimeout(() => args[1]({ miden_sync_data: data }), 0);
          return undefined;
        }
      });
      const frames: Frame[] = [];
      window.__balanceFrames = frames;
      const read = (): string => {
        if (kind === 'sidepanel') {
          const label = document.querySelector('[data-testid="balance-card-label"]');
          if (!label?.getBoundingClientRect().height) return '(no card)';
          const unit = document.querySelector('[data-testid="balance-card-currency"]');
          return unit ? (unit.previousElementSibling?.textContent ?? '') : '(skeleton)';
        }
        const label = Array.from(document.querySelectorAll('section[aria-label="Portfolio"] p')).find(
          node => node.textContent === 'Wallet balance'
        );
        const amount = label?.nextElementSibling;
        if (!amount?.getBoundingClientRect().height) return '(no card)';
        const shown =
          amount.querySelector('[data-testid="command-live-balance"]') ??
          amount.querySelector('[aria-hidden="true"]') ??
          amount;
        return shown.textContent ?? '';
      };
      const record = () => {
        const text = read();
        if (frames.at(-1)?.text !== text) frames.push({ t: Math.round(performance.now()), text });
      };
      requestAnimationFrame(function sample() {
        record();
        requestAnimationFrame(sample);
      });
      new MutationObserver(record).observe(document, { subtree: true, childList: true, characterData: true });
    },
    { data: syncData, kind: surface }
  );
  const path = surface === 'sidepanel' ? 'sidepanel.html' : 'fullpage.html#/';
  await page.goto(`chrome-extension://${extensionId}/${path}`, { waitUntil: 'domcontentloaded' });
  const card =
    surface === 'sidepanel' ? page.getByTestId('balance-card-label') : page.locator('section[aria-label="Portfolio"]');
  const unlock = page.getByTestId('unlock-password');
  await card.or(unlock).first().waitFor({ timeout: 30_000 });
  if (await unlock.isVisible().catch(() => false)) {
    await page.locator('#unlock-password').fill(IMPORTED_WALLET_PASSWORD);
    await page.locator('#unlock-password').press('Enter');
  }
  await card.waitFor({ timeout: 30_000 });
  return page;
}

const timeline = (page: Page) => page.evaluate(() => window.__balanceFrames ?? []);
const shown = (frames: Frame[]) => frames.map(frame => frame.text).filter(text => text !== '(no card)');

const CASES = [
  { name: 'usdcx-and-unlisted', vault: [USDCX_LIKE, MICO_LIKE], cache: 'unheld' },
  { name: 'usdcx-and-unlisted-cold-cache', vault: [USDCX_LIKE, MICO_LIKE], cache: 'none' },
  // Control, the #2236 shape: green before the fix too, so a failure here is the harness.
  { name: 'control-usdcx-alone', vault: [USDCX_LIKE], cache: 'none' },
  // After one open whose feed ruled Gamecoin out, the next ones need not wait for it.
  { name: 'usdcx-and-gamecoin', vault: [USDCX_LIKE, GC_LIKE], cache: 'unheld', primeFeed: true },
  // Nothing can be valued, so the dash is the right answer.
  { name: 'negative-unlisted-alone', vault: [MICO_LIKE], cache: 'unheld' }
] as const;

test.describe('Balance on every frame', () => {
  test.skip(({ browserName }) => browserName !== 'chromium', 'Extension UI only runs in Chromium');

  test('draws a dash only when nothing can be valued, on every frame of Sidebar and Command', async ({
    extensionContext,
    extensionId
  }, testInfo) => {
    test.setTimeout(600_000);
    await extensionContext.route('https://raw.githubusercontent.com/0xMiden/token-list/main/*.json', route =>
      route.abort()
    );
    await importWallet(extensionContext, extensionId);
    const worker = extensionContext.serviceWorkers()[0] ?? (await extensionContext.waitForEvent('serviceworker'));
    const readSnapshot = () =>
      worker.evaluate(async () => (await chrome.storage.local.get('miden_sync_data')).miden_sync_data as SyncData);
    await expect.poll(async () => (await readSnapshot())?.balanceSnapshot?.accountNonce).toBeDefined();
    const network = (await readSnapshot()).balanceSnapshot?.effectiveNetwork;
    expect(network).toBe('testnet');

    for (const testCase of CASES) {
      const { name, vault, cache } = testCase;
      const nowSec = Math.floor(Date.now() / 1000);
      await worker.evaluate(values => chrome.storage.local.set(values), {
        [`token_list_cache_v2:${network}`]: {
          fetchedAt: Date.now(),
          body: {
            tokens: [
              { network, faucetId: USDCX_LIKE.faucetId, symbol: 'USDCX', name: 'USDCx', decimals: 6 },
              { network, faucetId: TEST_TOKEN_IETH.faucetId, symbol: 'ETH', name: 'Ether', decimals: 8 },
              { network, faucetId: GC_LIKE.faucetId, symbol: 'GC', name: 'Gamecoin', decimals: 6 }
            ]
          }
        },
        usd_price_cache:
          cache === 'unheld'
            ? {
                ETH: { priceMicro: '2000000000', fetchedAt: nowSec },
                USDC: { priceMicro: '1000000', fetchedAt: nowSec }
              }
            : {}
      });
      const fixture: SyncData = { ...(await readSnapshot()), vaultAssets: [...vault] };
      const knowable = vault.some(asset => asset.metadata.symbol === 'USDCX');
      const opens = knowable && vault.length > 1 ? 3 : 1;
      if ('primeFeed' in testCase) {
        const feed = await holdPriceFeed(extensionContext);
        const page = await openWithTimeline(extensionContext, extensionId, 'sidepanel', fixture);
        await feed.release();
        await expect
          .poll(
            () =>
              worker.evaluate(async key => {
                const stored = (await chrome.storage.local.get(key))[key] as { unquoted?: string[] } | undefined;
                return stored?.unquoted ?? [];
              }, `display_feed_v1:${network}`),
            { message: `${name}: the feed run never ruled Gamecoin out` }
          )
          .toEqual(expect.arrayContaining(['GC']));
        await page.close();
      }

      for (const surface of ['sidepanel', 'command'] as const) {
        const value = surface === 'sidepanel' ? /^7\.25$/ : /^7\.25 USD$/;
        const dash = surface === 'sidepanel' ? /^\u2014$/ : /^---$/;
        const expected = [expect.stringMatching(knowable ? value : dash)];
        // The panel toggled open and shut: every open is a fresh document.
        for (let open = 0; open < opens; open += 1) {
          const label = `${name} ${surface} open ${open + 1}`;
          const feed = await holdPriceFeed(extensionContext);
          const page = await openWithTimeline(extensionContext, extensionId, surface, fixture);
          if (open === 0) {
            await page.screenshot({ path: testInfo.outputPath(`command-balance-${surface}-${name}.png`) });
          }
          // The price fetch is out and held, and the 3 s balance poll has landed again after the startup read.
          await expect.poll(() => feed.held(), { message: `${label}: no price request` }).toBeGreaterThanOrEqual(1);
          await expect
            .poll(() => page.evaluate(() => window.__syncReads ?? 0), { message: `${label}: no balance poll` })
            .toBeGreaterThanOrEqual(2);
          await page.waitForTimeout(1_000);
          const held = await timeline(page);
          console.log(`[balance frames] ${label} while the feed is held: ${JSON.stringify(held)}`);
          expect(shown(held), `${label} while the feed is held`).toEqual(expected);
          await feed.release();
          await expect.poll(() => feed.tickerAnswered(), { message: `${label}: ticker not answered` }).toBe(true);
          await page.waitForTimeout(2_000);
          const settled = await timeline(page);
          console.log(`[balance frames] ${label} after the feed: ${JSON.stringify(settled)}`);
          // The feed landing must not flash a dash, nor price the unlisted token.
          expect(shown(settled), `${label} after the feed`).toEqual(expected);
          await page.close();
        }
      }
    }
  });
});
