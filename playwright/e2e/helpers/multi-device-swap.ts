/**
 * Swap helpers of the multi-device suite (`playwright/e2e/tests/multi-device/swap-*.spec.ts`).
 *
 * Two devices hold one Guardian account. One device places a PSWAP order; a third
 * wallet (another account) fills it. Repo CLAUDE.md, "One note, several devices",
 * gives the product rules these helpers read:
 *
 * - Swap paybacks: only the device that placed the order claims its paybacks
 *   unattended. The other device flags the payback `peerSwapPayback`, keeps it out
 *   of the claim list for `PEER_SWAP_PAYBACK_HOLD_SECONDS` after its block, and does
 *   not record it in the seen-note record of the service worker while it is held.
 * - Swap receipt on the other devices: that device has no lineage for the order, so
 *   its receipt takes the fill only from the claim rows that the backup restored
 *   (`swapPaybackAmounts`).
 *
 * Every read here comes from real product state: the rendered UI, the wallet's own
 * IndexedDB rows and its extension storage. No wait here is a bare sleep for product
 * state: each wait polls a condition and fails with what it saw.
 */
import { expect, type Locator, type Page } from '@playwright/test';

import { txStatusName } from './history';
import type { MidenCli } from './miden-cli';
import { describeRows, type HistoryRow, type HistoryStatus, readHistory, requestBackupRefresh } from './multi-device';
import {
  DEFAULT_FUND_AMOUNT,
  exportMakerNote,
  fundSwapPair,
  readMakerNoteId,
  type SwapPair,
  tokenBalance,
  triggerSwapAutoConsume
} from './swap';
import { openSwapDocument } from './swap-document';
import { isRecord } from '../../../src/lib/update/guards';
import type { GuardianAwareWalletPage } from '../fixtures/multi-device';
import type { TimelineRecorder } from '../harness/timeline-recorder';

// ── Product constants (mirrored) ───────────────────────────────────────────

/**
 * Mirrors `PEER_SWAP_PAYBACK_HOLD_SECONDS` in src/lib/miden/swap/classification.ts.
 * That module loads Dexie and the WASM client, so the Playwright process does not
 * import it. `multi-device-swap.test.ts` reads the product source and pins the two.
 */
export const PEER_SWAP_PAYBACK_HOLD_SECONDS = 10 * 60;

/**
 * The block time and the clock of this machine can differ by some seconds. Inside
 * this margin around the end of the hold, a sample makes no claim about the hold.
 */
export const HOLD_EDGE_SECONDS = 15;

/** `ACTIVITY_PENDING_PATH` in src/app/pages/activity-paths.ts: the Pending list of the Activity tab. */
export const ACTIVITY_PENDING_HASH = '/history?filter=pending&view=list';

/** The service worker writes the consumable notes here on each sync (`SyncData` in sync-manager.ts). */
const SYNC_DATA_KEY = 'miden_sync_data';

/** `STORAGE_KEY` in src/lib/miden/back/note-checker-storage.ts: the notes the service worker announced. */
const SEEN_NOTE_IDS_KEY = 'miden_seen_note_ids';

/** The text of an amount that the receipt cannot state (`SwapDetail`: unknown, not zero). */
export const UNKNOWN_AMOUNT = '-';

// ── Pure helpers ───────────────────────────────────────────────────────────

/** Return `value`, or fail with `name` when a step that sets it did not run. */
export function must<T>(value: T | undefined, name: string): T {
  if (value === undefined) throw new Error(`${name} is not set: an earlier step did not complete`);
  return value;
}

/**
 * True when two faucet ids name the same faucet. A bech32 id can carry a routing
 * suffix after `_`, and the case can differ between producers.
 */
export function sameFaucetId(a: string, b: string): boolean {
  const key = (id: string): string => id.trim().toLowerCase().split('_')[0] ?? '';
  return key(a) !== '' && key(a) === key(b);
}

export interface FillProgressText {
  /** The filled amount as shown, or {@link UNKNOWN_AMOUNT}. */
  filled: string;
  /** The requested total as shown, with the symbol when the receipt knows it. */
  total: string;
}

/**
 * Parse the receipt's progress line (`swapAmountProgress` in en.json:
 * "$filled$ of $total$$symbol$ filled"). Returns `null` for other text.
 */
export function parseFillProgress(text: string): FillProgressText | null {
  const match = /^(.*?) of (.*) filled$/.exec(text.trim());
  if (match === null) return null;
  const filled = (match[1] ?? '').trim();
  const total = (match[2] ?? '').trim();
  if (filled === '' || total === '') return null;
  return { filled, total };
}

