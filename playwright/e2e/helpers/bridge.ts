import { expect, type Page } from '@playwright/test';

import type { MidenCli } from './miden-cli';
import type { ChromeWalletPageApi } from './wallet-page';
import type { TimelineRecorder } from '../harness/timeline-recorder';

/**
 * Driver for the cross-chain bridge E2E suite (Miden -> EVM, "Fast"/Epoch route).
 *
 * The Fast route needs NO connected EVM wallet: the wallet mints a Miden P2IDE
 * note to the Epoch allocator, and the hosted solver fulfils the EVM leg,
 * delivering USDC to the destination address on Sepolia (see
 * `src/lib/epoch/epoch-send.ts`). So this driver only:
 *   - `fundBridgeToken` — mints a fresh faucet token into the wallet (self-mint,
 *     like the swap suite; the Epoch allocator prices any Miden token).
 *   - `bridgeOutFast` — drives the real Send UI: 0x recipient -> Sepolia network ->
 *     token + amount -> Fast route -> review submit.
 *   - `readBridgedSendRows` — reads the `bridged-send` activity row(s) to assert
 *     the Miden leg completed.
 * The Sepolia-side proof (USDC actually arrived) lives in `./sepolia`.
 */

type Wallet = ChromeWalletPageApi;

export interface FundBridgeTokenOptions {
  /** Faucet/token symbol shown in the send token picker. */
  symbol: string;
  /** Token decimals. 6 keeps `bridgeOutFast('1')` a small ~1-USDC solver fill. */
  decimals?: number;
  /** Base units minted to the wallet (default 1e9 = 1000 tokens @ 6dp). */
  amount?: number;
  /** Balance-wait/claim budget (default 150s). */
  balanceTimeoutMs?: number;
}

export interface FundedBridgeToken {
  symbol: string;
  /** hex faucet id as the CLI reports it. */
  faucetHex: string;
  decimals: number;
}

/**
 * Mint a fresh faucet token into the wallet so it has something to bridge. The
 * wallet must already be created. Mirrors the swap suite's `fundSwapPair`, but
 * single-sided (there is no counterparty — the Epoch solver is).
 */
export async function fundBridgeToken(
  midenCli: MidenCli,
  wallet: Wallet,
  opts: FundBridgeTokenOptions,
  timeline?: TimelineRecorder
): Promise<FundedBridgeToken> {
  const decimals = opts.decimals ?? 6;
  const amount = opts.amount ?? 1_000_000_000;
  const timeout = opts.balanceTimeoutMs ?? 150_000;

  await midenCli.init();
  const faucetHex = await midenCli.createFaucet(opts.symbol, decimals);
  const addr = await wallet.getAccountAddress();
  await midenCli.mint(faucetHex, addr, amount, 'public');
  await midenCli.sync();

  await wallet.waitForBalanceAbove(0, timeout, timeline);
  await wallet.claimAllNotes(timeout);

  return { symbol: opts.symbol, faucetHex, decimals };
}

export interface BridgeOutFastOptions {
  /** EVM (0x) recipient — also the Epoch intent sponsor; no connected wallet needed. */
  destAddress: `0x${string}`;
  /** Symbol of the funded token to bridge (matches `fundBridgeToken`). */
  tokenSymbol: string;
  /** Human amount to bridge, as typed in the UI (e.g. '1'). */
  amount: string;
  /** Per-step timeout (default 30s). */
  stepTimeoutMs?: number;
  /** How long to wait for the live Epoch quote before the route can be confirmed (default 60s). */
  quoteTimeoutMs?: number;
}

/**
 * Drive the real Send flow to bridge a token to a 0x address via the Fast (Epoch)
 * route, ending on the generating-transaction screen. UI-only — every step goes
 * through the same widgets a user taps.
 */
