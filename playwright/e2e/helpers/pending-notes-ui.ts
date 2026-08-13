/**
 * DOM-level helpers for the pending-notes screen: what the wallet RENDERS for a
 * received token, as opposed to what its store holds.
 *
 * WHAT THESE ADD OVER THE STORE-LEVEL HELPERS
 *
 * Every other claim assertion in this suite reads the Zustand store or
 * `chrome.storage.local` (helpers/balance-truth.ts). Those are not blind to the
 * token's IDENTITY: `pendingNoteTotal` resolves a note's symbol from the same
 * two sources PendingTab renders from (`note.metadata`, then
 * `assetsMetadata[faucetId]`), so a wallet that degraded the faucet to `Unknown`
 * already fails `waitForPendingNoteTotal` before any of this runs.
 *
 * What they cannot see is the FORMATTING the user reads:
 *   - the decimals the row resolved — `metadata?.decimals ?? 6` in both
 *     PendingTab rows, so an 8-decimal token whose metadata lost its `decimals`
 *     renders a number two orders of magnitude off while the store stays right;
 *   - thousands grouping on the summary row (`groupNumber`) and its deliberate
 *     absence on the per-note rows;
 *   - trailing-zero trimming (`formatBigInt`);
 *   - the per-note breakdown at all — the store total cannot distinguish two
 *     notes of the right sizes from one row printing the sum twice.
 *
 * WHY THEY MUST RUN BEFORE `claimAllNotes` / `claimNotesByGroup`
 *
 * Both of those go through `reloadAndPreparePending()` → `injectClaimableMetadata()`,
 * the harness writing `symbol: 'TST', decimals: 8` into the store for any faucet
 * the wallet did not resolve on its own. Asserting a rendered "TST" at 8
 * decimals after the harness wrote exactly that would be circular. Called first,
 * these helpers grade the wallet's own metadata resolution.
 */
import { expect, type Page } from '@playwright/test';

import type { ChromeWalletPageApi } from './wallet-page';

/** Home-screen prompt that tells the user notes are waiting (HomePrompts / PromptCard). */
export const PENDING_NOTES_PROMPT_TESTID = 'pending-notes-prompt';

/**
 * `pendingNotesPromptTitle` from public/_locales/en/en.json, asserted as
 * rendered text on purpose: a broken/renamed i18n key renders the key itself,
 * and the card would still be present, still be on screen, and still navigate.
 */
const PENDING_NOTES_PROMPT_TITLE = 'You have Pending Notes';

/** Fraction of the card's own width that must lie inside the window. */
const MIN_ON_SCREEN_FRACTION = 0.99;

/**
 * Land on /pending-notes the way a user does: from the Home prompt.
 *
 * The prompt is the product's pending indicator. A non-native token is never
 * auto-consumed — auto-consume is native-only in both implementations
 * (Explore.tsx gates on `note.faucetId === midenFaucetId`; the service worker's
 * sync-manager skips anything but the native faucet), regardless of the
 * auto-consume setting — so this card is the only thing that tells someone
 * tokens are sitting unclaimed.
 *
 * `toBeVisible` alone would NOT prove the user was told. PromptCarousel keeps
 * EVERY eligible prompt mounted as a slide in one translated flex track inside
 * `overflow-hidden` (PromptCarousel.tsx), and a fresh wallet also has the Faucet
 * and VerifySeedPhrase prompts eligible — so a clipped, off-screen slide still
 * has a non-empty box and satisfies `toBeVisible`. It only reads as "on screen"
 * because PendingNotes happens to be first in `WALLET_PROMPT_ORDER`. So this
 * asserts the rendered title AND that the card's box actually lies inside the
 * window: reorder the prompts, or make an earlier one eligible, and the second
 * check fails instead of quietly reporting a notice nobody could see.
 */
export async function openPendingNotesFromHomePrompt(
  wallet: ChromeWalletPageApi,
  opts: { timeoutMs?: number } = {}
): Promise<void> {
  const timeoutMs = opts.timeoutMs ?? 45_000;
  await wallet.navigateHome();

  const prompt = wallet.page.getByTestId(PENDING_NOTES_PROMPT_TESTID);
  await expect(
    prompt,
    'the Home screen must surface the pending-notes prompt, with its own title, while unconsumed notes ' +
      'exist — without it a non-native token that never auto-consumes is invisible to the user'
  ).toContainText(PENDING_NOTES_PROMPT_TITLE, { timeout: timeoutMs });

  await expect
    .poll(
      () =>
        prompt.evaluate(el => {
          const rect = el.getBoundingClientRect();
          if (rect.width === 0) return 0;
          const viewportWidth = el.ownerDocument.defaultView?.innerWidth ?? 0;
          const onScreen = Math.min(rect.right, viewportWidth) - Math.max(rect.left, 0);
          return Math.max(0, onScreen) / rect.width;
        }),
      {
        timeout: 10_000,
        message:
          'the pending-notes prompt must be the carousel slide actually on screen. PromptCarousel keeps ' +
          'every eligible prompt mounted in a track it translates inside overflow-hidden, so a card that ' +
          'has scrolled out of view still passes toBeVisible — this measures the fraction of the card ' +
          'inside the window instead. A value near 0 means the user was never shown the notice.'
      }
    )
    .toBeGreaterThan(MIN_ON_SCREEN_FRACTION);

  await wallet.page.getByTestId(`${PENDING_NOTES_PROMPT_TESTID}-action`).click({ timeout: 10_000 });

  await expect
    .poll(() => wallet.page.url(), {
      timeout: 10_000,
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
  const timeoutMs = opts.timeoutMs ?? 20_000;
  const row = page.getByTestId('pending-asset-row').first();
  await expect(row, 'a pending-asset summary row must be rendered before it can be opened').toBeVisible({
    timeout: timeoutMs
  });
  await row.click({ timeout: 10_000 });
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
    timeout: opts.timeoutMs ?? 20_000
  });
  const texts = await rows.allTextContents();
  return texts.map(t => t.trim()).sort();
}