/** The number at the start of a shown amount ("9.99 SWPB" gives 9.99), or `null` when there is none. */
export function leadingAmount(text: string): number | null {
  const match = /^\d[\d,]*(\.\d+)?/.exec(text.trim());
  if (match === null) return null;
  const value = Number(match[0].replace(/,/g, ''));
  return Number.isFinite(value) ? value : null;
}

/** One consumable note as the service worker stored it for the popup. */
export interface SyncNoteView {
  id: string;
  faucetId: string;
  /** Base units, as a decimal string. */
  amount: string;
  peerSwapPayback: boolean;
  /** The note's block time, in Unix seconds, when the service worker could read it. */
  receivedAt: number | undefined;
  /** The popup lists a note only when it has token metadata, so without it a "not listed" read proves nothing. */
  hasMetadata: boolean;
  /** Classified as a note of one of this device's own swap orders. */
  ownSwapOrderNote: boolean;
}

export interface SyncDataView {
  accountPublicKey: string | undefined;
  notes: SyncNoteView[];
}

/** Read the `miden_sync_data` value of extension storage. Anything malformed reads as no notes. */
export function toSyncData(raw: unknown): SyncDataView {
  if (!isRecord(raw)) return { accountPublicKey: undefined, notes: [] };
  const accountPublicKey = typeof raw.accountPublicKey === 'string' ? raw.accountPublicKey : undefined;
  const list = Array.isArray(raw.notes) ? raw.notes : [];
  const notes: SyncNoteView[] = [];
  for (const entry of list) {
    if (!isRecord(entry) || typeof entry.id !== 'string' || typeof entry.faucetId !== 'string') continue;
    notes.push({
      id: entry.id,
      faucetId: entry.faucetId,
      amount: typeof entry.amountBaseUnits === 'string' ? entry.amountBaseUnits : '',
      peerSwapPayback: entry.peerSwapPayback === true,
      receivedAt: typeof entry.receivedAt === 'number' ? entry.receivedAt : undefined,
      hasMetadata: isRecord(entry.metadata),
      ownSwapOrderNote: isRecord(entry.swapOrder)
    });
  }
  return { accountPublicKey, notes };
}

/** Read the `miden_seen_note_ids` value of extension storage. */
export function toSeenNoteIds(raw: unknown): Set<string> {
  if (!Array.isArray(raw)) return new Set();
  return new Set(raw.filter((id): id is string => typeof id === 'string'));
}

/** The Unix second at which the claim list stops holding back a peer payback received at `receivedAt`. */
export function holdEndsAt(receivedAt: number): number {
  return receivedAt + PEER_SWAP_PAYBACK_HOLD_SECONDS;
}

/** One look at the other device while a peer payback can be on it. */
export interface PaybackSample {
  /** The payback in the service worker's note list, or `undefined` when the list does not hold it. */
  note: SyncNoteView | undefined;
  /** The Pending list was on screen and rendered, so `listed` is a real read. */
  listLive: boolean;
  /** The Pending list shows a card for the payback. */
  listed: boolean;
  /** The seen-note record holds the payback. */
  seen: boolean;
  /** Claim rows that THIS device made for the payback (restored rows excluded). */
  ownClaimRowIds: string[];
  nowSeconds: number;
}

export interface PaybackVerdict {
  /** The sample is inside the hold (clear of the edge margin). */
  held: boolean;
  violations: string[];
}

/**
 * Judge one sample against the multi-device rules. A payback must carry the peer
 * flag and a receive time; inside the hold it must not be listed or recorded as
 * seen; and this device must never make a claim row for it.
 */
export function judgePaybackSample(sample: PaybackSample): PaybackVerdict {
  const violations: string[] = [];
  const { note } = sample;
  if (sample.ownClaimRowIds.length > 0) {
    violations.push(`this device made claim rows ${sample.ownClaimRowIds.join(', ')} for a peer payback`);
  }
  if (note === undefined) return { held: false, violations };
  if (!note.peerSwapPayback) violations.push(`payback ${note.id} is not flagged as a peer payback on this device`);
  if (note.receivedAt === undefined) {
    violations.push(`payback ${note.id} has no receive time, so the claim list does not hold it back`);
    return { held: false, violations };
  }
  const held = sample.nowSeconds < holdEndsAt(note.receivedAt) - HOLD_EDGE_SECONDS;
  if (held && sample.listLive && sample.listed) {
    violations.push(`payback ${note.id} is listed as a transfer to accept inside the hold`);
  }
  if (held && sample.seen) violations.push(`payback ${note.id} is in the seen-note record inside the hold`);
  return { held, violations };
}

export const statusName = (status: number): HistoryStatus | undefined => txStatusName(status);

// ── Extension storage reads ────────────────────────────────────────────────