export async function bridgeOutFast(wallet: Wallet, opts: BridgeOutFastOptions): Promise<void> {
  const { page, extensionId } = wallet;
  const step = opts.stepTimeoutMs ?? 30_000;

  await page.goto(`chrome-extension://${extensionId}/fullpage.html#/send`);
  await expect(page.getByTestId('send-flow')).toBeVisible({ timeout: step });
  // The home swipe container keeps sibling panes (notably the swap flow) mounted,
  // so shared testids like `send-token-selector` / `send-amount-input` are not
  // unique document-wide. Scope every in-flow interaction to the active send
  // flow; drawers are portaled to the document root and the review is a separate
  // full-screen route, so those stay on `page`.
  const flow = page.getByTestId('send-flow');

  // Recipient: a 0x address flips the flow to cross-chain and reveals the network row.
  await flow.getByTestId('send-recipient-input').fill(opts.destAddress);
  await flow.getByTestId('send-network-selector').click({ timeout: step });
  await page.getByTestId('send-network-sepolia').click({ timeout: step });
  await flow.getByTestId('send-recipient-confirm').click({ timeout: step });

  // Amount: pick the funded token, type the amount.
  await flow.getByTestId('send-token-selector').click({ timeout: step });
  await page.getByTestId(`send-token-${opts.tokenSymbol}`).click({ timeout: step });
  await flow.getByTestId('send-amount-input').fill(opts.amount);
  await flow.getByTestId('send-amount-confirm').click({ timeout: step });

  // Route: Fast (Epoch) is the default. Selecting it explicitly guards against a
  // default change. The confirm button is never disabled, so gate on the real
  // signal instead: the Fast card renders a live Epoch forward-quote fee ("$X.XX")
  // once the quote resolves (a "—"/skeleton until then), so wait for that dollar
  // value — that genuinely exercises the forward-quote before we submit.
  await expect(flow.getByTestId('bridge-route-fast')).toBeVisible({ timeout: step });
  await flow.getByTestId('bridge-route-fast').click();
  await expect(flow.getByTestId('bridge-route-fast')).toContainText('$', { timeout: opts.quoteTimeoutMs ?? 60_000 });
  await flow.getByTestId('bridge-route-confirm').click();

  // Review -> submit -> generating-transaction.
  await page.getByTestId('send-review-submit').click({ timeout: step });
  await page.waitForURL(/generating-transaction/, { timeout: 60_000 });
}

export interface BridgeOutSlowOptions {
  /** EVM (0x) recipient of the bridged asset. */
  destAddress: `0x${string}`;
  /** Symbol of the funded bridgeable token (matches `fundBridgeToken`). */
  tokenSymbol: string;
  /**
   * Hex faucet id of the funded token — the Slow route is hard-gated on the
   * bridgeable faucet, so this points the E2E override at the funded test faucet.
   */
  faucetHex: string;
  /** Human amount to bridge, as typed in the UI (e.g. '1'). */
  amount: string;
  /** Per-step timeout (default 30s). */
  stepTimeoutMs?: number;
}

/**
 * Drive the real Send flow to bridge a token to a 0x address via the Slow
 * (AggLayer) route. Unlike Fast, there is NO live quote — the Slow card shows a
 * fixed "no fee" and `bridge-route-confirm` is never disabled — so nothing is
 * waited on beyond the route becoming ENABLED. The Slow route is gated on the
 * bridgeable faucet token (`slowEnabled`), so the caller MUST have set the E2E
 * faucet override (`__TEST_SET_AGGLAYER_FAUCET__`) to the funded token's faucet
 * BEFORE this call — otherwise `bridge-route-slow` stays disabled and this fails
 * fast at the `toBeEnabled` gate (rather than silently taking the Fast fallback).
 */
