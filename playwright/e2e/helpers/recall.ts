/**
 * Recall / reclaim primitives — the P2IDE half of a send.
 *
 * Every same-chain send this wallet makes is a **P2IDE**, not a P2ID:
 * `ReviewTransaction` seeds a 7-day reclaim offset by default, and
 * `miden-client-interface.sendTransaction` turns that RELATIVE offset into the
 * absolute `reclaimAfter` height baked into the note. That makes reclaim one of
 * only two paths where a user's funds come BACK, and until this module existed
 * nothing in the suite touched it: `grep -rniI 'recall|reclaim' playwright/` hit
 * only the swap-order and bridge-collateral lineages, which are different
 * mechanisms entirely.
 *
 * WHAT THE HARNESS NEEDS THAT THE UI CANNOT GIVE IT
 *
 * The shortest window RecallCalendarDrawer offers is 30 minutes (600 blocks), so
 * there is no click path to a recall a test can wait out. `armRecallBlocks`
 * writes the offset the review page's E2E hook reads on mount — the same
 * precedent as `__TEST_SET_SHARE_PRIVATELY__`, which exists because the
 * public/private toggle was removed from the UI.
 *
 * WHAT "RECALL HEIGHT" MEANS IN THE DB, PRECISELY
 *
 * A `send` row persists `extraInputs.recallBlocks` — a RELATIVE offset, in
 * blocks. It is NOT an absolute height, and no absolute height is persisted for
 * a plain send anywhere (`extraInputs.reclaimHeight` in db/types.ts is written
 * only by `markBridgedSendFailed`, for bridged sends). Assertions must say
 * "offset", or they are asserting a field that does not exist.
 */
import type { Page } from '@playwright/test';

/** ITransactionStatus.Completed — see src/lib/miden/db/types.ts. */
export const COMPLETED = 2;

/**
 * One `transactions` row, reduced to the fields a recall assertion needs.
 *
 * `amount` is a STRING: the row stores a bigint and Playwright's `evaluate`
 * bridge cannot serialize one, so it is stringified inside the page.
 */
export interface WalletTxRow {
  id: string;
  type: string;
  /** Queued=0, GeneratingTransaction=1, Completed=2, Failed=3. */
  status: number;
  displayMessage?: string;
  transactionId?: string;
  outputNoteIds?: string[];
  /** Base units, stringified in-page (bigint does not cross the evaluate bridge). */
  amount?: string;
  secondaryAccountId?: string;
  faucetId?: string;
  /**
   * The RELATIVE blocks-until-recall offset chosen on the review page.
   * `undefined` means the send went out as a plain P2ID (the "Never" choice).
   */
  recallBlocks?: number;
}

/**
 * Arm the review page's recall choice for the NEXT send from this page.
 *
 * `blocks` is a relative offset; `null` selects "Never" (no reclaim height → a
 * plain P2ID note the sender can never take back).
 *
 * The value lives on the page's `window` and is read by ReviewTransaction on
 * mount, so it must be armed after the last full page load. `claimAllNotes`
 * reloads the page, so re-arm after any claim.
 */
export async function armRecallBlocks(page: Page, blocks: number | null): Promise<void> {
  await page.evaluate(value => {
    (globalThis as unknown as { __TEST_RECALL_BLOCKS__?: number | null }).__TEST_RECALL_BLOCKS__ = value;
  }, blocks);
}

/**
 * Convert a wall-clock recall window into a blocks offset for the chain this run
 * is actually pointed at.
 *
 * The local stack's block cadence is configurable (`MIDEN_NODE_BLOCK_INTERVAL`,
 * defaulting to the compose file's `3s`), and the fast-blocks CI leg runs it at
 * `500ms`. A hard-coded block count would therefore mean a 6x shorter window on
 * that leg — short enough that prove + submit + commit can outrun it, turning a
 * healthy wallet into a red "the note was already reclaimable" failure. Deriving
 * the count from the same variable that configures the node keeps the window the
 * same LENGTH on every leg, which is what makes the expiry bounded — not the
 * cadence itself.
 *
 * Throws on an unparseable non-empty value: silently falling back to 3s would
 * mis-size the window on exactly the run whose interval was mistyped.
 */
export function recallBlocksForWindow(windowMs: number): number {
  const raw = (process.env.MIDEN_NODE_BLOCK_INTERVAL ?? '').trim();
  // Empty = the compose file's `${MIDEN_NODE_BLOCK_INTERVAL:-3s}` default.
  const intervalMs = raw === '' ? 3_000 : parseBlockIntervalMs(raw);
  return Math.max(1, Math.ceil(windowMs / intervalMs));
}