async function readExtensionStorage(page: Page, keys: string[]): Promise<Record<string, unknown>> {
  return page.evaluate(
    wanted =>
      new Promise<Record<string, unknown>>(resolve => {
        chrome.storage.local.get(wanted, items => resolve(items ?? {}));
      }),
    keys
  );
}

/** The consumable notes the service worker of `wallet` stored on its last sync. */
export async function readSyncNotes(wallet: GuardianAwareWalletPage): Promise<SyncDataView> {
  return toSyncData((await readExtensionStorage(wallet.page, [SYNC_DATA_KEY]))[SYNC_DATA_KEY]);
}

/** The note ids the service worker of `wallet` recorded as seen (its notification dedup). */
export async function readSeenNoteIds(wallet: GuardianAwareWalletPage): Promise<Set<string>> {
  return toSeenNoteIds((await readExtensionStorage(wallet.page, [SEEN_NOTE_IDS_KEY]))[SEEN_NOTE_IDS_KEY]);
}

// ── Swap rows (IndexedDB) ──────────────────────────────────────────────────

/** A `swap` row: one placed order. */
export interface SwapOrderRow {
  id: string;
  status: HistoryStatus | undefined;
  /** The on-chain order id (decimal), set once the order completed. */
  orderId: string | undefined;
  /** Unix seconds; the settlement reclaims the order after it. */
  expiresAt: number | undefined;
  restoredFromBackup: boolean;
}

/** A `consume` row that settlement linked to a swap order. */
export interface SwapClaimRow {
  id: string;
  status: HistoryStatus | undefined;
  noteIds: string[];
  /** The `swap` row this claim belongs to. */
  swapOrderTxId: string | undefined;
  /** `'reclaim'` for the remainder taken back; else a payback claim. */
  swapSettleKind: string | undefined;
  /** What each payback of the claim paid, by note id, in base units. */
  swapPaybackAmounts: Record<string, string>;
  restoredFromBackup: boolean;
}

export interface SwapLedger {
  orders: SwapOrderRow[];
  /** Every consume row, linked to an order or not. */
  claims: SwapClaimRow[];
}

/** One transaction row as plain JSON. The page builds it, so only plain values cross the evaluate boundary. */
interface RawLedgerRow {
  id: string;
  type: string;
  status: number;
  noteIds: string[];
  restoredFromBackup: boolean;
  orderId: string | undefined;
  expiresAt: number | undefined;
  swapOrderTxId: string | undefined;
  swapSettleKind: string | undefined;
  swapPaybackAmounts: Record<string, string>;
}

/** The swap rows and the consume rows of `wallet` (the Dexie `TridentMain.transactions` store). */
export async function readSwapLedger(wallet: GuardianAwareWalletPage): Promise<SwapLedger> {
  const raw = await wallet.page.evaluate(async (): Promise<RawLedgerRow[]> => {
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open('TridentMain');
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    try {
      if (!db.objectStoreNames.contains('transactions')) return [];
      const rows: RawLedgerRow[] = [];
      await new Promise<void>((resolve, reject) => {
        const cursor = db.transaction('transactions', 'readonly').objectStore('transactions').openCursor();
        cursor.onsuccess = () => {
          const current = cursor.result;
          if (current === null) {
            resolve();
            return;
          }
          const value: unknown = current.value;
          if (typeof value === 'object' && value !== null) {
            const field = (key: string): unknown => Reflect.get(value, key);
            const extraValue = field('extraInputs');
            const extra = (key: string): unknown =>
              typeof extraValue === 'object' && extraValue !== null ? Reflect.get(extraValue, key) : undefined;
            const text = (input: unknown): string | undefined => {
              switch (typeof input) {
                case 'string':
                  return input;
                case 'bigint':
                case 'number':
                  return input.toString();
                default:
                  return undefined;
              }
            };
            const noteIds: string[] = [];
            const listed = field('noteIds');
            if (Array.isArray(listed)) {
              for (const id of listed) if (typeof id === 'string') noteIds.push(id);
            }
            const single = field('noteId');
            if (typeof single === 'string' && !noteIds.includes(single)) noteIds.push(single);
            const amounts: Record<string, string> = {};
            const recorded = extra('swapPaybackAmounts');
            if (typeof recorded === 'object' && recorded !== null) {
              for (const [noteId, amount] of Object.entries(recorded)) {
                const amountText = text(amount);
                if (amountText !== undefined) amounts[noteId] = amountText;
              }
            }
            const status = field('status');
            const expiresAt = extra('expiresAt');
            const settleKind = extra('swapSettleKind');
            const orderTxId = extra('swapOrderTxId');
            rows.push({
              id: String(field('id')),
              type: text(field('type')) ?? '',
              status: typeof status === 'number' ? status : -1,
              noteIds,
              restoredFromBackup: field('restoredFromBackup') === true,
              orderId: text(extra('orderId')),
              expiresAt: typeof expiresAt === 'number' ? expiresAt : undefined,
              swapOrderTxId: typeof orderTxId === 'string' ? orderTxId : undefined,
              swapSettleKind: typeof settleKind === 'string' ? settleKind : undefined,
              swapPaybackAmounts: amounts
            });
          }
          current.continue();
        };
        cursor.onerror = () => reject(cursor.error);
      });
      return rows;
    } finally {
      db.close();
    }
  });
  const orders: SwapOrderRow[] = [];
  const claims: SwapClaimRow[] = [];
  for (const row of raw) {
    switch (row.type) {
      case 'swap':
        orders.push({
          id: row.id,
          status: statusName(row.status),
          orderId: row.orderId,
          expiresAt: row.expiresAt,
          restoredFromBackup: row.restoredFromBackup
        });
        break;
      case 'consume':
        claims.push({
          id: row.id,
          status: statusName(row.status),
          noteIds: row.noteIds,
          swapOrderTxId: row.swapOrderTxId,
          swapSettleKind: row.swapSettleKind,
          swapPaybackAmounts: row.swapPaybackAmounts,
          restoredFromBackup: row.restoredFromBackup
        });
        break;
      default:
        break;
    }
  }
  return { orders, claims };
}

