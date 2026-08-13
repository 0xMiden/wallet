/**
 * DOM-level helpers for the MANUAL claim journey (non-native tokens).
 *
 * WHY THIS EXISTS, AND WHY IT DOES NOT REUSE `WalletPage.claimAllNotes` /
 * `claimNotesByGroup`
 *
 * Every existing claim assertion in this suite reads the Zustand store or
 * `chrome.storage.local` (see helpers/balance-truth.ts). That proves the money
 * moved, but it says nothing about what the USER was shown: a metadata
 * regression that renders the pending row as `UNKNOWN` (the fallback at
 * PendingTab.tsx `metadata?.symbol || 'UNKNOWN'`) leaves every current spec
 * green. The helpers here read the RENDERED text instead, so the token identity
 * the user sees is itself under test.
 *
 * That only means something if the harness has not written the metadata it then
 * asserts on. `WalletPage.claimAllNotes` / `claimNotesByGroup` both go through
 * `reloadAndPreparePending()`, which calls `injectClaimableMetadata()` — the
 * harness writing `symbol: 'TST'` into the store for any faucet the wallet did
 * not resolve on its own. Asserting "TST" after injecting "TST" is circular, so
 * none of these helpers reload-and-inject: they drive the same product buttons
 * (`pending-asset-row` → `claim-group-button`) directly against whatever the
 * wallet itself resolved. If the wallet's own metadata fetch breaks, the notes
 * drop out of the list entirely (`claimable-notes.ts` filters on
 * `n.metadata || assetsMetadata[n.faucetId]`) and these helpers fail loudly —
 * which is the point.
 *
 * NOTE (harness gap, deliberately not worked around here): the injection is
 * still unconditional inside wallet-page.ts, so any spec calling those two
 * methods keeps buying the weaker signal invisibly. Gating it behind an
 * explicit opt-in is a wallet-page.ts change and is reported separately.
 */
import { expect, type Page } from '@playwright/test';

import { fromBaseUnits, pendingNoteTotal, vaultBalance } from './balance-truth';
import type { ChromeWalletPageApi } from './wallet-page';

/** Home-screen prompt that tells the user notes are waiting (HomePrompts / PromptCard). */
export const PENDING_NOTES_PROMPT_TESTID = 'prompt-card-pendingNotes';

/**
 * Land on /pending-notes the way a user does: from the Home prompt.
 *
 * The prompt IS the product's pending indicator — it is how someone who never
 * opens the receive screen learns a non-native token is sitting unclaimed (they
 * are not auto-consumed; see the spec header). Asserting it is visible before
 * clicking it is what makes this a coverage of the indicator and not just a
 * fancy way of typing a URL.
 */
export async function openPendingNotesFromHomePrompt(
  wallet: ChromeWalletPageApi,
  opts: { timeoutMs?: number } = {}
): Promise<void> {
  const timeoutMs = opts.timeoutMs ?? 120_000;
  await wallet.navigateHome();

  const prompt = wallet.page.getByTestId(PENDING_NOTES_PROMPT_TESTID);
  await expect(
    prompt,
    'the Home screen must surface the pending-notes prompt while unconsumed notes exist — ' +
      'without it a non-native token that never auto-consumes is invisible to the user'
  ).toBeVisible({ timeout: timeoutMs });

  await wallet.page.getByTestId(`${PENDING_NOTES_PROMPT_TESTID}-action`).click({ timeout: 15_000 });

  await expect
    .poll(() => wallet.page.url(), {
      timeout: 15_000,
      message: "the pending-notes prompt's CTA must navigate to /pending-notes"
    })
    .toContain('#/pending-notes');
}

/**
 * Open the single per-faucet summary row into its asset-detail view.
 *
 * Post-condition is the group claim affordance being on screen: without it the
 * caller would go on to assert per-note rows that never rendered, and a missing
 * row set reads the same as an empty one.
 */
export async function openAssetGroupDetail(page: Page, opts: { timeoutMs?: number } = {}): Promise<void> {
  const timeoutMs = opts.timeoutMs ?? 60_000;
  const row = page.getByTestId('pending-asset-row').first();
  await expect(row, 'a pending-asset summary row must be rendered before it can be opened').toBeVisible({
    timeout: timeoutMs
  });
  await row.click({ timeout: 15_000 });
  await expect(
    page.getByTestId('claim-group-button'),
    'opening a pending asset row must show the asset detail view with its group-claim button'
  ).toBeVisible({ timeout: timeoutMs });
}

/**
 * The rendered `<amount><symbol>` text of every per-note row in the open asset
 * detail view, sorted so the assertion does not depend on note discovery order.
 *
 * `expectedCount` is required and asserted first: reading "all rows" out of a
 * list that has rendered none returns `[]`, which would otherwise sail past a
 * comparison the caller wrote to be strict.
 */