function parseBlockIntervalMs(raw: string): number {
  const match = /^(\d+)(ms|s)$/.exec(raw);
  if (!match) {
    throw new Error(
      `recallBlocksForWindow: MIDEN_NODE_BLOCK_INTERVAL=${JSON.stringify(raw)} is not a duration this helper ` +
        `understands (expected e.g. "500ms" or "3s"). Refusing to guess the block cadence — the recall window ` +
        `would be the wrong length and the spec would fail for a reason that has nothing to do with recall.`
    );
  }
  const value = Number(match[1]);
  return match[2] === 's' ? value * 1_000 : value;
}

/**
 * Every row of one `type` in the wallet's Dexie `transactions` store.
 *
 * A pure read of already-persisted rows — syncs nothing, touches no WASM client.
 * Same IndexedDB idiom as `bridge.ts readBridgedSendRows`.
 */
export async function readTransactionRows(page: Page, type: string): Promise<WalletTxRow[]> {
  return page.evaluate(async (wantedType: string) => {
    const idb = (window as unknown as { indexedDB: IDBFactory }).indexedDB;
    const db: IDBDatabase = await new Promise((res, rej) => {
      const r = idb.open('TridentMain');
      r.onsuccess = () => res(r.result);
      r.onerror = () => rej(r.error);
    });
    try {
      if (!db.objectStoreNames.contains('transactions')) return [];
      const all: Array<{
        id?: string;
        type?: string;
        status?: number;
        displayMessage?: string;
        transactionId?: string;
        outputNoteIds?: string[];
        amount?: bigint | number | string;
        secondaryAccountId?: string;
        faucetId?: string;
        extraInputs?: { recallBlocks?: number };
      }> = await new Promise((res, rej) => {
        const r = db.transaction('transactions', 'readonly').objectStore('transactions').getAll();
        r.onsuccess = () => res(r.result);
        r.onerror = () => rej(r.error);
      });
      return all
        .filter(t => t.type === wantedType)
        .map(t => ({
          id: t.id ?? '',
          type: t.type ?? '',
          status: t.status ?? -1,
          displayMessage: t.displayMessage,
          transactionId: t.transactionId,
          outputNoteIds: t.outputNoteIds,
          amount: t.amount === undefined ? undefined : String(t.amount),
          secondaryAccountId: t.secondaryAccountId,
          faucetId: t.faucetId,
          recallBlocks: t.extraInputs?.recallBlocks
        }));
    } finally {
      db.close();
    }
  }, type);
}

export interface WaitForRowOptions {
  /** Row type, e.g. 'send' or 'consume'. */
  type: string;
  /** Extra predicate on top of `status === Completed`. Runs in Node, not in the page. */
  match?: (row: WalletTxRow) => boolean;
  timeoutMs: number;
  /** Named in the timeout message so a failure says WHICH row never landed. */
  what: string;
}

/**
 * Poll until a row of `type` is BOTH Completed and matches `match`, then return it.
 *
 * Postcondition, stated because a wait that returns without one is worthless:
 * the returned row satisfied `status === COMPLETED` and `match` at the moment it
 * was read. It does NOT establish that the note is committed on chain — the send
 * pipeline stamps Completed from the executed transaction, and the recipient
 * seeing the note is the separate, stronger signal. On timeout it throws with
 * every row of that type so the reader can see whether the row is missing,
 * Queued, or Failed.
 */
export async function waitForCompletedRow(page: Page, opts: WaitForRowOptions): Promise<WalletTxRow> {
  const deadline = Date.now() + opts.timeoutMs;
  let rows: WalletTxRow[] = [];
  while (Date.now() < deadline) {
    rows = await readTransactionRows(page, opts.type);
    const hit = rows.find(row => row.status === COMPLETED && (opts.match?.(row) ?? true));
    if (hit) return hit;
    await page.waitForTimeout(2_000);
  }
  const seen = rows
    .map(
      r => `    {status: ${r.status}, amount: ${r.amount}, recallBlocks: ${r.recallBlocks}, msg: ${r.displayMessage}}`
    )
    .join('\n');
  throw new Error(
    `waitForCompletedRow(${opts.type}) timed out after ${opts.timeoutMs}ms waiting for ${opts.what}.\n` +
      `  ${rows.length} '${opts.type}' row(s) present:\n${seen || '    (none)'}\n` +
      `  (status 0=Queued 1=Generating 2=Completed 3=Failed — a Failed row means the transaction was ` +
      `rejected, not that this wait was too short)`
  );
}