/** The claim rows THIS device made (restored rows excluded) that name `noteId`. */
export function ownClaimsOfNote(ledger: SwapLedger, noteId: string): SwapClaimRow[] {
  return ledger.claims.filter(claim => !claim.restoredFromBackup && claim.noteIds.includes(noteId));
}

// ── Balances ───────────────────────────────────────────────────────────────

/**
 * Wait until `accountId` holds exactly `expected` of `faucetId`, as the service
 * worker of `wallet` reads its own vault. While a note of that faucet waits in the
 * list, accept it with the real Pending list (`claimAllNotes`); else ask for one
 * sync and read again.
 *
 * `fundSwapPair` waits for "a balance above zero" before its claim. A Guardian
 * account of this suite already holds the fee asset at that point, so that wait
 * passes at once and the claim can run before the minted note is in the list.
 */
export async function ensureTokenBalance(
  wallet: GuardianAwareWalletPage,
  accountId: string,
  faucetId: string,
  expected: bigint,
  timeoutMs = 300_000
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const balance = await tokenBalance(wallet, accountId, faucetId);
    if (balance === expected) return;
    if (Date.now() > deadline) {
      throw new Error(`ensureTokenBalance: ${accountId} holds ${balance} of ${faucetId}, expected ${expected}`);
    }
    const { notes } = await readSyncNotes(wallet);
    if (notes.some(note => sameFaucetId(note.faucetId, faucetId))) {
      await wallet.claimAllNotes(Math.max(60_000, deadline - Date.now()));
    } else {
      await wallet.triggerSync();
    }
  }
}

/** Poll until `accountId` holds exactly `expected` of `faucetId`, as the service worker of `wallet` reads it. */
export async function expectTokenBalance(
  wallet: GuardianAwareWalletPage,
  accountId: string,
  faucetId: string,
  expected: bigint,
  description: string,
  timeoutMs = 180_000
): Promise<void> {
  await expect
    .poll(async () => (await tokenBalance(wallet, accountId, faucetId)).toString(), {
      message: description,
      timeout: timeoutMs,
      intervals: [3_000]
    })
    .toBe(expected.toString());
}

export interface SwapDevices {
  /** The address of the taker's own account (a different account from the shared one). */
  takerAddress: string;
  pair: SwapPair;
}

/**
 * Create the taker's account on `taker`, deploy the two test faucets (SWPA is the
 * offer, SWPB the request), mint SWPA to the shared account and SWPB to the taker,
 * and wait until each side holds its minted amount. The placing device accepts the
 * SWPA note; the other device of the account does nothing.
 *
 * `fundSwapPair` serves the quote stubs and the swap token registry on the placing
 * device and the taker only. The other device never opens the swap screen.
 */
export async function fundSwapDevices(options: {
  placing: GuardianAwareWalletPage;
  taker: GuardianAwareWalletPage;
  sharedAddress: string;
  midenCli: MidenCli;
  timeline?: TimelineRecorder;
}): Promise<SwapDevices> {
  const { placing, taker, sharedAddress, midenCli, timeline } = options;
  const takerAddress = (await taker.createNewWallet()).address;
  const pair = await fundSwapPair(
    midenCli,
    placing,
    taker,
    { offerSymbol: 'SWPA', requestSymbol: 'SWPB', balanceTimeoutMs: 300_000 },
    timeline
  );
  const funded = BigInt(DEFAULT_FUND_AMOUNT);
  await ensureTokenBalance(placing, sharedAddress, pair.offer.faucetId, funded);
  await ensureTokenBalance(taker, takerAddress, pair.request.faucetId, funded);
  return { takerAddress, pair };
}