export async function readDetailNoteAmounts(
  page: Page,
  expectedCount: number,
  opts: { timeoutMs?: number } = {}
): Promise<string[]> {
  const rows = page.getByTestId('detail-note-amount');
  await expect(rows, `the asset detail view must render ${expectedCount} per-note row(s)`).toHaveCount(expectedCount, {
    timeout: opts.timeoutMs ?? 60_000
  });
  const texts = await rows.allTextContents();
  return texts.map(t => t.trim()).sort();
}

/**
 * Click the group "Claim N/M" button and prove the click actually QUEUED a
 * consume.
 *
 * `useClaimNotes.claimNotesBatch` queues one consume transaction for the whole
 * group and then navigates to `/generating-transaction-full/<txId>` — but only
 * when the queue call returned an id. A click that was swallowed (disabled
 * button, notes already flagged `isBeingClaimed`, a queue-time throw that rolls
 * back its Dexie transaction) leaves the app sitting on the detail view. So the
 * navigation is the difference between "clicked" and "claimed", and waiting for
 * it here attributes that failure to the click instead of to the balance
 * assertion minutes later.
 */
export async function claimGroupAndExpectQueued(
  wallet: ChromeWalletPageApi,
  opts: { timeoutMs?: number } = {}
): Promise<void> {
  const timeoutMs = opts.timeoutMs ?? 60_000;
  const button = wallet.page.getByTestId('claim-group-button');
  await expect(button, 'the group-claim button must be enabled while the group has unclaimed notes').toBeEnabled({
    timeout: timeoutMs
  });
  await button.click({ timeout: 15_000 });

  await expect
    .poll(() => wallet.page.url(), {
      timeout: timeoutMs,
      message:
        'clicking "Claim all" on the asset detail view must queue a consume transaction and open the ' +
        'transaction-progress screen; staying on /pending-notes means nothing was queued'
    })
    .toContain('generating-transaction');
}

/**
 * Wait for a queued claim to actually settle: the vault holds exactly
 * `before.vault + amountBaseUnits` of `symbol` AND the unconsumed total for that
 * symbol has dropped by at least the same amount.
 *
 * Why not `assertClaimed` (helpers/assertions.ts): after the claim the wallet
 * sits on the transaction-progress screen, and NOTHING mounted there refreshes
 * the store's `balances` projection — that write only happens inside the
 * home/token screens' poll. `assertClaimed` would therefore poll a frozen number
 * and time out on a consume that landed on chain (the same trap already fixed
 * once on the iOS claim wait). This drives the wallet's own sync + fetchBalances
 * on every poll instead of navigating away, which would stop the page from
 * driving anything at all.
 *
 * Throws with both readings, the expectation, and the queue state — a wait that
 * returned quietly here would leave the caller asserting nothing.
 */
export async function waitForClaimSettled(
  wallet: ChromeWalletPageApi,
  params: {
    symbol: string;
    decimals: number;
    before: { vault: bigint; pending: bigint };
    amountBaseUnits: bigint;
    timeoutMs?: number;
  }
): Promise<void> {
  const { symbol, decimals, before, amountBaseUnits } = params;
  const timeoutMs = params.timeoutMs ?? 240_000;
  const expectedVault = before.vault + amountBaseUnits;
  const maxPending = before.pending - amountBaseUnits;

  const deadline = Date.now() + timeoutMs;
  let vault = -1n;
  let pending = -1n;
  while (Date.now() < deadline) {
    await wallet.triggerSync();
    await wallet.refreshBalances();
    vault = await vaultBalance(wallet.page, symbol);
    pending = await pendingNoteTotal(wallet.page, symbol);
    if (vault === expectedVault && pending <= maxPending) return;
    // Poll spacing only — every reading above is a fresh product-driven sync.
    await wallet.page.waitForTimeout(2_000);
  }

  const fmt = (v: bigint) => `${fromBaseUnits(v, decimals)} ${symbol} (${v} base units)`;
  const queue = await wallet.quickBalanceSnapshot().catch(() => undefined);
  throw new Error(
    `waitForClaimSettled(${symbol}) timed out after ${timeoutMs}ms.\n` +
      `  expected vault:  ${fmt(expectedVault)}\n` +
      `  actual vault:    ${fmt(vault)}\n` +
      `  expected unconsumed at most: ${fmt(maxPending)}\n` +
      `  actual unconsumed:           ${fmt(pending)}\n` +
      `  pending transactions: ${queue?.pendingTxCount ?? 'unreadable'} ` +
      `(latest ${queue?.latestTxId ?? 'none'})\n` +
      `  A vault that never moved while the notes stayed unconsumed means the queued consume never\n` +
      `  committed — not that the projection is slow: every poll above forced a sync and a balance refresh.`
  );
}
