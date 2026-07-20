import { expect, type Page } from '@playwright/test';

import type { MidenCli } from './miden-cli';
import type { ChromeWalletPageApi } from './wallet-page';
import type { TimelineRecorder } from '../harness/timeline-recorder';

/**
 * Reusable in-protocol-DEX (PSWAP) driver for the swap E2E suite. Factors the
 * validated maker/taker flow (R0 spike) into helpers the scenario specs share:
 *
 *  - `fundSwapPair` stands up two faucets + funds the maker with the OFFER token
 *    and the taker with the REQUEST token, points both wallets' swap registries
 *    at them, and stubs the external price feed.
 *  - `createSwapOrder` drives the real `#/swap` UI to mint a maker note and
 *    returns its on-chain orderId.
 *  - `fillSwapOrder` / `cancelSwapOrder` run in the taker/maker SERVICE WORKER
 *    (the vault signs SW-direct there — the page→intercom path yields an empty
 *    signature; see test-hooks.ts).
 *  - `readLineage` / `tokenBalance` are the settlement assertions.
 *
 * The E2E hooks these call are `MIDEN_E2E_TEST`-gated and dead-stripped from
 * production builds.
 */

type Wallet = ChromeWalletPageApi;

/** External swap price feed — stubbed so specs don't depend on the network. */
const PRICE_FEED_GLOB = '**/35-175-40-181.sslip.io/**';

/** Default base-unit amount minted to each side's faucet. */
const DEFAULT_FUND_AMOUNT = 100_000_000_000;

export interface SwapTokenDescriptor {
  symbol: string;
  /** bech32 faucet id, as the wallet keys balances. */
  faucetId: string;
  decimals: number;
  logoSymbol: string;
}

export interface SwapPair {
  offer: SwapTokenDescriptor;
  request: SwapTokenDescriptor;
  /** hex faucet ids as the CLI reports them (for further mints). */
  offerFaucetHex: string;
  requestFaucetHex: string;
}

/** The SW that owns a wallet's tx loop + vault — where PSWAP discovery/fill run. */
export function swOf(w: Wallet) {
  const sw = w.page
    .context()
    .serviceWorkers()
    .find(s => new URL(s.url()).host === w.extensionId);
  if (!sw) throw new Error(`no service worker for ${w.extensionId}`);
  return sw;
}

/**
 * CLI faucet ids are hex; the wallet keys balances (and the swap review's
 * balance gate) by the bech32 form. Convert via the store hook. R0 finding.
 */
export function hexFaucetToBech32(w: Wallet, hex: string): Promise<string> {
  return w.page.evaluate(
    h => (window as never as { __TEST_HEX_TO_BECH32_FAUCET__: (h: string) => string }).__TEST_HEX_TO_BECH32_FAUCET__(h),
    hex
  );
}

export interface FundSwapPairOptions {
  offerSymbol: string;
  requestSymbol: string;
  /** base units minted to A's offer faucet + B's request faucet (default 100e9). */
  amount?: number;
  offerDecimals?: number;
  requestDecimals?: number;
  /** per-side balance-wait/claim budget (default 150s; raise for guardian accounts). */
  balanceTimeoutMs?: number;
}

/**
 * Stand up a swap-ready pair: two faucets, maker funded with the OFFER token and
 * taker with the REQUEST token, both wallets' swap registries pointed at them,
 * and the external price feed stubbed. Both wallets must already be created.
 */