// ── The Pending list ───────────────────────────────────────────────────────

/** The card of `noteId` on the Pending list (`PendingActivityCard`). */
export function pendingCard(wallet: GuardianAwareWalletPage, noteId: string): Locator {
  const row = wallet.page.locator(`[data-testid="pending-activity-row"][data-entry-key="${noteId}"]`);
  return wallet.page.locator('article').filter({ has: row });
}

/** Press Accept on the card of `noteId`: the user accepts the transfer by hand. */
export async function acceptPendingTransfer(wallet: GuardianAwareWalletPage, noteId: string): Promise<void> {
  const accept = pendingCard(wallet, noteId).getByTestId('pending-activity-accept');
  await expect(accept, `the card of ${noteId} offers Accept`).toBeEnabled({ timeout: 60_000 });
  await accept.click();
}

// ── Placing an order ───────────────────────────────────────────────────────

/** The expiry presets of the swap review (`EXPIRY_PRESETS` in src/screens/swap-flow/expiry.ts). */
export type SwapExpiryPreset = '2m' | '1h' | '1d' | '7d';

export interface PlaceOrderOptions {
  /** Exact human amount typed as the pay amount. */
  payAmount: string;
  /** The read-only receive quote the review must show. */
  receiveAmount: string;
  /** The expiry preset to choose on the review. */
  expiry: SwapExpiryPreset;
}

export interface PlacedOrder {
  /** The on-chain order id (decimal). */
  orderId: string;
  /** The `swap` row id: the receipt route and the `swapOrderTxId` of its claims. */
  rowId: string;
  /** Unix seconds, stamped at completion from the chosen preset. */
  expiresAt: number | undefined;
}

/**
 * Drive the real `#/swap` UI on `maker` to place an order with the chosen expiry
 * preset, and wait until its row completes with an order id.
 *
 * The same steps as `createSwapOrder` in swap.ts, plus the expiry choice. The
 * two-minute default of that helper lets the settlement reclaim the order before a
 * fill on testnet can land; it also hides a partial payback from the placing device
 * until the order expires, which is the state a spec reads.
 */
export async function placeSwapOrder(
  maker: GuardianAwareWalletPage,
  pair: SwapPair,
  options: PlaceOrderOptions
): Promise<PlacedOrder> {
  const { page, extensionId } = maker;
  const before = new Set((await readSwapLedger(maker)).orders.map(order => order.id));

  // The registry override lives in the page's memory, so it is installed again in this document.
  await openSwapDocument(page, extensionId, 'fullpage', [pair.offer, pair.request]);
  const workbench = page.getByTestId('command-shell').getByTestId('command-workbench');
  const composer = workbench.getByTestId('swap-flow').getByTestId('command-swap-composer');
  const footer = workbench.getByTestId('command-footer');
  await expect(composer).toBeVisible({ timeout: 30_000 });
  await expect(footer.getByTestId('swap-review-submit')).toBeVisible();

  await composer.getByTestId('send-token-selector').click();
  await page.getByTestId(`swap-token-${pair.offer.symbol}`).click();
  const receive = page.getByTestId('command-swap-receive');
  await receive.getByRole('button', { name: 'You Receive' }).click();
  await page.getByTestId(`swap-token-${pair.request.symbol}`).click();
  await expect(receive.getByTestId('send-amount-input')).toHaveCount(0);
  const payInput = composer.getByTestId('send-amount-input');
  await payInput.fill(options.payAmount);
  await expect(payInput).toHaveValue(options.payAmount);
  await expect(receive.getByText(options.receiveAmount, { exact: true })).toHaveCount(1);

  await footer.getByTestId('swap-review-submit').click();
  await expect(workbench.getByText(`≈ ${options.receiveAmount} ${pair.request.symbol}`, { exact: true })).toHaveCount(
    1
  );
  const preset = page.getByTestId(`swap-expiry-preset-${options.expiry}`);
  await preset.click();
  await expect(preset, `the ${options.expiry} expiry preset must be selected`).toHaveAttribute('aria-checked', 'true');
  await footer.getByTestId('swap-submit').click();
  await page.waitForURL(/generating-transaction/, { timeout: 60_000 });

  let placed: SwapOrderRow | undefined;
  await expect
    .poll(
      async () => {
        placed = (await readSwapLedger(maker)).orders.find(
          order => !before.has(order.id) && order.status === 'Completed' && order.orderId !== undefined
        );
        return placed !== undefined;
      },
      { message: 'the placed swap order completes with an order id', timeout: 300_000, intervals: [3_000] }
    )
    .toBe(true)
    .catch(async (error: unknown) => {
      const failed = (await readHistory(maker)).filter(row => row.status === 'Failed');
      throw new Error(
        `placeSwapOrder: no completed order. Failed rows:\n  ${describeRows(failed)}\n` +
          `${error instanceof Error ? error.message : ''}`
      );
    });
  const order = must(placed, 'the placed order');
  return { orderId: must(order.orderId, 'the order id'), rowId: order.id, expiresAt: order.expiresAt };
}