export async function bridgeOutSlow(wallet: Wallet, opts: BridgeOutSlowOptions): Promise<void> {
  const { page, extensionId } = wallet;
  const step = opts.stepTimeoutMs ?? 30_000;

  await page.goto(`chrome-extension://${extensionId}/fullpage.html#/send`);
  await expect(page.getByTestId('send-flow')).toBeVisible({ timeout: step });

  // Point the Slow route at the funded test faucet. Set AFTER the page load (the
  // override is a front module var; `fundBridgeToken`'s claim reloads the page,
  // which would reset it) and BEFORE the token is picked, so `isBridgeableToken`
  // is true from the first render and the Slow card is enabled.
  await page.evaluate(id => {
    (globalThis as unknown as { __TEST_SET_AGGLAYER_FAUCET__: (v: string) => void }).__TEST_SET_AGGLAYER_FAUCET__(id);
  }, opts.faucetHex);

  const flow = page.getByTestId('send-flow');

  // Recipient: a 0x address flips the flow to cross-chain and reveals the network row.
  await flow.getByTestId('send-recipient-input').fill(opts.destAddress);
  await flow.getByTestId('send-network-selector').click({ timeout: step });
  await page.getByTestId('send-network-sepolia').click({ timeout: step });
  await flow.getByTestId('send-recipient-confirm').click({ timeout: step });

  // Amount: pick the bridgeable token, type the amount.
  await flow.getByTestId('send-token-selector').click({ timeout: step });
  await page.getByTestId(`send-token-${opts.tokenSymbol}`).click({ timeout: step });
  await flow.getByTestId('send-amount-input').fill(opts.amount);
  await flow.getByTestId('send-amount-confirm').click({ timeout: step });

  // Route: Slow (AggLayer). Enabled only when the token is the bridgeable faucet
  // (the E2E override) — assert that gate opened before selecting it.
  await expect(flow.getByTestId('bridge-route-slow')).toBeEnabled({ timeout: step });
  await flow.getByTestId('bridge-route-slow').click();
  await flow.getByTestId('bridge-route-confirm').click({ timeout: step });

  // Review -> submit -> generating-transaction.
  await page.getByTestId('send-review-submit').click({ timeout: step });
  await page.waitForURL(/generating-transaction/, { timeout: 60_000 });
}

export interface BridgedSendRow {
  /** ITransactionStatus: Queued=0, GeneratingTransaction=1, Completed=2, Failed=3. */
  status: number;
  displayMessage?: string;
  transactionId?: string;
  outputNoteIds?: string[];
  extraInputs?: {
    intentNonce?: string;
    outputAmount?: string;
    evmTxHash?: string;
    /** 'agglayer' (Slow) | 'epoch' (Fast). */
    provider?: string;
    /** AggLayer L1 claim lifecycle: 'pending' | 'ready' | 'claimed'. */
    claimStatus?: string;
  };
}

/**
 * All `bridged-send` rows in the wallet's Dexie `transactions` store, syncing
 * nothing (a pure read of already-persisted rows). A fresh wallet that has done
 * one bridge has exactly one. Mirrors the swap suite's direct IndexedDB read.
 */
export async function readBridgedSendRows(page: Page): Promise<BridgedSendRow[]> {
  return page.evaluate(async () => {
    const idb = (window as unknown as { indexedDB: IDBFactory }).indexedDB;
    const db: IDBDatabase = await new Promise((res, rej) => {
      const r = idb.open('TridentMain');
      r.onsuccess = () => res(r.result);
      r.onerror = () => rej(r.error);
    });
    try {
      if (!db.objectStoreNames.contains('transactions')) return [];
      const all: Array<{
        type?: string;
        status?: number;
        displayMessage?: string;
        transactionId?: string;
        outputNoteIds?: string[];
        extraInputs?: {
          intentNonce?: string;
          outputAmount?: string;
          evmTxHash?: string;
          provider?: string;
          claimStatus?: string;
        };
      }> = await new Promise((res, rej) => {
        const r = db.transaction('transactions', 'readonly').objectStore('transactions').getAll();
        r.onsuccess = () => res(r.result);
        r.onerror = () => rej(r.error);
      });
      return all
        .filter(t => t.type === 'bridged-send')
        .map(t => ({
          status: t.status ?? -1,
          displayMessage: t.displayMessage,
          transactionId: t.transactionId,
          outputNoteIds: t.outputNoteIds,
          extraInputs: t.extraInputs
        }));
    } finally {
      db.close();
    }
  });
}
