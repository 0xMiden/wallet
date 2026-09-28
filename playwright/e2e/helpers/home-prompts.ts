/**
 * The Home screen's pending-transfer prompt, checked the way a user meets it.
 *
 * A non-native token is never auto-accepted, so this prompt is the only notice a user gets that
 * one is waiting. `toBeVisible` alone would not prove they got it: PromptCarousel keeps every
 * eligible prompt mounted as a slide in one translated flex track inside `overflow-hidden`, so a
 * slide that has scrolled out of view still has a box and still passes. This measures the fraction
 * of the card that lies inside the window instead: reorder the prompts, or make an earlier one
 * eligible, and it fails rather than reporting a notice nobody could see.
 */
import { expect, type Page } from '@playwright/test';

/** `WALLET_PROMPT_TEST_IDS[WalletPromptType.PendingNotes]` in src/app/templates/HomePrompts.tsx. */
export const PENDING_PROMPT_TESTID = 'pending-notes-prompt';

/**
 * `pendingNotesPromptTitle` in public/_locales/en/en.json, asserted as rendered text on purpose: a
 * renamed i18n key renders the key itself while the card stays present and on screen.
 */
const PENDING_PROMPT_TITLE = 'You have transfers to accept';

/** Fraction of the card's own width that must lie inside the window. */
const MIN_ON_SCREEN_FRACTION = 0.99;

export interface HomeWallet {
  page: Page;
  navigateHome(): Promise<void>;
}

export async function expectPendingPromptOnScreen(wallet: HomeWallet, timeoutMs: number = 45_000): Promise<void> {
  await wallet.navigateHome();

  const prompt = wallet.page.getByTestId(PENDING_PROMPT_TESTID);
  await expect(
    prompt,
    'the Home screen must show the pending-transfer prompt, with its own title, while a transfer waits'
  ).toContainText(PENDING_PROMPT_TITLE, { timeout: timeoutMs });

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
          'the pending-transfer prompt must be the carousel slide actually on screen, not a mounted slide ' +
          'translated out of view. A value near 0 means the user was never shown the notice.'
      }
    )
    .toBeGreaterThan(MIN_ON_SCREEN_FRACTION);
}