/**
 * Export the order note of `orderId` from the placing device as a full note file
 * (hex), for the deterministic hand-over to the taker (`fillSwapOrder` with
 * `noteFileHex`). The export needs the note committed with its inclusion proof. A
 * Guardian order on testnet commits later than the 90 s that `fillSwapOrder` gives
 * its own export, so this one waits for 180 s.
 */
export async function exportOrderNote(maker: GuardianAwareWalletPage, orderId: string): Promise<string> {
  const noteId = must(await readMakerNoteId(maker, orderId), `the order note of order ${orderId}`);
  return exportMakerNote(maker, noteId, 180_000);
}

// ── Settlement on the placing device ───────────────────────────────────────

/**
 * Wait until the placing device holds a Completed payback claim of the order
 * (`swapOrderTxId` is the order row, `swapSettleKind` is not `'reclaim'`), and
 * return it. Each lap asks the service worker for a sync, which is where the
 * extension runs its settlement (`triggerSwapAutoConsume`).
 */
export async function waitForPaybackClaim(
  maker: GuardianAwareWalletPage,
  orderRowId: string,
  timeoutMs = 300_000
): Promise<SwapClaimRow> {
  let found: SwapClaimRow | undefined;
  let last: SwapClaimRow[] = [];
  await expect
    .poll(
      async () => {
        await triggerSwapAutoConsume(maker);
        last = (await readSwapLedger(maker)).claims.filter(
          claim => claim.swapOrderTxId === orderRowId && !claim.restoredFromBackup
        );
        found = last.find(claim => claim.swapSettleKind !== 'reclaim' && claim.status === 'Completed');
        return found !== undefined;
      },
      { message: 'the placing device claims the payback', timeout: timeoutMs, intervals: [3_000] }
    )
    .toBe(true)
    .catch((error: unknown) => {
      const seen = last.map(claim => `${claim.id.slice(0, 8)} ${claim.status} ${claim.swapSettleKind ?? 'settle'}`);
      throw new Error(
        `waitForPaybackClaim: no completed payback claim. Linked rows: ${seen.join('; ') || 'none'}\n` +
          `${error instanceof Error ? error.message : ''}`
      );
    });
  return must(found, 'the payback claim');
}

/** Wait until the placing device holds a Completed reclaim of the order's remainder, and return it. */
export async function waitForRemainderReclaim(
  maker: GuardianAwareWalletPage,
  orderRowId: string,
  timeoutMs = 300_000
): Promise<SwapClaimRow> {
  let found: SwapClaimRow | undefined;
  await expect
    .poll(
      async () => {
        await triggerSwapAutoConsume(maker);
        found = (await readSwapLedger(maker)).claims.find(
          claim =>
            claim.swapOrderTxId === orderRowId &&
            !claim.restoredFromBackup &&
            claim.swapSettleKind === 'reclaim' &&
            claim.status === 'Completed'
        );
        return found !== undefined;
      },
      { message: 'the placing device takes the remainder back', timeout: timeoutMs, intervals: [3_000] }
    )
    .toBe(true);
  return must(found, 'the remainder reclaim');
}

// ── Receipts ───────────────────────────────────────────────────────────────

export interface SwapReceiptView extends FillProgressText {
  /** The full progress line as shown. */
  raw: string;
  /** "Cancel swap" is on screen. */
  cancelOffered: boolean;
}

/**
 * Open the receipt of the swap row `rowId` and read it once. The route goes home
 * first, so the receipt mounts again and reads its rows afresh.
 */
export async function readSwapReceipt(wallet: GuardianAwareWalletPage, rowId: string): Promise<SwapReceiptView> {
  await wallet.navigateHome();
  await wallet.navigateTo(`/history-details/${rowId}`);
  const card = wallet.page.getByTestId('swap-order-card');
  await card.waitFor({ state: 'visible', timeout: 60_000 });
  const raw = (await card.getByTestId('swap-order-amount-filled').innerText()).trim();
  const parsed = parseFillProgress(raw);
  if (parsed === null) throw new Error(`readSwapReceipt: unexpected progress line "${raw}"`);
  const cancelOffered = (await wallet.page.getByTestId('swap-cancel-order-button').count()) > 0;
  return { ...parsed, raw, cancelOffered };
}