export async function fundSwapPair(
  midenCli: MidenCli,
  maker: Wallet,
  taker: Wallet,
  opts: FundSwapPairOptions,
  timeline?: TimelineRecorder
): Promise<SwapPair> {
  const amount = opts.amount ?? DEFAULT_FUND_AMOUNT;
  await midenCli.init();
  const offerFaucetHex = await midenCli.createFaucet(opts.offerSymbol, opts.offerDecimals ?? 8);
  const requestFaucetHex = await midenCli.createFaucet(opts.requestSymbol, opts.requestDecimals ?? 8);

  const makerAddr = await maker.getAccountAddress();
  const takerAddr = await taker.getAccountAddress();
  await midenCli.mint(offerFaucetHex, makerAddr, amount, 'public');
  await midenCli.mint(requestFaucetHex, takerAddr, amount, 'public');
  await midenCli.sync();

  const balanceTimeout = opts.balanceTimeoutMs ?? 150_000;
  await maker.waitForBalanceAbove(0, balanceTimeout, timeline);
  await maker.claimAllNotes(balanceTimeout);
  await taker.waitForBalanceAbove(0, balanceTimeout, timeline);
  await taker.claimAllNotes(balanceTimeout);

  const offer: SwapTokenDescriptor = {
    symbol: opts.offerSymbol,
    faucetId: await hexFaucetToBech32(maker, offerFaucetHex),
    decimals: opts.offerDecimals ?? 8,
    logoSymbol: 'MIDEN'
  };
  const request: SwapTokenDescriptor = {
    symbol: opts.requestSymbol,
    faucetId: await hexFaucetToBech32(maker, requestFaucetHex),
    decimals: opts.requestDecimals ?? 8,
    logoSymbol: 'ETH'
  };
  const tokens = [offer, request];
  for (const w of [maker, taker]) {
    await w.page.evaluate(
      t => (window as never as { __TEST_SET_SWAP_TOKENS__: (t: unknown) => void }).__TEST_SET_SWAP_TOKENS__(t),
      tokens
    );
    await w.page.route(PRICE_FEED_GLOB, r => r.abort());
  }
  return { offer, request, offerFaucetHex, requestFaucetHex };
}

export interface CreateOrderOptions {
  offerSymbol: string;
  requestSymbol: string;
  /** human amounts as typed in the UI, e.g. '10'. */
  payAmount: string;
  receiveAmount: string;
}

/** Drive the `#/swap` UI to create a maker order; returns the new on-chain orderId. */
export async function createSwapOrder(maker: Wallet, opts: CreateOrderOptions): Promise<string> {
  const { page, extensionId } = maker;
  // Capture pre-existing orders so we return the one THIS call creates, even
  // when the same wallet has made earlier orders in a serial spec.
  const before = new Set(await readSwapOrderIds(page));

  await page.goto(`chrome-extension://${extensionId}/fullpage.html#/swap`);
  await expect(page.getByTestId('swap-flow')).toBeVisible({ timeout: 30_000 });

  await page.getByTestId('send-token-selector').first().click();
  await page.getByTestId(`swap-token-${opts.offerSymbol}`).click();
  await page.getByTestId('send-amount-input').first().fill(opts.payAmount);
  await page.getByTestId('send-token-selector').nth(1).click();
  await page.getByTestId(`swap-token-${opts.requestSymbol}`).click();
  await page.getByTestId('send-amount-input').nth(1).fill(opts.receiveAmount);

  await page.getByTestId('swap-review-submit').click();
  await page.getByTestId('swap-submit').click();
  await page.waitForURL(/generating-transaction/, { timeout: 60_000 });

  let orderId = '';
  await expect
    .poll(
      async () => {
        orderId = (await readSwapOrderIds(page)).find(id => !before.has(id)) ?? '';
        return orderId;
      },
      { timeout: 90_000, intervals: [3000] }
    )
    .not.toBe('');
  return orderId;
}

/** All swap-order ids in the SDK's Dexie `transactions` store (stringified bigints). */
async function readSwapOrderIds(page: Page): Promise<string[]> {
  return page.evaluate(async () => {
    const idb = (window as unknown as { indexedDB: IDBFactory }).indexedDB;
    const db: IDBDatabase = await new Promise((res, rej) => {
      const r = idb.open('TridentMain');
      r.onsuccess = () => res(r.result);
      r.onerror = () => rej(r.error);
    });
    try {
      if (!db.objectStoreNames.contains('transactions')) return [];
      const all: Array<{ type?: string; extraInputs?: { orderId?: unknown } }> = await new Promise((res, rej) => {
        const r = db.transaction('transactions', 'readonly').objectStore('transactions').getAll();
        r.onsuccess = () => res(r.result);
        r.onerror = () => rej(r.error);
      });
      return all
        .filter(t => t.type === 'swap' && t.extraInputs?.orderId != null)
        .map(t => String(t.extraInputs!.orderId));
    } finally {
      db.close();
    }
  });
}

/** Raw sent-note info for the maker (id + tag + noteType per output note). */
async function readMakerSent(maker: Wallet): Promise<Array<{ id?: string; tag?: string; noteType?: string }>> {
  const info = (await swOf(maker).evaluate(() =>
    (globalThis as unknown as { __TEST_PSWAP_ORDER_INFO__: () => unknown }).__TEST_PSWAP_ORDER_INFO__()
  )) as { sent?: Array<{ id?: string; tag?: string; noteType?: string }> };
  return info?.sent ?? [];
}