/** Read the receipt of `rowId` until `accept` holds, and return that read. */
export async function waitForSwapReceipt(
  wallet: GuardianAwareWalletPage,
  rowId: string,
  accept: (view: SwapReceiptView) => boolean,
  description: string,
  timeoutMs = 120_000
): Promise<SwapReceiptView> {
  let last: SwapReceiptView | undefined;
  await expect
    .poll(
      async () => {
        last = await readSwapReceipt(wallet, rowId);
        return accept(last);
      },
      { message: description, timeout: timeoutMs, intervals: [3_000] }
    )
    .toBe(true)
    .catch((error: unknown) => {
      throw new Error(
        `waitForSwapReceipt(${description}): last read "${last?.raw ?? 'none'}" ` +
          `cancel=${String(last?.cancelOffered)}\n${error instanceof Error ? error.message : ''}`
      );
    });
  return must(last, 'the receipt read');
}

// ── Backup ─────────────────────────────────────────────────────────────────

/**
 * Ask `wallet` for a backup refresh (the request the UI sends) until its rows
 * match `predicate`. Returns the rows of the matching read.
 */
export async function waitForRestoredRows(
  wallet: GuardianAwareWalletPage,
  predicate: (rows: readonly HistoryRow[]) => boolean,
  description: string,
  timeoutMs = 180_000
): Promise<HistoryRow[]> {
  let rows: HistoryRow[] = [];
  let outcome = 'not asked';
  await expect
    .poll(
      async () => {
        outcome = await requestBackupRefresh(wallet, 'foreground');
        rows = await readHistory(wallet);
        return predicate(rows);
      },
      { message: description, timeout: timeoutMs, intervals: [3_000] }
    )
    .toBe(true)
    .catch((error: unknown) => {
      throw new Error(
        `waitForRestoredRows(${description}): last refresh "${outcome}". Rows:\n  ${describeRows(rows)}\n` +
          `${error instanceof Error ? error.message : ''}`
      );
    });
  return rows;
}

// ── The other device during the hold ───────────────────────────────────────

export interface PeerPaybackWatchReport {
  /** Each payback of the requested faucet that the other device listed in its notes, by note id. */
  observed: SyncNoteView[];
  /** Samples taken inside the hold while the Pending list was live. */
  heldListSamples: number;
  samples: number;
  /** The first time (Unix seconds) the Pending list showed a card for each payback, by note id. */
  firstListedAt: Record<string, number>;
  violations: string[];
  /** Reads that failed (a navigation in progress, for example). They are no verdict. */
  sampleErrors: string[];
}

/** The progress bar that the Pending list shows while it fetches its history and notes (`ClaimsLoadingBar`). */
const PENDING_LOADING_BAR = '[role="progressbar"][aria-label="Fetching your transaction history and notes"]';

/**
 * The Pending list is on screen and has finished its fetch, so a missing card is a real read. The header renders
 * before the list's data arrives, so a loading list is no sample.
 */
export function pendingListRendered(view: { url: string; viewButtons: number; loadingBars: number }): boolean {
  return view.url.includes('filter=pending') && view.viewButtons > 0 && view.loadingBars === 0;
}

/**
 * Sample the other device while a peer payback can be on it. Each lap reads the
 * service worker's note list, the seen-note record, the Pending list on screen
 * and this device's claim rows, and judges them with {@link judgePaybackSample}.
 * A lap is paced by one wallet sync, which waits for the service worker's own
 * SyncCompleted signal. Put the device on the Pending list
 * ({@link ACTIVITY_PENDING_HASH}) first: elsewhere a lap makes no list read.
 */
export class PeerPaybackWatch {
  private readonly wallet: GuardianAwareWalletPage;
  private readonly requestFaucetId: string;
  private readonly observed = new Map<string, SyncNoteView>();
  private readonly firstListedAt: Record<string, number> = {};
  private readonly violations = new Set<string>();
  private readonly sampleErrors: string[] = [];
  private samples = 0;
  private heldListSamples = 0;
  private stopped = false;
  private readonly loop: Promise<void>;

  constructor(wallet: GuardianAwareWalletPage, requestFaucetId: string) {
    this.wallet = wallet;
    this.requestFaucetId = requestFaucetId;
    this.loop = this.run();
  }

  /** What the watch saw so far. It keeps running. */
  report(): PeerPaybackWatchReport {
    return {
      observed: [...this.observed.values()],
      heldListSamples: this.heldListSamples,
      samples: this.samples,
      firstListedAt: { ...this.firstListedAt },
      violations: [...this.violations],
      sampleErrors: [...this.sampleErrors]
    };
  }

  /** Stop after the lap in progress, and return what the watch saw. */
  async stop(): Promise<PeerPaybackWatchReport> {
    this.stopped = true;
    await this.loop;
    return this.report();
  }

  private async run(): Promise<void> {
    // A closed page ends the watch: a failed test closes the browser before the spec can stop it.
    while (!this.stopped && !this.wallet.page.isClosed()) {
      try {
        await this.sample();
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (this.sampleErrors.length < 20) this.sampleErrors.push(message);
      }
      if (this.stopped) break;
      await this.wallet.triggerSync().catch(() => undefined);
    }
  }

  private async sample(): Promise<void> {
    const page = this.wallet.page;
    const { notes } = await readSyncNotes(this.wallet);
    const seen = await readSeenNoteIds(this.wallet);
    const ledger = await readSwapLedger(this.wallet);
    const listLive = pendingListRendered({
      url: page.url(),
      viewButtons: await page.getByTestId('activity-view-button').count(),
      loadingBars: await page.locator(PENDING_LOADING_BAR).count()
    });
    const nowSeconds = Math.floor(Date.now() / 1000);
    this.samples += 1;
    const paybacks = notes.filter(note => sameFaucetId(note.faucetId, this.requestFaucetId));
    for (const note of paybacks) {
      if (!this.observed.has(note.id)) this.observed.set(note.id, note);
      const listed =
        listLive &&
        (await page.locator(`[data-testid="pending-activity-row"][data-entry-key="${note.id}"]`).count()) > 0;
      if (listed && this.firstListedAt[note.id] === undefined) this.firstListedAt[note.id] = nowSeconds;
      const verdict = judgePaybackSample({
        note,
        listLive,
        listed,
        seen: seen.has(note.id),
        ownClaimRowIds: ownClaimsOfNote(ledger, note.id).map(claim => claim.id),
        nowSeconds
      });
      if (verdict.held && listLive) this.heldListSamples += 1;
      for (const violation of verdict.violations) this.violations.add(violation);
    }
    // A payback that already left the note list can still have a claim row of this device.
    for (const noteId of this.observed.keys()) {
      if (paybacks.some(note => note.id === noteId)) continue;
      const verdict = judgePaybackSample({
        note: undefined,
        listLive,
        listed: false,
        seen: false,
        ownClaimRowIds: ownClaimsOfNote(ledger, noteId).map(claim => claim.id),
        nowSeconds
      });
      for (const violation of verdict.violations) this.violations.add(violation);
    }
  }
}

/** Wait until the watch has seen a payback of `amount` base units, and return it. */
export async function waitForObservedPayback(
  watch: PeerPaybackWatch,
  amount: string,
  timeoutMs = 180_000
): Promise<SyncNoteView> {
  let found: SyncNoteView | undefined;
  await expect
    .poll(
      () => {
        found = watch.report().observed.find(note => note.amount === amount);
        return found !== undefined;
      },
      { message: `the other device lists a payback of ${amount}`, timeout: timeoutMs, intervals: [2_000] }
    )
    .toBe(true)
    .catch((error: unknown) => {
      const report = watch.report();
      throw new Error(
        `waitForObservedPayback: observed ${JSON.stringify(report.observed)}, ` +
          `errors ${JSON.stringify(report.sampleErrors)}\n${error instanceof Error ? error.message : ''}`
      );
    });
  return must(found, 'the observed payback');
}

/** Wait until the service worker of `wallet` no longer lists `noteId` (it was consumed). */
export async function waitForNoteGone(
  wallet: GuardianAwareWalletPage,
  noteId: string,
  timeoutMs = 180_000
): Promise<void> {
  await expect
    .poll(
      async () => {
        await wallet.triggerSync();
        return (await readSyncNotes(wallet)).notes.some(note => note.id === noteId);
      },
      { message: `note ${noteId} leaves the note list`, timeout: timeoutMs, intervals: [2_000] }
    )
    .toBe(false);
}

/** Assert a watch report: no violation, the payback seen with its flag and metadata, and enough held list reads. */
export function expectHeldPayback(report: PeerPaybackWatchReport, noteId: string, minHeldListSamples: number): void {
  expect(report.violations, 'the other device must keep the multi-device payback rules').toEqual([]);
  const note = report.observed.find(observed => observed.id === noteId);
  expect(note, `the other device must see payback ${noteId} in its note list`).toBeDefined();
  expect(note?.peerSwapPayback, 'the other device flags the payback as a peer payback').toBe(true);
  expect(note?.receivedAt, 'the payback has a receive time, which starts the hold').toBeDefined();
  // Without metadata the popup lists no note at all, so "not listed" would prove nothing.
  expect(note?.hasMetadata, 'the payback carries token metadata, so the Pending list could list it').toBe(true);
  expect(
    report.heldListSamples,
    `the Pending list must be read inside the hold at least ${minHeldListSamples} times`
  ).toBeGreaterThanOrEqual(minHeldListSamples);
}