/** The maker's own note tag (the taker discovers by this; buildSwapTag can't reproduce it). */
export async function readMakerTag(maker: Wallet): Promise<string | undefined> {
  return (await readMakerSent(maker))[0]?.tag;
}

/**
 * ALL of the maker's sent-note tags. A standard maker has just the swap note, but
 * a guardian maker can have several sent notes, so the taker must subscribe to
 * every tag to be sure the swap note is among the synced notes.
 */
export async function readMakerTags(maker: Wallet): Promise<string[]> {
  const tags = (await readMakerSent(maker)).map(s => s.tag).filter((t): t is string => !!t && t !== '?');
  return [...new Set(tags)];
}

export interface FillSwapOptions {
  taker: Wallet;
  takerAddress: string;
  orderId: string;
  offer: SwapTokenDescriptor;
  request: SwapTokenDescriptor;
  /** base-unit amounts of the maker's order. */
  offerAmount: string;
  requestAmount: string;
  /** base-unit amount of the REQUEST token the taker provides (<= requestAmount). */
  fillAmount: string;
  /** the maker's real note tag (asU32 decimal); strongly preferred over buildSwapTag. */
  tagU32?: string;
  /** all of the maker's sent-note tags — subscribe to each (guardian makers). */
  tagsU32?: string[];
  noteType?: 'public' | 'private';
}

export interface FillResult {
  ok: boolean;
  error?: string;
  txId?: string;
  noteId?: string;
}

/** Discover the maker note by tag + fill it, signed by the taker's SW vault. */
export async function fillSwapOrder(o: FillSwapOptions): Promise<FillResult> {
  return swOf(o.taker).evaluate(
    (args: unknown) =>
      (globalThis as unknown as { __TEST_PSWAP_CONSUME__: (a: unknown) => Promise<FillResult> }).__TEST_PSWAP_CONSUME__(
        args
      ),
    {
      accountId: o.takerAddress,
      orderId: o.orderId,
      offerFaucetId: o.offer.faucetId,
      requestFaucetId: o.request.faucetId,
      offerAmount: o.offerAmount,
      requestAmount: o.requestAmount,
      noteType: o.noteType ?? 'public',
      fillAmount: o.fillAmount,
      tagU32: o.tagU32,
      tagsU32: o.tagsU32
    }
  ) as Promise<FillResult>;
}

export interface LineageInfo {
  ok: boolean;
  state: 'active' | 'filled' | 'reclaimed' | null;
  remainingOffered?: string;
  remainingRequested?: string;
  error?: string;
}

/** Read the maker order's on-chain lineage (syncs the maker client first). */
export async function readLineage(maker: Wallet, orderId: string): Promise<LineageInfo> {
  return swOf(maker).evaluate(
    (id: string) =>
      (
        globalThis as unknown as { __TEST_PSWAP_LINEAGE__: (id: string) => Promise<LineageInfo> }
      ).__TEST_PSWAP_LINEAGE__(id),
    orderId
  ) as Promise<LineageInfo>;
}

/** An account's on-chain balance for a faucet, in base units. */
export async function tokenBalance(w: Wallet, accountId: string, faucetId: string): Promise<bigint> {
  const r = (await swOf(w).evaluate(
    (a: unknown) =>
      (
        globalThis as unknown as { __TEST_TOKEN_BALANCE__: (a: unknown) => Promise<{ balance?: string }> }
      ).__TEST_TOKEN_BALANCE__(a),
    { accountId, faucetId }
  )) as { balance?: string };
  return BigInt(r?.balance ?? '0');
}

export interface CancelResult {
  ok: boolean;
  error?: string;
  txId?: string;
}

/** Reclaim the maker's own order note, signed by the maker's SW vault. */
export async function cancelSwapOrder(maker: Wallet, orderId: string): Promise<CancelResult> {
  return swOf(maker).evaluate(
    (id: string) =>
      (
        globalThis as unknown as { __TEST_PSWAP_CANCEL__: (a: { orderId: string }) => Promise<CancelResult> }
      ).__TEST_PSWAP_CANCEL__({ orderId: id }),
    orderId
  ) as Promise<CancelResult>;
}
